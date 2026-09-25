#!/usr/bin/env node

import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { reverifyBatch } from "./reverify.js";
import {
  fetchPageText,
  verifyOfferAgainstPage,
  createVerifierClient,
  challengeRendersThisRun,
  VERIFIER_MODEL,
} from "./verify-freshness.js";
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
  checkKeptOnlyTheName,
  sourceCheckRecord,
  holdsVerifiedDate,
  READ_FROM_MARKUP,
  SOURCE_CHECK_OK,
  SOURCE_CHECK_OUTCOMES,
  SOURCE_CHECK_UNREADABLE,
} from "./vendor-naming.js";
import { findRenderer } from "./rendered-page.js";
import { isoDay } from "./change-log.js";
import { recordRefusals, readRefusals, refusalHolds, offerKey } from "./change-refusals.js";
import {
  deferralMs,
  oneTurnOfTheQueue,
  queueOrderLines,
  readAnsweredWithNothing,
} from "./queue-order.js";
import {
  CORROBORATION_EXPIRY_DAYS,
  heldReadingLines,
  mergeHeld,
  pagesAwaitingCorroboration,
  partitionAccepted,
  readHeldReadings,
  resolutionLines,
  resolveHeldReadings,
  writeHeldReadings,
} from "./change-corroboration.js";
import {
  ATTEMPT_AI_ERROR,
  ATTEMPT_CHANGED,
  ATTEMPT_CONFIRMED,
  ATTEMPT_FETCH_FAILED,
  ATTEMPT_LINK_OK,
  ATTEMPT_SOURCE_UNUSABLE,
  ATTEMPT_STATES_NO_PRICE,
  ATTEMPT_UNCLEAR,
  FAILURE_AI_EXTRACTION,
  FAILURE_AI_UNDECIDED,
  FAILURE_CATEGORIES,
  FAILURE_SOURCE_UNUSABLE,
  QUARANTINE_AFTER_FAILURES,
  QUARANTINE_RETRY_DAYS,
  backfillVerificationState,
  classifyFetchError,
  clearFailuresALaterReadingAnswered,
  failedReadingCensus,
  failureCategoryCounts,
  isQuarantined,
  lastReadFailed,
  pageStatesNoPrice,
  pruneToOffers,
  quarantineRetryDue,
  quarantinedRecords,
  readLinkHealth,
  readVerificationState,
  recordAttempts,
  stampsAConfirmation,
  writeVerificationState,
} from "./verification-state.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const INDEX_PATH =
  process.env.AGENTDEALS_INDEX_PATH || resolve(__dirname, "..", "data", "index.json");
const DEFAULT_LIMIT = 100;
const URL_CONCURRENCY = 10;
const AI_RATE_LIMIT_MS = 500;
const QUARANTINE_RETRY_SHARE = 0.2;

export function lastAttemptedDate(offer, refusedOn = null, verificationRecord = null) {
  const dates = [
    offer?.verifiedDate,
    offer?.source_check?.checked,
    refusedOn,
    verificationRecord?.last_attempt_at,
  ].filter(Boolean);
  return dates.length > 0 ? dates.sort().pop() : null;
}

export function quarantineRetryBudget(limit) {
  return Math.max(1, Math.round(limit * QUARANTINE_RETRY_SHARE));
}

