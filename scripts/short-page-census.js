#!/usr/bin/env node

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  MIN_PAGE_TEXT_LENGTH,
  PAGE_TOO_SHORT_ERROR,
  readBodyWithin,
  withMinimumLength,
} from "./verify-freshness.js";
import { priceSignals } from "./change-gate.js";
import { classifySource, sourceCheckRecord } from "./vendor-naming.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const INDEX_PATH =
  process.env.AGENTDEALS_INDEX_PATH || resolve(__dirname, "..", "data", "index.json");
const CONCURRENCY = 12;
const FETCH_TIMEOUT_MS = 20_000;
const HARD_CEILING = 64_000_000;
const ABSENCE = new Set(["states_no_terms", "does_not_name_vendor"]);
const OLD_FLOOR = 50;
const CANDIDATE_FLOORS = [50, 100, 200, 500, 600, 1_000, 2_000];

function arg(name, fallback = null) {
  const at = process.argv.indexOf(name);
  return at !== -1 ? process.argv[at + 1] : fallback;
}

function stripHtml(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

async function fetchUnfloored(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: "GET",
      signal: controller.signal,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (compatible; AgentDeals-Verify/1.0; +https://github.com/robhunter/agentdeals)",
        Accept: "text/html,application/xhtml+xml",
      },
      redirect: "follow",
    });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    const body = await readBodyWithin(res, HARD_CEILING);
    if (body.tooLarge) return { ok: false, error: `page too large: ${body.bytes} bytes` };
    const text = stripHtml(body.html);
    return { ok: true, text, bytes: Buffer.byteLength(body.html) };
  } catch (err) {
    return { ok: false, error: err.name === "AbortError" ? "timeout" : err.message };
  } finally {
    clearTimeout(timeout);
  }
}

async function mapWithConcurrency(items, limit, fn) {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      await fn(items[i]);
    }
  });
  await Promise.all(workers);
}

function outcomeAt(offer, page, floor) {
  const floored = withMinimumLength(page, floor);
  const signals = floored.ok ? priceSignals(floored.text) : [];
  return classifySource(offer, floored, signals).outcome;
}

function bodyWasRead(page) {
  return page.ok || page.error === PAGE_TOO_SHORT_ERROR;
}

const BUCKET_EDGES = [50, 100, 200, 500, 1_000, 2_000, 5_000];

function bucket(chars) {
  if (chars === null) return "no fetch";
  for (const edge of BUCKET_EDGES) {
    if (chars < edge) return `under ${edge}`;
  }
  return "5000 and over";
}

