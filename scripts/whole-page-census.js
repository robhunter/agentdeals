#!/usr/bin/env node

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { MAX_PAGE_TEXT_LENGTH, readBodyWithin, withMinimumLength } from "./verify-freshness.js";
import { priceSignals } from "./change-gate.js";
import { pageNamesVendor, classifySource, sourceCheckRecord } from "./vendor-naming.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const INDEX_PATH =
  process.env.AGENTDEALS_INDEX_PATH || resolve(__dirname, "..", "data", "index.json");
const CONCURRENCY = 12;
const FETCH_TIMEOUT_MS = 20_000;
const HARD_CEILING = 64_000_000;

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

async function fetchMeasured(url) {
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
    const bytes = Buffer.byteLength(body.html);
    const text = stripHtml(body.html);
    return withMinimumLength({ ok: true, text, bytes });
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

const ABSENCE = new Set(["states_no_terms", "does_not_name_vendor"]);

async function main() {
  const out = arg("--out", "/tmp/whole-page-census.json");
  const cacheDir = arg("--cache", "/tmp/wholepage-cache");
  const population = arg("--population", "absence");

  const data = JSON.parse(readFileSync(INDEX_PATH, "utf-8"));
  const all = data.offers || [];
  const offers =
    population === "all"
      ? all.filter((o) => o.url)
      : all.filter((o) => o.url && ABSENCE.has(o.source_check?.outcome));

  const urls = [...new Set(offers.map((o) => o.url))];
  console.error(`${offers.length} offers, ${urls.length} distinct URLs (population=${population})`);

  if (!existsSync(cacheDir)) mkdirSync(cacheDir, { recursive: true });
  const cachePath = (url) => join(cacheDir, `${createHash("sha1").update(url).digest("hex")}.json`);

  let done = 0;
  const pages = new Map();
  await mapWithConcurrency(urls, CONCURRENCY, async (url) => {
    let page;
    if (existsSync(cachePath(url))) {
      page = JSON.parse(readFileSync(cachePath(url), "utf-8"));
    } else {
      page = await fetchMeasured(url);
      writeFileSync(cachePath(url), JSON.stringify(page));
    }
    done++;
    if (done % 50 === 0) console.error(`  ${done}/${urls.length}`);
    pages.set(url, page);
  });

  const write = process.argv.includes("--write");
  const checked = arg("--checked", new Date().toISOString().slice(0, 10));
  let restamped = 0;
  let heldOnFailedFetch = 0;

  const rows = offers.map((offer) => {
    const whole = pages.get(offer.url) ?? { ok: false, error: "not fetched" };
    const cut = whole.ok
      ? { ok: true, text: whole.text.slice(0, MAX_PAGE_TEXT_LENGTH) }
      : whole;
    const wholeClass = classifySource(offer, whole, whole.ok ? priceSignals(whole.text) : []);
    const cutClass = classifySource(offer, cut, cut.ok ? priceSignals(cut.text) : []);
    const firstSignal = whole.ok
      ? (() => {
          const sigs = priceSignals(whole.text);
          if (sigs.length === 0) return null;
          const at = whole.text.indexOf(sigs[0]);
          return { signal: sigs[0], at: at < 0 ? null : at };
        })()
      : null;

    const storedOutcome = offer.source_check?.outcome ?? null;
    if (write && ABSENCE.has(storedOutcome)) {
      if (whole.ok) {
        offer.source_check = sourceCheckRecord(
          offer,
          whole,
          priceSignals(whole.text),
          checked
        );
        restamped++;
      } else {
        heldOnFailedFetch++;
      }
    }

    return {
      vendor: offer.vendor,
      url: offer.url,
      stored: storedOutcome,
      fetch_ok: whole.ok,
      error: whole.ok ? null : whole.error,
      bytes: whole.bytes ?? null,
      chars: whole.ok ? whole.text.length : null,
      longer_than_cut: whole.ok ? whole.text.length > MAX_PAGE_TEXT_LENGTH : null,
      signals_whole: whole.ok ? priceSignals(whole.text).length : null,
      signals_cut: cut.ok ? priceSignals(cut.text).length : null,
      named_whole: whole.ok ? pageNamesVendor(whole.text, offer.vendor, { url: offer.url }).named : null,
      named_cut: cut.ok ? pageNamesVendor(cut.text, offer.vendor, { url: offer.url }).named : null,
      outcome_whole: wholeClass.outcome,
      outcome_cut: cutClass.outcome,
      first_signal: firstSignal,
    };
  });

  writeFileSync(out, JSON.stringify(rows, null, 1) + "\n");
  if (write) writeFileSync(INDEX_PATH, JSON.stringify(data, null, 2) + "\n");

  const fetched = rows.filter((r) => r.fetch_ok);
  const longer = fetched.filter((r) => r.longer_than_cut);
  const flipped = fetched.filter(
    (r) => ABSENCE.has(r.outcome_cut) && !ABSENCE.has(r.outcome_whole)
  );
  const stands = fetched.filter((r) => ABSENCE.has(r.outcome_whole));
  const storedAbsence = fetched.filter((r) => ABSENCE.has(r.stored));
  const storedAbsenceNowOk = storedAbsence.filter((r) => !ABSENCE.has(r.outcome_whole));
  const cutExplains = storedAbsenceNowOk.filter((r) => ABSENCE.has(r.outcome_cut));
  const storedOk = fetched.filter((r) => r.stored === "ok");
  const storedOkNowAbsence = storedOk.filter((r) => ABSENCE.has(r.outcome_whole));
  const bytes = fetched.map((r) => r.bytes).sort((a, b) => a - b);
  const pct = (p) => bytes[Math.min(bytes.length - 1, Math.floor((bytes.length - 1) * p))];

  console.error("");
  console.error(`population              ${rows.length}`);
  console.error(`fetched                 ${fetched.length}`);
  console.error(`fetch failed            ${rows.length - fetched.length}`);
  console.error(`longer than the cut     ${longer.length}`);
  console.error(`absence claim FALSE     ${flipped.length}`);
  console.error(`absence claim stands    ${stands.length}`);
  console.error("");
  console.error(`stored absence          ${storedAbsence.length}`);
  console.error(`  now reads ok          ${storedAbsenceNowOk.length}`);
  console.error(`    the cut explains    ${cutExplains.length}`);
  console.error(`    the page changed    ${storedAbsenceNowOk.length - cutExplains.length}`);
  console.error(`stored ok               ${storedOk.length}`);
  console.error(`  now reads absence     ${storedOkNowAbsence.length}`);
  if (write) {
    console.error("");
    console.error(`re-stamped              ${restamped}`);
    console.error(`held on a failed fetch  ${heldOnFailedFetch}`);
  }
  console.error("");
  console.error(`bytes  p50 ${pct(0.5)}  p90 ${pct(0.9)}  p99 ${pct(0.99)}  max ${bytes[bytes.length - 1]}`);
  console.error(`chars  max ${Math.max(...fetched.map((r) => r.chars))}`);
  console.error("");
  for (const r of flipped.sort((a, b) => (a.first_signal?.at ?? 0) - (b.first_signal?.at ?? 0))) {
    console.error(
      `  ${r.outcome_cut} -> ${r.outcome_whole}  ${r.vendor}  chars=${r.chars} bytes=${r.bytes} sig@${r.first_signal?.at ?? "-"} "${r.first_signal?.signal ?? ""}"`
    );
  }
  console.error("");
  console.error(`wrote ${out}`);
}

main();
