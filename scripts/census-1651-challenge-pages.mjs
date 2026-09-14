#!/usr/bin/env node

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { fetchPageText, challengeRendersThisRun } from "./verify-freshness.js";
import { renderPageHtml, findRenderer, READ_BY_RENDERING } from "./rendered-page.js";
import { classifySource } from "./vendor-naming.js";
import { priceSignals } from "./change-gate.js";
import { FAILURE_BOT_BLOCK, classifyFetchError } from "./verification-state.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

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
    const rendersAsked = [];
    const page = await fetchPageText(record.url, {
      render: (url) => {
        rendersAsked.push(url);
        return renderPageHtml(url);
      },
    });
    const grade = classifySource(offer, page, page.ok ? priceSignals(page.text) : []);
    const row = {
      vendor: record.vendor,
      url: record.url,
      stored_error: record.last_error,
      last_attempt_at: record.last_attempt_at,
      rendered: rendersAsked.length > 0,
      read: page.ok,
      read_by_rendering: page.read === READ_BY_RENDERING,
      status_before_rendering: page.status_before_rendering ?? null,
      chars: page.ok ? page.text.length : 0,
      error: page.ok ? null : page.error,
      failure_category: page.ok ? null : classifyFetchError(page.error),
      outcome: grade.outcome,
      detail: grade.detail,
      opening: page.ok ? page.text.slice(0, 120) : null,
    };
    rows.push(row);
    console.error(
      `${record.vendor.padEnd(34)} ${row.read ? `read ${row.chars} chars` : row.error}` +
        ` | rendered: ${row.rendered} | ${row.outcome}`
    );
    await new Promise((r) => setTimeout(r, 500));
  }

  const readWithoutARender = rows.filter((r) => r.read && !r.rendered);
  const readBehindAChallenge = rows.filter((r) => r.read && r.status_before_rendering !== null);
  const readByRendering = rows.filter((r) => r.read && r.read_by_rendering);
  const summary = {
    generated_at: new Date().toISOString(),
    urls: rows.length,
    read_without_a_render: readWithoutARender.length,
    read_behind_a_challenge: readBehindAChallenge.length,
    read_by_rendering: readByRendering.length,
    unread: rows.filter((r) => !r.read).length,
    still_bot_block: rows.filter((r) => r.failure_category === FAILURE_BOT_BLOCK).length,
    renders_asked: challengeRendersThisRun(),
    graded_ok: rows.filter((r) => r.outcome === "ok").length,
    rows,
  };
  mkdirSync(resolve(ROOT, "artifacts"), { recursive: true });
  const out = resolve(ROOT, "artifacts", "census-1651-challenge-pages.json");
  writeFileSync(out, `${JSON.stringify(summary, null, 2)}\n`);
  console.error("");
  console.error(
    `${summary.urls} urls | ${summary.read_without_a_render} read with no render | ` +
      `${summary.read_behind_a_challenge} read behind a challenge | ` +
      `${summary.read_by_rendering} read by rendering | ${summary.unread} unread | ` +
      `${summary.still_bot_block} still bot_block | ${summary.renders_asked} renders | ${summary.graded_ok} grade ok`
  );
  console.error(out);
}

await main();