async function main() {
  const out = arg("--out", "/tmp/short-page-census.json");
  const cacheDir = arg("--cache", null);
  const write = process.argv.includes("--write");
  const checked = arg("--checked", new Date().toISOString().slice(0, 10));
  const floor = Number(arg("--floor", String(MIN_PAGE_TEXT_LENGTH)));

  const data = JSON.parse(readFileSync(INDEX_PATH, "utf-8"));
  const all = (data.offers || []).filter((o) => o.url);
  const absence = all.filter((o) => ABSENCE.has(o.source_check?.outcome));
  const confirmed = all.filter((o) => o.source_check?.outcome === "ok");
  const offers = [...absence, ...confirmed];
  const urls = [...new Set(offers.map((o) => o.url))];

  console.error(
    `floor ${floor}; ${absence.length} absence + ${confirmed.length} ok = ${offers.length} offers, ${urls.length} distinct URLs`
  );

  if (cacheDir && !existsSync(cacheDir)) mkdirSync(cacheDir, { recursive: true });
  const cachePath = (url) =>
    join(cacheDir ?? "", `${createHash("sha1").update(url).digest("hex")}.json`);

  let done = 0;
  const pages = new Map();
  await mapWithConcurrency(urls, CONCURRENCY, async (url) => {
    let page;
    if (cacheDir && existsSync(cachePath(url))) {
      page = JSON.parse(readFileSync(cachePath(url), "utf-8"));
    } else {
      page = await fetchUnfloored(url);
      if (cacheDir) writeFileSync(cachePath(url), JSON.stringify(page));
    }
    done++;
    if (done % 100 === 0) console.error(`  ${done}/${urls.length}`);
    pages.set(url, page);
  });

  let restamped = 0;
  let held = 0;
  const rows = offers.map((offer) => {
    const page = pages.get(offer.url) ?? { ok: false, error: "not fetched" };
    const stored = offer.source_check?.outcome ?? null;
    const chars = page.ok ? page.text.length : null;
    const row = {
      vendor: offer.vendor,
      slug: offer.slug ?? null,
      url: offer.url,
      stored,
      fetch_ok: page.ok,
      error: page.ok ? null : page.error,
      chars,
      bytes: page.bytes ?? null,
      outcome_old: outcomeAt(offer, page, OLD_FLOOR),
      outcome_new: outcomeAt(offer, page, floor),
    };
    if (write && ABSENCE.has(stored)) {
      const floored = withMinimumLength(page, floor);
      if (bodyWasRead(floored)) {
        offer.source_check = sourceCheckRecord(
          offer,
          floored,
          floored.ok ? priceSignals(floored.text) : [],
          checked
        );
        restamped++;
      } else {
        held++;
      }
    }
    return row;
  });

  writeFileSync(out, JSON.stringify(rows, null, 1) + "\n");
  if (write) writeFileSync(INDEX_PATH, JSON.stringify(data, null, 2) + "\n");

  const absenceRows = rows.filter((r) => ABSENCE.has(r.stored));
  const okRows = rows.filter((r) => r.stored === "ok");
  const readAbsence = absenceRows.filter((r) => r.fetch_ok);
  const readOk = okRows.filter((r) => r.fetch_ok);

  const counts = new Map();
  for (const r of readAbsence) counts.set(bucket(r.chars), (counts.get(bucket(r.chars)) ?? 0) + 1);

  console.error("");
  console.error(`absence records          ${absenceRows.length}`);
  console.error(`  body read              ${readAbsence.length}`);
  console.error(`  fetch failed           ${absenceRows.length - readAbsence.length}`);
  for (const key of [...BUCKET_EDGES.map((e) => `under ${e}`), "5000 and over"]) {
    console.error(`    ${key.padEnd(16)} ${counts.get(key) ?? 0}`);
  }

  console.error("");
  console.error("floor      absence -> unreadable      ok records lost");
  for (const candidate of CANDIDATE_FLOORS) {
    const moved = readAbsence.filter((r) => r.chars < candidate).length;
    const lost = readOk.filter((r) => r.chars < candidate).length;
    console.error(`${String(candidate).padEnd(10)} ${String(moved).padEnd(24)} ${lost}`);
  }

  const shortestOk = [...readOk].sort((a, b) => a.chars - b.chars).slice(0, 6);
  console.error("");
  console.error("shortest confirmed pages in the catalog");
  for (const r of shortestOk) console.error(`  ${String(r.chars).padStart(6)}  ${r.vendor}  ${r.url}`);

  const movesToUnreadable = readAbsence.filter(
    (r) => r.outcome_new === "unreadable" && r.outcome_old !== "unreadable"
  );
  const standsAtNewFloor = readAbsence.filter((r) => ABSENCE.has(r.outcome_new));
  const nowOk = readAbsence.filter((r) => r.outcome_new === "ok");

  console.error("");
  console.error(`re-read at floor ${floor}`);
  console.error(`  moves to unreadable    ${movesToUnreadable.length}`);
  console.error(`  now reads ok           ${nowOk.length}`);
  console.error(`  absence claim stands   ${standsAtNewFloor.length}`);
  if (write) {
    console.error("");
    console.error(`re-stamped               ${restamped}`);
    console.error(`held on a failed fetch   ${held}`);
  }
  console.error("");
  console.error(`wrote ${out}`);
}

main();
