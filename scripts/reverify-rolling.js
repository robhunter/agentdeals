#!/usr/bin/env node

/**
 * Rolling data re-verification.
 *
 * Picks the N oldest-verified entries (regardless of staleness threshold),
 * checks them, and stamps verifiedDate across a 3-day window so future
 * re-verifications stay smoothly distributed instead of cliffing on a
 * single date.
 *
 * Usage:
 *   npm run reverify:rolling                    # 100 oldest, URL-only
 *   npm run reverify:rolling -- --limit 50      # 50 oldest
 *   npm run reverify:rolling -- --ai            # read the vendor's terms and detect changes
 *   npm run reverify:rolling -- --dry-run       # report only
 */

import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { reverifyBatch } from "./reverify.js";
import { fetchPageText, verifyOfferAgainstPage, createVerifierClient, VERIFIER_MODEL } from "./verify-freshness.js";
import { buildChangeEntry, appendChangeEntries } from "./change-log.js";
import {
  gateCandidates,
  confirmDescribesChange,
  rejectionCounts,
  priceSignals,
  REJECT_NO_PRICE_SIGNAL,
  REJECT_PAGE_NOT_ABOUT_VENDOR,
  REJECT_UNQUANTIFIED_LIMIT,
} from "./change-gate.js";
import { sourceCheckRecord, SOURCE_CHECK_OK, SOURCE_CHECK_OUTCOMES } from "./vendor-naming.js";
import { isoDay } from "./change-log.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const INDEX_PATH =
  process.env.AGENTDEALS_INDEX_PATH || resolve(__dirname, "..", "data", "index.json");
const DEFAULT_LIMIT = 100;
const URL_CONCURRENCY = 10;
const AI_RATE_LIMIT_MS = 500;
const STAGGER_WINDOW_DAYS = 3;

export function lastAttemptedDate(offer) {
  const check = offer?.source_check;
  const held = check && check.outcome !== SOURCE_CHECK_OK ? check.checked : null;
  const dates = [offer?.verifiedDate, held].filter(Boolean);
  return dates.length > 0 ? dates.sort().pop() : null;
}

export function pickOldestEntries(offers, limit, now = new Date()) {
  const entries = offers.map((offer, index) => {
    const attempted = lastAttemptedDate(offer);
    const ts = attempted ? new Date(attempted).getTime() : 0; // never looked sorts oldest
    return { index, offer, ts };
  });
  entries.sort((a, b) => a.ts - b.ts);
  const picked = entries.slice(0, limit).map(({ index, offer }) => ({ index, offer }));
  const remaining = entries.slice(limit);
  const oldestRemaining = remaining.length > 0
    ? (remaining[0].offer.verifiedDate || null)
    : null;
  return { picked, oldestRemaining };
}