export function pickOldestEntries(offers, limit, now = new Date(), options = {}) {
  const holds = options.refusalHolds ?? new Map();
  const state = options.verificationState ?? new Map();
  const awaiting = options.awaitingCorroboration ?? new Set();
  const today = isoDay(now);
  const entries = offers.map((offer, index) => {
    const key = offerKey(offer?.vendor, offer?.url);
    const record = state.get(key) ?? null;
    const attempted = lastAttemptedDate(offer, holds.get(key), record);
    const ts = attempted ? new Date(attempted).getTime() : 0;
    return {
      index,
      offer,
      record,
      ts,
      deferred: readAnsweredWithNothing(offer),
      readFailed: lastReadFailed(record),
      awaitingCorroboration: awaiting.has(key),
      keptOnlyTheName: checkKeptOnlyTheName(offer),
    };
  });
  const byAge = (a, b) =>
    Number(b.awaitingCorroboration) - Number(a.awaitingCorroboration) ||
    a.ts - b.ts ||
    Number(b.readFailed) - Number(a.readFailed);
  const liveQueueLength = entries.filter(
    (entry) => !isQuarantined(entry.record) && !entry.awaitingCorroboration
  ).length;
  const turnDays = oneTurnOfTheQueue(liveQueueLength, limit);
  const drawAge = (entry) => entry.ts + (entry.deferred ? deferralMs(turnDays) : 0);
  const byDrawAge = (a, b) =>
    Number(b.awaitingCorroboration) - Number(a.awaitingCorroboration) ||
    Number(b.keptOnlyTheName) - Number(a.keptOnlyTheName) ||
    drawAge(a) - drawAge(b) ||
    Number(b.readFailed) - Number(a.readFailed);
  const active = entries.filter((entry) => !isQuarantined(entry.record)).sort(byDrawAge);
  const queue = active.filter((entry) => !entry.awaitingCorroboration);
  const dueRetries = entries
    .filter((entry) => isQuarantined(entry.record) && quarantineRetryDue(entry.record, today))
    .sort(byAge);

  const retries = dueRetries.slice(0, Math.min(dueRetries.length, quarantineRetryBudget(limit)));
  const fromQueue = queue.slice(0, Math.max(0, limit - retries.length));
  const spare = limit - retries.length - fromQueue.length;
  const extraRetries = spare > 0 ? dueRetries.slice(retries.length, retries.length + spare) : [];
  const secondReadings = active.filter((entry) => entry.awaitingCorroboration).slice(0, limit);

  const drawn = [...retries, ...extraRetries, ...fromQueue, ...secondReadings].sort(byDrawAge);
  const picked = drawn.map(({ index, offer }) => ({ index, offer }));
  const remaining = queue.slice(fromQueue.length);
  const oldestRemaining = remaining.length > 0
    ? (remaining[0].offer.verifiedDate || null)
    : null;
  return {
    picked,
    pickedAfterAFailedRead: drawn.filter((entry) => entry.readFailed).length,
    pickedForASecondReading: secondReadings.length,
    pickedBecauseTheCheckKeptOnlyTheName: fromQueue.filter((entry) => entry.keptOnlyTheName).length,
    queuedWithACheckThatKeptOnlyTheName: queue.filter((entry) => entry.keptOnlyTheName).length,
    drawnFromQueue: retries.length + extraRetries.length + fromQueue.length,
    oldestRemaining,
    retriedFromQuarantine: retries.length + extraRetries.length,
    quarantineDue: dueRetries.length,
    quarantineHeld: entries.filter((entry) => isQuarantined(entry.record)).length,
    deferredATurn: queue.filter((entry) => entry.deferred).length,
    liveQueueLength,
    turnDays,
  };
}

