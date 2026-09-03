#!/usr/bin/env node

import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { reverifyBatch } from "./reverify.js";
import { fetchPageText, verifyOfferAgainstPage, createVerifierClient, VERIFIER_MODEL } from "./verify-freshness.js";
import {
  buildChangeEntry,
  appendChangeEntries,
  SUPPRESSED_SAME_TRANSITION_REGRADED,
} from "./change-log.js";
import {
  gateCandidates,
  confirmDescribesChange,
  rejectionCounts,
  priceSignals,
  REJECT_NO_PRICE_SIGNAL,
  REJECT_PAGE_NOT_ABOUT_VENDOR,
  REJECT_UNQUANTIFIED_LIMIT,
} from "./change-gate.js";
import {
  sourceCheckRecord,
  holdsVerifiedDate,
  READ_FROM_MARKUP,
  SOURCE_CHECK_OK,
  SOURCE_CHECK_OUTCOMES,
} from "./vendor-naming.js";
import { isoDay } from "./change-log.js";
import { recordRefusals, readRefusals, refusalHolds, offerKey } from "./change-refusals.js";
import {
  ATTEMPT_AI_ERROR,
  ATTEMPT_CHANGED,
  ATTEMPT_CONFIRMED,
  ATTEMPT_FETCH_FAILED,
  ATTEMPT_LINK_OK,
  ATTEMPT_SOURCE_UNUSABLE,
  ATTEMPT_UNCLEAR,
  FAILURE_AI_EXTRACTION,
  FAILURE_AI_UNDECIDED,
  FAILURE_CATEGORIES,
  FAILURE_SOURCE_UNUSABLE,
  QUARANTINE_AFTER_FAILURES,
  QUARANTINE_RETRY_DAYS,
  backfillVerificationState,
  classifyFetchError,
  failureCategoryCounts,
  isQuarantined,
  pruneToOffers,
  quarantineRetryDue,
  quarantinedRecords,
  readLinkHealth,
  readVerificationState,
  recordAttempts,
  writeVerificationState,
} from "./verification-state.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const INDEX_PATH =
  process.env.AGENTDEALS_INDEX_PATH || resolve(__dirname, "..", "data", "index.json");
const DEFAULT_LIMIT = 100;
const URL_CONCURRENCY = 10;
const AI_RATE_LIMIT_MS = 500;
const STAGGER_WINDOW_DAYS = 3;
const QUARANTINE_RETRY_SHARE = 0.2;

export function lastAttemptedDate(offer, refusedOn = null, verificationRecord = null) {
  const check = offer?.source_check;
  const held = check && holdsVerifiedDate(check.outcome) ? check.checked : null;
  const dates = [offer?.verifiedDate, held, refusedOn, verificationRecord?.last_attempt_at].filter(Boolean);
  return dates.length > 0 ? dates.sort().pop() : null;
}

export function quarantineRetryBudget(limit) {
  return Math.max(1, Math.round(limit * QUARANTINE_RETRY_SHARE));
}

export function pickOldestEntries(offers, limit, now = new Date(), options = {}) {
  const holds = options.refusalHolds ?? new Map();
  const state = options.verificationState ?? new Map();
  const today = isoDay(now);
  const entries = offers.map((offer, index) => {
    const key = offerKey(offer?.vendor, offer?.url);
    const record = state.get(key) ?? null;
    const attempted = lastAttemptedDate(offer, holds.get(key), record);
    const ts = attempted ? new Date(attempted).getTime() : 0;
    return { index, offer, record, ts };
  });
  const byAge = (a, b) => a.ts - b.ts;
  const active = entries.filter((entry) => !isQuarantined(entry.record)).sort(byAge);
  const dueRetries = entries
    .filter((entry) => isQuarantined(entry.record) && quarantineRetryDue(entry.record, today))
    .sort(byAge);

  const retries = dueRetries.slice(0, Math.min(dueRetries.length, quarantineRetryBudget(limit)));
  const fromActive = active.slice(0, Math.max(0, limit - retries.length));
  const spare = limit - retries.length - fromActive.length;
  const extraRetries = spare > 0 ? dueRetries.slice(retries.length, retries.length + spare) : [];

  const picked = [...retries, ...extraRetries, ...fromActive]
    .sort(byAge)
    .map(({ index, offer }) => ({ index, offer }));
  const remaining = active.slice(fromActive.length);
  const oldestRemaining = remaining.length > 0
    ? (remaining[0].offer.verifiedDate || null)
    : null;
  return {
    picked,
    oldestRemaining,
    retriedFromQuarantine: retries.length + extraRetries.length,
    quarantineDue: dueRetries.length,
    quarantineHeld: entries.filter((entry) => isQuarantined(entry.record)).length,
  };
}