export function staggeredDate(now, rand = Math.random) {
  const offsetDays = Math.floor(rand() * STAGGER_WINDOW_DAYS);
  const d = new Date(now.getTime() - offsetDays * 24 * 60 * 60 * 1000);
  return d.toISOString().split("T")[0];
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function applySourceCheck(offer, index, page, data, dryRun, now, counters) {
  const signals = page?.ok ? priceSignals(page.text).length : 0;
  const check = sourceCheckRecord(offer, page, signals, isoDay(now));
  counters.set(check.outcome, (counters.get(check.outcome) ?? 0) + 1);
  if (!dryRun) data.offers[index].source_check = check;
  if (check.outcome !== SOURCE_CHECK_OK) {
    console.log(`  ⊘ ${offer.vendor} — verifiedDate held at ${offer.verifiedDate}: ${check.detail} (${offer.url})`);
  }
  return check.outcome === SOURCE_CHECK_OK;
}

function emptySourceCounters() {
  return new Map(SOURCE_CHECK_OUTCOMES.map((outcome) => [outcome, 0]));
}

export async function runUrlMode(picked, data, dryRun, now, options = {}) {
  const batchFn = options.batchFn ?? reverifyBatch;
  const fetchFn = options.fetchFn ?? fetchPageText;
  let verified = 0;
  let flagged = 0;
  const sourceChecks = emptySourceCounters();
  for (let i = 0; i < picked.length; i += URL_CONCURRENCY) {
    const batch = picked.slice(i, i + URL_CONCURRENCY);
    const results = await batchFn(batch);
    const byIndex = new Map(batch.map((entry) => [entry.index, entry.offer]));
    for (const v of results.verified) {
      const offer = byIndex.get(v.index);
      const page = await fetchFn(offer.url);
      if (!applySourceCheck(offer, v.index, page, data, dryRun, now, sourceChecks)) continue;
      if (!dryRun) {
        data.offers[v.index].verifiedDate = staggeredDate(now);
      }
      verified++;
    }
    for (const f of results.flagged) {
      console.log(`  ⚠ ${f.vendor} — ${f.error} (${f.url})`);
      flagged++;
    }
  }
  return { verified, flagged, changed: 0, changes: [], recorded: [], suppressed: [], unclassified: [], rejected: [], unchecked: [], sourceChecks };
}

export async function runAiMode(picked, data, dryRun, now, options = {}) {
  const fetchFn = options.fetchFn ?? fetchPageText;
  const appendFn = options.appendFn ?? appendChangeEntries;
  const rateLimitMs = options.rateLimitMs ?? AI_RATE_LIMIT_MS;
  let verifyFn = options.verifyFn;
  let confirmFn = options.confirmFn ?? null;
  if (!verifyFn) {
    const client = createVerifierClient();
    verifyFn = (offer, pageText) => verifyOfferAgainstPage(client, offer, pageText);
    if (!confirmFn) confirmFn = (entry) => confirmDescribesChange(client, entry);
  }

  let verified = 0;
  let flagged = 0;
  let changed = 0;
  const changes = [];
  const unclassified = [];
  const pageTexts = new Map();
  const sourceChecks = emptySourceCounters();

  for (const entry of picked) {
    const { offer, index } = entry;
    const page = await fetchFn(offer.url);
    const sourceOk = applySourceCheck(offer, index, page, data, dryRun, now, sourceChecks);
    if (!page.ok) {
      console.log(`  ⚠ ${offer.vendor} — ${page.error} (${offer.url})`);
      flagged++;
      await sleep(rateLimitMs);
      continue;
    }
    let result;
    try {
      result = await verifyFn(offer, page.text);
    } catch (err) {
      console.log(`  ⚠ ${offer.vendor} — AI error: ${err.message}`);
      flagged++;
      await sleep(rateLimitMs);
      continue;
    }
    if (result.status === "confirmed") {
      if (!sourceOk) {
        await sleep(rateLimitMs);
        continue;
      }
      if (!dryRun) {
        data.offers[index].verifiedDate = staggeredDate(now);
      }
      verified++;
    } else if (result.status === "changed") {
      changed++;
      const { entry: change, missing } = buildChangeEntry(offer, result, { now });
      if (change) {
        changes.push(change);
        pageTexts.set(change, page.text);
        console.log(`  ⚠ ${offer.vendor} (${offer.category}, ${change.change_type}): ${change.summary}`);
      } else {
        unclassified.push({ vendor: offer.vendor, url: offer.url, missing, summary: result.summary });
        console.log(
          `  ⚠ ${offer.vendor} — change detected but not recordable, missing ${missing.join(", ")}: ${result.summary || "no detail"}`
        );
      }
    } else {
      flagged++;
      console.log(`  ⚠ ${offer.vendor} — unclear: ${result.summary || "no detail"}`);
    }
    await sleep(rateLimitMs);
  }

  const { accepted, rejected, unchecked } = await gateCandidates(changes, {
    confirmFn,
    pageTextFor: (candidate) => pageTexts.get(candidate),
  });
  for (const { candidate, reason, detail } of rejected) {
    console.log(`  ✗ ${candidate.vendor} (${candidate.change_type}) describes no change [${reason}]: ${detail}`);
  }
  for (const { candidate, error } of unchecked) {
    console.log(`  ? ${candidate.vendor} (${candidate.change_type}) recorded without a second opinion: ${error}`);
  }

  const { appended, suppressed } = appendFn(accepted, {
    dryRun,
    windowDays: options.windowDays,
    path: options.changesPath,
  });
  for (const { candidate, reason } of suppressed) {
    console.log(`  – ${candidate.vendor} (${candidate.change_type}) not recorded: ${reason}`);
  }

  return { verified, flagged, changed, changes, recorded: appended, suppressed, unclassified, rejected, unchecked, sourceChecks };
}

export function repickWindowDays(total, batchSize) {
  if (!batchSize || batchSize < 1) return 1;
  return Math.max(1, Math.ceil(total / batchSize));
}

export function summaryLines(result, { useAi, checked, oldestRemaining, total }) {
  const lines = ["", "── Summary ──", `Checked: ${checked}`, `Verified (date bumped): ${result.verified}`];
  if (useAi) {
    lines.push(`Changed (PM review needed): ${result.changed}`);
    const refusals = rejectionCounts(result.rejected ?? []);
    lines.push(`Rejected (no change described): ${(result.rejected ?? []).length}`);
    lines.push(`  of which the page carried no pricing: ${refusals.get(REJECT_NO_PRICE_SIGNAL) ?? 0}`);
    lines.push(`Rejected (page does not name the vendor): ${refusals.get(REJECT_PAGE_NOT_ABOUT_VENDOR) ?? 0}`);
    lines.push(`  of which claimed a limit quantified on one side only: ${refusals.get(REJECT_UNQUANTIFIED_LIMIT) ?? 0}`);
    lines.push(`Recorded without a second opinion: ${(result.unchecked ?? []).length}`);
    lines.push(`Recorded to data/deal_changes.json: ${result.recorded.length}`);
    lines.push(`Already recorded, not written again: ${result.suppressed.length}`);
    lines.push(`Detected but not recordable: ${result.unclassified.length}`);
  } else {
    lines.push("Change detection: not run. URL mode compares nothing and cannot report a change.");
  }
  const sourceChecks = result.sourceChecks ?? new Map();
  for (const outcome of SOURCE_CHECK_OUTCOMES) {
    if (outcome === SOURCE_CHECK_OK) continue;
    lines.push(`Held back (source ${outcome}): ${sourceChecks.get(outcome) ?? 0}`);
  }
  lines.push(`Flagged (URL/AI failure): ${result.flagged}`);
  lines.push(`Next in queue, last verified: ${oldestRemaining ?? "n/a"}`);
  lines.push(`Total entries: ${total}`);
  return lines;
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const useAi = args.includes("--ai");

  const limitIdx = args.indexOf("--limit");
  const limit = limitIdx !== -1
    ? parseInt(args[limitIdx + 1], 10)
    : DEFAULT_LIMIT;

  if (isNaN(limit) || limit < 1) {
    console.error(`Invalid limit: ${args[limitIdx + 1]}. Must be a positive integer.`);
    process.exit(2);
  }

  let data;
  try {
    data = JSON.parse(readFileSync(INDEX_PATH, "utf-8"));
  } catch (err) {
    console.error(`Failed to read index: ${err.message}`);
    process.exit(2);
  }

  const offers = data.offers || [];
  const now = new Date();
  const { picked, oldestRemaining } = pickOldestEntries(offers, limit, now);

  console.log(
    `Rolling re-verification — ${picked.length} oldest entries` +
      (useAi ? ` (${VERIFIER_MODEL})` : " (URL-only)") +
      (dryRun ? " (dry-run)" : "")
  );
  console.log("");

  if (picked.length === 0) {
    console.log("No entries to process.");
    process.exit(0);
  }

  const result = useAi
    ? await runAiMode(picked, data, dryRun, now, {
        windowDays: repickWindowDays(offers.length, picked.length),
      })
    : await runUrlMode(picked, data, dryRun, now);

  const sourceChecksWritten = [...(result.sourceChecks ?? new Map()).values()].reduce((a, b) => a + b, 0);
  if (!dryRun && (result.verified > 0 || sourceChecksWritten > 0)) {
    writeFileSync(INDEX_PATH, JSON.stringify(data, null, 2) + "\n");
  }

  for (const line of summaryLines(result, { useAi, checked: picked.length, oldestRemaining, total: offers.length })) {
    console.log(line);
  }

  process.exit(0);
}

const isMainModule =
  process.argv[1] &&
  resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMainModule) {
  main().catch((err) => {
    console.error(`Fatal error: ${err.message}`);
    process.exit(1);
  });
}