export function repickedNextRun(picked, offers, limit, now, options = {}) {
  const tomorrow = new Date(now.getTime() + 24 * 60 * 60 * 1000);
  const { picked: next } = pickOldestEntries(offers, limit, tomorrow, options);
  const checked = new Set(picked.map(({ offer }) => offerKey(offer?.vendor, offer?.url)));
  return next.filter(({ offer }) => checked.has(offerKey(offer?.vendor, offer?.url))).length;
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
  if (check.rendered) {
    counters.set(RENDERED, (counters.get(RENDERED) ?? 0) + 1);
    if (check.outcome !== SOURCE_CHECK_UNREADABLE) {
      counters.set(RENDERED_AND_READ, (counters.get(RENDERED_AND_READ) ?? 0) + 1);
    }
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
const RENDERED = "rendered";
const RENDERED_AND_READ = "rendered_and_read";

function emptySourceCounters() {
  return new Map(
    [...SOURCE_CHECK_OUTCOMES, READ_FROM_MARKUP, UNRENDERED, RENDERED, RENDERED_AND_READ].map(
      (key) => [key, 0]
    )
  );
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
      const statesNoPrice = pageStatesNoPrice(check.outcome);
      if (holdsVerifiedDate(check.outcome)) {
        if (statesNoPrice) recorder.note(offer, ATTEMPT_STATES_NO_PRICE, check.detail);
        else recorder.note(offer, ATTEMPT_SOURCE_UNUSABLE, check.detail, FAILURE_SOURCE_UNUSABLE);
        continue;
      }
      if (!dryRun) {
        data.offers[v.index].verifiedDate = isoDay(now);
      }
      if (statesNoPrice) recorder.note(offer, ATTEMPT_STATES_NO_PRICE, check.detail);
      else recorder.note(offer, ATTEMPT_LINK_OK);
      verified++;
    }
    for (const f of results.flagged) {
      console.log(`  ⚠ ${f.vendor} — ${f.error} (${f.url})`);
      recorder.note(f, ATTEMPT_FETCH_FAILED, f.error, classifyFetchError(f.error));
      flagged++;
    }
  }
  return { verified, flagged, changed: 0, changes: [], recorded: [], suppressed: [], unclassified: [], rejected: [], unchecked: [], reclassified: [], overruled: [], sourceChecks, challengeRenders: challengeRendersThisRun(), attempts: recorder.attempts };
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
  const confirmedThisRun = new Set();

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
    const statesNoPrice = pageStatesNoPrice(check.outcome);
    const readAPageAboutThisOffer = sourceOk || statesNoPrice;
    const confirms = stampsAConfirmation(result.status, check.outcome);
    if (!readAPageAboutThisOffer) {
      recorder.note(offer, ATTEMPT_SOURCE_UNUSABLE, check.detail, FAILURE_SOURCE_UNUSABLE);
    } else if (confirms) {
      recorder.note(offer, ATTEMPT_CONFIRMED);
    } else if (result.status === "changed") {
      recorder.note(offer, ATTEMPT_CHANGED);
    } else if (statesNoPrice) {
      recorder.note(offer, ATTEMPT_STATES_NO_PRICE, check.detail);
    } else {
      recorder.note(offer, ATTEMPT_UNCLEAR, result.summary ?? null, FAILURE_AI_UNDECIDED);
    }
    if (confirms) {
      if (!dryRun) {
        data.offers[index].verifiedDate = isoDay(now);
      }
      confirmedThisRun.add(offerKey(offer.vendor, offer.url));
      verified++;
    } else if (result.status === "confirmed") {
      await sleep(rateLimitMs);
      continue;
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
    offers: data.offers,
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

  const store = (options.readHeldFn ?? readHeldReadings)(options.corroborationPath);
  const storedTerms = new Map(
    (data.offers ?? []).map((offer) => [offerKey(offer.vendor, offer.url), offer.description])
  );
  const { published, stillHeld, resolutions, answered } = resolveHeldReadings(
    store.held,
    { accepted, refused: rejected, confirmed: confirmedThisRun },
    { now, storedTerms }
  );
  const { publishNow, toHold } = partitionAccepted(accepted, answered, { now });
  for (const line of heldReadingLines(toHold)) console.log(line);
  for (const line of resolutionLines(resolutions)) console.log(line);
  const corroboration = writeHeldReadings(
    mergeHeld(stillHeld, toHold),
    [...store.resolved, ...resolutions],
    { dryRun, now, path: options.corroborationPath }
  );
  console.log(
    `  → ${corroboration.document.held.length} reading(s) awaiting a second reading in ${corroboration.path}`
  );

  const { appended, suppressed } = appendFn([...publishNow, ...published], {
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

  return {
    verified,
    flagged,
    changed,
    changes,
    recorded: appended,
    suppressed,
    unclassified,
    rejected,
    unchecked,
    reclassified,
    rewritten,
    overruled,
    sourceChecks,
    challengeRenders: challengeRendersThisRun(),
    attempts: recorder.attempts,
    held: toHold,
    corroborated: published,
    resolutions,
    awaitingCorroboration: corroboration.document.held,
  };
}

export function repickWindowDays(total, batchSize) {
  if (!batchSize || batchSize < 1) return 1;
  return Math.max(1, Math.ceil(total / batchSize));
}

export function regradeRefusals(suppressed) {
  return (suppressed ?? [])
    .filter((entry) => entry.reason === SUPPRESSED_SAME_TRANSITION_REGRADED)
    .map(({ candidate, reason, collidedWith, collidedWithWithdrawn }) => ({
      candidate,
      reason,
      detail: collidedWithWithdrawn
        ? `graded as ${collidedWith}, a record we withdrew`
        : `same vendor, source_url and previous_state as ${collidedWith}`,
      collidedWith,
      collidedWithWithdrawn: Boolean(collidedWithWithdrawn),
    }));
}

export function regradedVendorLines(suppressed) {
  return regradeRefusals(suppressed).map(
    ({ candidate, collidedWith, collidedWithWithdrawn }) =>
      collidedWithWithdrawn
        ? `  ${candidate?.vendor ?? "(unnamed)"} (${candidate?.change_type ?? "unclassified"}) grades those terms as ${collidedWith}, a record we withdrew`
        : `  ${candidate?.vendor ?? "(unnamed)"} (${candidate?.change_type ?? "unclassified"}) reads the same terms we already recorded as ${collidedWith}`
  );
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

export function failedReadingLines(census) {
  if (!census) return [];
  return [
    `Records whose last reading did not answer: ${census.failed} of ${census.total}`,
    `Records whose reading would not answer if we repeated it today, so bound for quarantine ` +
      `within ${QUARANTINE_AFTER_FAILURES} passes: ${census.readAgainWouldFail}`,
    `In quarantine now: ${census.quarantined}`,
  ];
}

export function summaryLines(result, { useAi, checked, drawnFromQueue, oldestRemaining, total, quarantine, repicked, pickedAfterAFailedRead, pickedForASecondReading, failedReadings, turnDays, deferredATurn, liveQueueLength, pickedBecauseTheCheckKeptOnlyTheName, queuedWithACheckThatKeptOnlyTheName }) {
  const lines = ["", "── Summary ──", `Checked: ${checked}`];
  if (drawnFromQueue !== undefined) {
    lines.push(`Drawn from the queue, so pages this run advances: ${drawnFromQueue}`);
  }
  if (queuedWithACheckThatKeptOnlyTheName !== undefined) {
    lines.push(
      `Drawn first because the stored check kept only the vendor's name: ${pickedBecauseTheCheckKeptOnlyTheName} of ${queuedWithACheckThatKeptOnlyTheName}`
    );
  }
  for (const line of queueOrderLines(turnDays, deferredATurn, liveQueueLength)) lines.push(line);
  if (pickedAfterAFailedRead !== undefined) {
    lines.push(`Drawn after a read that failed: ${pickedAfterAFailedRead} of ${checked}`);
  }
  if (pickedForASecondReading !== undefined) {
    lines.push(`Drawn to give a held demoting verdict its second reading: ${pickedForASecondReading} of ${checked}`);
  }
  lines.push(`Verified (date bumped): ${result.verified}`);
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
    lines.push(`Held for a second reading (a demoting verdict this run read once): ${(result.held ?? []).length}`);
    for (const line of heldReadingLines(result.held ?? [])) lines.push(line);
    lines.push(`Held readings a reading this run answered: ${(result.resolutions ?? []).length}`);
    for (const line of resolutionLines(result.resolutions ?? [])) lines.push(line);
    lines.push(`Published because a second reading agreed: ${(result.corroborated ?? []).length}`);
    lines.push(
      `Awaiting a second reading, given up on after ${CORROBORATION_EXPIRY_DAYS} days: ` +
        `${(result.awaitingCorroboration ?? []).length}`
    );
    lines.push(`Recorded to data/deal_changes.json: ${result.recorded.length}`);
    const regraded = regradeRefusals(result.suppressed).length;
    lines.push(`Already recorded, not written again: ${result.suppressed.length - regraded}`);
    lines.push(`Same transition re-read and graded differently, not written again: ${regraded}`);
    for (const line of regradedVendorLines(result.suppressed)) lines.push(line);
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
  lines.push(`Handed to the rendering client after a 401, 403 or 429: ${result.challengeRenders ?? 0}`);
  lines.push(`Read again with a rendering client after the fetcher could not read it: ${sourceChecks.get(RENDERED) ?? 0}`);
  lines.push(`Of those, a reading came back: ${sourceChecks.get(RENDERED_AND_READ) ?? 0}`);
  lines.push(`Graded on a price the page states in its markup, not its text: ${sourceChecks.get(READ_FROM_MARKUP) ?? 0}`);
  lines.push(`Publishing a price in markup the page never renders: ${sourceChecks.get(UNRENDERED) ?? 0}`);
  lines.push(`Flagged (URL/AI failure): ${result.flagged}`);
  for (const line of quarantineLines(quarantine)) lines.push(line);
  for (const line of failedReadingLines(failedReadings)) lines.push(line);
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
  const answeredSince = clearFailuresALaterReadingAnswered(state, offers);
  if (answeredSince.cleared.length > 0) {
    console.log(
      `Cleared a stale failure on ${answeredSince.cleared.length} offer(s) whose page has been read since, ` +
        `${answeredSince.left.length} of them out of quarantine.`
    );
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

  const awaitingCorroboration = pagesAwaitingCorroboration(readHeldReadings().held);
  const selection = { refusalHolds: holds, verificationState: state, awaitingCorroboration };
  const { picked, oldestRemaining, retriedFromQuarantine, pickedAfterAFailedRead, pickedForASecondReading, drawnFromQueue, deferredATurn, liveQueueLength, turnDays, pickedBecauseTheCheckKeptOnlyTheName, queuedWithACheckThatKeptOnlyTheName } =
    pickOldestEntries(offers, limit, now, selection);

  const renderer = findRenderer();
  console.log(
    renderer
      ? `A page that comes back too short, or behind a 401, 403 or 429, is read again with ${renderer}`
      : "No rendering client is installed — a page the fetcher cannot read stays unread"
  );
  console.log(
    `Rolling re-verification — ${drawnFromQueue} oldest entries` +
      (retriedFromQuarantine > 0 ? `, ${retriedFromQuarantine} retried from quarantine` : "") +
      (pickedForASecondReading > 0 ? `, ${pickedForASecondReading} re-read to corroborate a held verdict` : "") +
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
        windowDays: repickWindowDays(offers.length, drawnFromQueue),
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
    drawnFromQueue,
    oldestRemaining,
    total: offers.length,
    quarantine,
    repicked,
    pickedAfterAFailedRead,
    pickedForASecondReading,
    failedReadings: failedReadingCensus(state, offers),
    turnDays,
    deferredATurn,
    liveQueueLength,
    pickedBecauseTheCheckKeptOnlyTheName,
    queuedWithACheckThatKeptOnlyTheName,
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