export function repickedNextRun(picked, offers, limit, now, options = {}) {
  const tomorrow = new Date(now.getTime() + 24 * 60 * 60 * 1000);
  const { picked: next } = pickOldestEntries(offers, limit, tomorrow, options);
  const checked = new Set(picked.map(({ offer }) => offerKey(offer?.vendor, offer?.url)));
  return next.filter(({ offer }) => checked.has(offerKey(offer?.vendor, offer?.url))).length;
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
  const signals = page?.ok ? priceSignals(page.text) : [];
  const check = sourceCheckRecord(offer, page, signals, isoDay(now));
  counters.set(check.outcome, (counters.get(check.outcome) ?? 0) + 1);
  if (check.read === READ_FROM_MARKUP) {
    counters.set(READ_FROM_MARKUP, (counters.get(READ_FROM_MARKUP) ?? 0) + 1);
    console.log(`  ⌗ ${offer.vendor} — ${check.detail} (${offer.url})`);
  }
  if (check.unrendered_prices) {
    counters.set(UNRENDERED, (counters.get(UNRENDERED) ?? 0) + 1);
    console.log(
      `  ⌗ ${offer.vendor} — the page publishes prices it does not render: ${check.unrendered_prices.join(", ")} (${offer.url})`
    );
  }
  if (!dryRun) data.offers[index].source_check = check;
  if (holdsVerifiedDate(check.outcome)) {
    console.log(`  ⊘ ${offer.vendor} — verifiedDate held at ${offer.verifiedDate}: ${check.detail} (${offer.url})`);
  }
  return check;
}

const UNRENDERED = "unrendered_prices";

function emptySourceCounters() {
  return new Map([...SOURCE_CHECK_OUTCOMES, READ_FROM_MARKUP, UNRENDERED].map((key) => [key, 0]));
}

function attemptRecorder() {
  const attempts = [];
  return {
    attempts,
    note(offer, outcome, detail = null, category = null) {
      attempts.push({ vendor: offer?.vendor, url: offer?.url, outcome, detail, category });
    },
  };
}

