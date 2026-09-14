#!/usr/bin/env node

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  MIN_PAGE_TEXT_LENGTH,
  pageOnlyARenderingClientCanRead,
  readBodyWithin,
  MAX_PAGE_BYTES,
} from "./verify-freshness.js";
import { renderPageHtml, findRenderer } from "./rendered-page.js";
import { classifySource } from "./vendor-naming.js";
import { priceSignals } from "./change-gate.js";
import { FAILURE_BOT_BLOCK } from "./verification-state.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const CRAWLER_USER_AGENT =
  "Mozilla/5.0 (compatible; AgentDeals-Verify/1.0; +https://github.com/robhunter/agentdeals)";
const MITIGATION_HEADERS = ["cf-mitigated", "x-vercel-mitigated", "cf-ray", "server", "retry-after"];

function quarantinedBotBlocks() {
  const state = JSON.parse(readFileSync(resolve(ROOT, "data", "verification_state.json"), "utf8"));
  return Object.values(state.records)
    .filter((record) => record.quarantined_since && record.failure_category === FAILURE_BOT_BLOCK)
    .sort((a, b) => a.vendor.localeCompare(b.vendor));
}

function offersByUrl() {
  const index = JSON.parse(readFileSync(resolve(ROOT, "data", "index.json"), "utf8"));
  const map = new Map();
  for (const offer of index.offers) if (!map.has(offer.url)) map.set(offer.url, offer);
  return map;
}

async function plainFetch(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  try {
    const res = await fetch(url, {
      method: "GET",
      signal: controller.signal,
      headers: { "User-Agent": CRAWLER_USER_AGENT, Accept: "text/html,application/xhtml+xml" },
      redirect: "follow",
    });
    const headers = {};
    for (const name of MITIGATION_HEADERS) {
      const value = res.headers.get(name);
      if (value) headers[name] = value;
    }
    const body = await readBodyWithin(res, MAX_PAGE_BYTES);
    return { status: res.status, headers, bytes: body.html ? Buffer.byteLength(body.html) : null };
  } catch (err) {
    return { status: null, headers: {}, error: err.name === "AbortError" ? "timeout" : err.message };
  } finally {
    clearTimeout(timeout);
  }
}

async function renderedReading(url, offer) {
  const rendered = await renderPageHtml(url);
  const read = pageOnlyARenderingClientCanRead(
    { ok: false, error: "unread", chars: 0 },
    rendered,
    { minLength: MIN_PAGE_TEXT_LENGTH, finalUrl: url }
  );
  if (!read.ok) {
    return { read: false, chars: read.chars ?? 0, error: read.error, bytes: rendered.html?.length ?? null };
  }
  const grade = offer ? classifySource(offer, read, priceSignals(read.text)) : null;
  return {
    read: true,
    chars: read.text.length,
    bytes: rendered.html.length,
    outcome: grade?.outcome ?? null,
    detail: grade?.detail ?? null,
    opening: read.text.slice(0, 140),
  };
}

async function main() {
  const renderer = findRenderer();
  if (!renderer) {
    console.error("No rendering client on PATH. Set AGENTDEALS_RENDERER to a Chrome or Chromium binary.");
    process.exit(2);
  }
  console.error(`renderer: ${renderer}`);
  const offers = offersByUrl();
  const rows = [];
  for (const record of quarantinedBotBlocks()) {
    const offer = offers.get(record.url) ?? { vendor: record.vendor, url: record.url };
    const fetched = await plainFetch(record.url);
    const row = {
      vendor: record.vendor,
      url: record.url,
      stored_error: record.last_error,
      last_attempt_at: record.last_attempt_at,
      status: fetched.status,
      headers: fetched.headers,
      fetch_error: fetched.error ?? null,
      fetch_bytes: fetched.bytes ?? null,
    };
    if (fetched.status && fetched.status >= 200 && fetched.status < 400) {
      row.answers_a_plain_fetch = true;
    } else {
      row.answers_a_plain_fetch = false;
      row.rendered = await renderedReading(record.url, offer);
    }
    rows.push(row);
    const verdict = row.answers_a_plain_fetch
      ? `plain ${row.status}`
      : `${row.status ?? row.fetch_error} → rendered ${row.rendered.read ? `READ ${row.rendered.chars} chars, ${row.rendered.outcome}` : `unread (${row.rendered.chars} chars)`}`;
    console.error(`${record.vendor.padEnd(34)} ${verdict}`);
    await new Promise((r) => setTimeout(r, 500));
  }

  const readByRendering = rows.filter((r) => r.rendered?.read);
  const summary = {
    generated_at: new Date().toISOString(),
    urls: rows.length,
    answer_a_plain_fetch: rows.filter((r) => r.answers_a_plain_fetch).length,
    read_by_rendering: readByRendering.length,
    unread_after_rendering: rows.filter((r) => r.rendered && !r.rendered.read).length,
    read_and_graded_ok: readByRendering.filter((r) => r.rendered.outcome === "ok").length,
    rows,
  };
  mkdirSync(resolve(ROOT, "artifacts"), { recursive: true });
  const out = resolve(ROOT, "artifacts", "census-1651-challenge-pages.json");
  writeFileSync(out, `${JSON.stringify(summary, null, 2)}\n`);
  console.error("");
  console.error(
    `${summary.urls} urls | ${summary.answer_a_plain_fetch} answer a plain fetch | ${summary.read_by_rendering} read by rendering | ${summary.unread_after_rendering} still unread | ${summary.read_and_graded_ok} grade ok`
  );
  console.error(out);
}

await main();