export async function runUrlMode(picked, data, dryRun, now, options = {}) {
  const batchFn = options.batchFn ?? reverifyBatch;
  const fetchFn = options.fetchFn ?? fetchPageText;
  let verified = 0;
  let flagged = 0;
  const sourceChecks = emptySourceCounters();
  const recorder = attemptRecorder();
  for (let i = 0; i < picked.length; i += URL_CONCURRENCY) {
    const batch = picked.slice(i, i + URL_CONCURRENCY);
    const results = await batchFn(batch);
    const byIndex = new Map(batch.map((entry) => [entry.index, entry.offer]));
    for (const v of results.verified) {
      const offer = byIndex.get(v.index);
      const page = await fetchFn(offer.url);
      const check = applySourceCheck(offer, v.index, page, data, dryRun, now, sourceChecks);
      if (holdsVerifiedDate(check.outcome)) {
        recorder.note(offer, ATTEMPT_SOURCE_UNUSABLE, check.detail, FAILURE_SOURCE_UNUSABLE);
        continue;
      }
      if (!dryRun) {
        data.offers[v.index].verifiedDate = staggeredDate(now);
      }
      recorder.note(offer, ATTEMPT_LINK_OK);
      verified++;
    }
    for (const f of results.flagged) {
      console.log(`  ⚠ ${f.vendor} — ${f.error} (${f.url})`);
      recorder.note(f, ATTEMPT_FETCH_FAILED, f.error, classifyFetchError(f.error));
      flagged++;
    }
  }
  return { verified, flagged, changed: 0, changes: [], recorded: [], suppressed: [], unclassified: [], rejected: [], unchecked: [], reclassified: [], overruled: [], sourceChecks, attempts: recorder.attempts };
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
  const wholePages = new Set();
  const finalUrls = new Map();
  const sourceChecks = emptySourceCounters();
  const recorder = attemptRecorder();

  for (const entry of picked) {
    const { offer, index } = entry;
    const page = await fetchFn(offer.url);
    const check = applySourceCheck(offer, index, page, data, dryRun, now, sourceChecks);
    const sourceOk = !holdsVerifiedDate(check.outcome);
    if (!page.ok) {
      console.log(`  ⚠ ${offer.vendor} — ${page.error} (${offer.url})`);
      recorder.note(offer, ATTEMPT_FETCH_FAILED, page.error, classifyFetchError(page.error));
      flagged++;
      await sleep(rateLimitMs);
      continue;
    }
    let result;
    try {
      result = await verifyFn(offer, page.text);
    } catch (err) {
      console.log(`  ⚠ ${offer.vendor} — AI error: ${err.message}`);
      recorder.note(offer, ATTEMPT_AI_ERROR, err.message, FAILURE_AI_EXTRACTION);
      flagged++;
      await sleep(rateLimitMs);
      continue;
    }
    if (!sourceOk) {
      recorder.note(offer, ATTEMPT_SOURCE_UNUSABLE, check.detail, FAILURE_SOURCE_UNUSABLE);
    } else if (result.status === "confirmed") {
      recorder.note(offer, ATTEMPT_CONFIRMED);
    } else if (result.status === "changed") {
      recorder.note(offer, ATTEMPT_CHANGED);
    } else {
      recorder.note(offer, ATTEMPT_UNCLEAR, result.summary ?? null, FAILURE_AI_UNDECIDED);
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
        if (page.finalUrl) finalUrls.set(change, page.finalUrl);
        if (!page.truncated) wholePages.add(change);
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

  const { accepted, rejected, unchecked, reclassified, rewritten, overruled } = await gateCandidates(changes, {
    confirmFn,
    pageTextFor: (candidate) => pageTexts.get(candidate),
    pageCompleteFor: (candidate) => wholePages.has(candidate),
    finalUrlFor: (candidate) => finalUrls.get(candidate),
  });
  for (const { candidate, was, now } of rewritten) {
    console.log(`  ✎ ${candidate.vendor} summary rewritten to state the vendor's terms\n      was: ${was}\n      now: ${now}`);
  }
  for (const { candidate, from, to, detail } of reclassified) {
    console.log(`  ↻ ${candidate.vendor} recorded as ${to} rather than ${from}: ${detail}`);
  }
  for (const { candidate, opinion, detail } of overruled) {
    console.log(`  ↑ ${candidate.vendor} (${candidate.change_type}) kept over a second opinion — ${detail}. The second opinion said: ${opinion}`);
  }
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
  for (const { candidate, reason, collidedWith } of suppressed) {
    const against = collidedWith ? ` (collides with ${collidedWith})` : "";
    console.log(`  – ${candidate.vendor} (${candidate.change_type}) not recorded: ${reason}${against}`);
  }

  const refusals = (options.recordRefusalsFn ?? recordRefusals)(
    [...rejected, ...regradeRefusals(suppressed)],
    { dryRun, now, path: options.refusalsPath }
  );
  console.log(`  → ${refusals.written.length} refusal(s) written to ${refusals.path}`);

  return { verified, flagged, changed, changes, recorded: appended, suppressed, unclassified, rejected, unchecked, reclassified, rewritten, overruled, sourceChecks, attempts: recorder.attempts };
}

export function repickWindowDays(total, batchSize) {
  if (!batchSize || batchSize < 1) return 1;
  return Math.max(1, Math.ceil(total / batchSize));
}

export function regradeRefusals(suppressed) {
  return (suppressed ?? [])
    .filter((entry) => entry.reason === SUPPRESSED_SAME_TRANSITION_REGRADED)
    .map(({ candidate, reason, collidedWith }) => ({
      candidate,
      reason,
      detail: `same vendor, date, source_url and previous_state as ${collidedWith}`,
      collidedWith,
    }));
}

export function refusedVendorLines(rejected) {
  const byReason = new Map();
  for (const { candidate, reason } of rejected) {
    if (!byReason.has(reason)) byReason.set(reason, []);
    byReason.get(reason).push(candidate?.vendor ?? "(unnamed)");
  }
  return [...byReason.entries()].map(([reason, vendors]) => `  refused as ${reason}: ${vendors.join(", ")}`);
}

export function quarantineLines(quarantine) {
  if (!quarantine) return [];
  const lines = [
    `Retried from quarantine: ${quarantine.retried}`,
    `Left quarantine (checked successfully): ${quarantine.left}`,
    `Entered quarantine (${QUARANTINE_AFTER_FAILURES} consecutive failures): ${quarantine.entered}`,
    `In quarantine, retried every ${QUARANTINE_RETRY_DAYS} days: ${quarantine.total}`,
  ];
  for (const category of FAILURE_CATEGORIES) {
    const count = quarantine.byCategory?.get(category) ?? 0;
    if (count > 0) lines.push(`  ${category}: ${count}`);
  }
  return lines;
}

export function summaryLines(result, { useAi, checked, oldestRemaining, total, quarantine, repicked }) {
  const lines = ["", "── Summary ──", `Checked: ${checked}`, `Verified (date bumped): ${result.verified}`];
  if (useAi) {
    lines.push(`Changed (PM review needed): ${result.changed}`);
    const refusals = rejectionCounts(result.rejected ?? []);
    lines.push(`Rejected (no change described): ${(result.rejected ?? []).length}`);
    lines.push(`  of which the page carried no pricing: ${refusals.get(REJECT_NO_PRICE_SIGNAL) ?? 0}`);
    lines.push(`Rejected (page does not name the vendor): ${refusals.get(REJECT_PAGE_NOT_ABOUT_VENDOR) ?? 0}`);
    lines.push(`  of which claimed a limit quantified on one side only: ${refusals.get(REJECT_UNQUANTIFIED_LIMIT) ?? 0}`);
    for (const line of refusedVendorLines(result.rejected ?? [])) lines.push(line);
    lines.push(`Recorded as a restructure rather than dropped: ${(result.reclassified ?? []).length}`);
    for (const { candidate, from, to } of result.reclassified ?? []) {
      lines.push(`  ${candidate.vendor}: ${from} → ${to}`);
    }
    lines.push(`Kept over a second opinion that measurement contradicts: ${(result.overruled ?? []).length}`);
    for (const { candidate, difference } of result.overruled ?? []) {
      lines.push(`  ${candidate.vendor}: ${difference.attribute} ${difference.previous} → ${difference.current}`);
    }
    lines.push(`Recorded without a second opinion: ${(result.unchecked ?? []).length}`);
    lines.push(`Recorded to data/deal_changes.json: ${result.recorded.length}`);
    const regraded = regradeRefusals(result.suppressed).length;
    lines.push(`Already recorded, not written again: ${result.suppressed.length - regraded}`);
    lines.push(`Same transition re-read and graded differently, not written again: ${regraded}`);
    lines.push(`Detected but not recordable: ${result.unclassified.length}`);
  } else {
    lines.push("Change detection: not run. URL mode compares nothing and cannot report a change.");
  }
  const sourceChecks = result.sourceChecks ?? new Map();
  for (const outcome of SOURCE_CHECK_OUTCOMES) {
    if (outcome === SOURCE_CHECK_OK) continue;
    const label = holdsVerifiedDate(outcome) ? "Held back" : "Verified on weaker evidence";
    lines.push(`${label} (source ${outcome}): ${sourceChecks.get(outcome) ?? 0}`);
  }
  lines.push(`Graded on a price the page states in its markup, not its text: ${sourceChecks.get(READ_FROM_MARKUP) ?? 0}`);
  lines.push(`Publishing a price in markup the page never renders: ${sourceChecks.get(UNRENDERED) ?? 0}`);
  lines.push(`Flagged (URL/AI failure): ${result.flagged}`);
  for (const line of quarantineLines(quarantine)) lines.push(line);
  if (repicked !== undefined) {
    lines.push(`Checked again on the next run: ${repicked} of ${checked}`);
  }
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
  const holds = refusalHolds(readRefusals(), offers);
  const state = pruneToOffers(readVerificationState(), offers);
  const seeded = backfillVerificationState(state, offers, { linkHealth: readLinkHealth() });
  if (seeded.length > 0) {
    console.log(`Seeded verification state for ${seeded.length} offer(s) from their recorded source check.`);
  }
  if (args.includes("--seed-state")) {
    const written = writeVerificationState(state, { dryRun, now });
    const held = quarantinedRecords(state);
    console.log(`${state.size} record(s) in ${written.path}, ${held.length} quarantined`);
    for (const [category, count] of failureCategoryCounts(held)) {
      if (count > 0) console.log(`  ${category}: ${count}`);
    }
    process.exit(0);
  }

  const selection = { refusalHolds: holds, verificationState: state };
  const { picked, oldestRemaining, retriedFromQuarantine } = pickOldestEntries(offers, limit, now, selection);

  console.log(
    `Rolling re-verification — ${picked.length} oldest entries` +
      (retriedFromQuarantine > 0 ? `, ${retriedFromQuarantine} retried from quarantine` : "") +
      (useAi ? ` (${VERIFIER_MODEL})` : " (URL-only)") +
      (dryRun ? " (dry-run)" : "")
  );
  console.log("");

  if (picked.length === 0) {
    const held = quarantinedRecords(state);
    console.log(
      held.length > 0
        ? `No entries to process. ${held.length} record(s) are in quarantine and none is due for retry yet.`
        : "No entries to process."
    );
    for (const line of quarantineLines({ retried: 0, entered: 0, left: 0, total: held.length, byCategory: failureCategoryCounts(held) })) {
      console.log(line);
    }
    process.exit(0);
  }

  const result = useAi
    ? await runAiMode(picked, data, dryRun, now, {
        windowDays: repickWindowDays(offers.length, picked.length),
      })
    : await runUrlMode(picked, data, dryRun, now);

  const checks = result.sourceChecks ?? new Map();
  const sourceChecksWritten = SOURCE_CHECK_OUTCOMES.reduce((a, outcome) => a + (checks.get(outcome) ?? 0), 0);
  if (!dryRun && (result.verified > 0 || sourceChecksWritten > 0)) {
    writeFileSync(INDEX_PATH, JSON.stringify(data, null, 2) + "\n");
  }

  const { entered, left } = recordAttempts(state, result.attempts ?? [], now);
  const written = writeVerificationState(state, { dryRun, now });
  console.log(`  → ${result.attempts?.length ?? 0} attempt(s) written to ${written.path}`);
  const held = quarantinedRecords(state);
  const quarantine = {
    retried: retriedFromQuarantine,
    entered: entered.length,
    left: left.length,
    total: held.length,
    byCategory: failureCategoryCounts(held),
  };
  const repicked = repickedNextRun(picked, offers, limit, now, selection);

  for (const line of summaryLines(result, {
    useAi,
    checked: picked.length,
    oldestRemaining,
    total: offers.length,
    quarantine,
    repicked,
  })) {
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
