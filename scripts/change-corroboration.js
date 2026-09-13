import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { isoDay } from "./change-log.js";
import { changeTypeCanDemote } from "../src/change-demotion.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));

const DEFAULT_CORROBORATION_PATH = resolve(__dirname, "..", "data", "change_corroboration.json");

export const CORROBORATION_EXPIRY_DAYS = 30;
export const RESOLUTION_HISTORY_DAYS = 90;

export const CORROBORATED = "corroborated";
export const CONTRADICTED = "contradicted";
export const BASELINE_MOVED = "baseline_moved";
export const NEVER_CORROBORATED = "never_corroborated";

export const IMPACTS_WEAKEST_FIRST = ["low", "medium", "high"];

export function corroborationPath() {
  return process.env.AGENTDEALS_CORROBORATION_PATH || DEFAULT_CORROBORATION_PATH;
}

export function readingKey(vendor, sourceUrl) {
  return `${vendor}|${sourceUrl}`;
}

export function keyOfReading(reading) {
  return readingKey(reading?.vendor, reading?.source_url);
}

export function demandsCorroboration(candidate) {
  return changeTypeCanDemote(candidate?.change_type);
}

export function readHeldReadings(path = corroborationPath()) {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8"));
    return {
      held: Array.isArray(parsed?.held) ? parsed.held : [],
      resolved: Array.isArray(parsed?.resolved) ? parsed.resolved : [],
    };
  } catch {
    return { held: [], resolved: [] };
  }
}

export function heldReadingFor(candidate, { now = new Date(), firstRead = null } = {}) {
  return {
    vendor: candidate.vendor,
    change_type: candidate.change_type,
    impact: candidate.impact,
    summary: candidate.summary ?? null,
    previous_state: candidate.previous_state ?? null,
    current_state: candidate.current_state ?? null,
    source_url: candidate.source_url ?? null,
    category: candidate.category ?? null,
    first_read_date: firstRead ?? isoDay(now),
  };
}

export function weakerImpact(a, b) {
  const rank = (impact) => {
    const at = IMPACTS_WEAKEST_FIRST.indexOf(impact);
    return at === -1 ? IMPACTS_WEAKEST_FIRST.length : at;
  };
  return rank(a) <= rank(b) ? a : b;
}

export function corroboratedRecord(held, candidate) {
  return { ...candidate, impact: weakerImpact(held.impact, candidate.impact) };
}

export function daysBetween(from, to) {
  const start = Date.parse(from);
  const end = Date.parse(to);
  if (Number.isNaN(start) || Number.isNaN(end)) return 0;
  return Math.floor((end - start) / 86_400_000);
}

export function resolutionEntry(held, outcome, detail, { now = new Date() } = {}) {
  return {
    vendor: held.vendor,
    change_type: held.change_type,
    impact: held.impact,
    summary: held.summary ?? null,
    previous_state: held.previous_state ?? null,
    source_url: held.source_url ?? null,
    first_read_date: held.first_read_date,
    outcome,
    detail,
    resolved_date: isoDay(now),
  };
}

export function whatTheSecondReadingSaid(key, { accepted, refused, confirmed }) {
  const change = accepted.find((candidate) => keyOfReading(candidate) === key);
  if (change) return { verdict: change.change_type, detail: `read it as ${change.change_type}` };
  const refusal = refused.find(({ candidate }) => keyOfReading(candidate) === key);
  if (refusal) {
    return {
      verdict: refusal.reason,
      detail: `read a change the gate refused as ${refusal.reason}`,
    };
  }
  if (confirmed.has(key)) {
    return { verdict: "confirmed_unchanged", detail: "read the page as unchanged" };
  }
  return null;
}

export function resolveHeldReadings(heldReadings, reading, options = {}) {
  const now = options.now ?? new Date();
  const today = isoDay(now);
  const storedTerms = options.storedTerms ?? new Map();
  const published = [];
  const stillHeld = [];
  const resolutions = [];
  const answered = new Set();

  for (const held of heldReadings) {
    const key = keyOfReading(held);
    if (storedTerms.has(key) && storedTerms.get(key) !== held.previous_state) {
      resolutions.push(
        resolutionEntry(held, BASELINE_MOVED, "the terms it was read against are no longer the terms we publish", { now })
      );
      continue;
    }
    const second = whatTheSecondReadingSaid(key, reading);
    if (second === null) {
      if (daysBetween(held.first_read_date, today) >= CORROBORATION_EXPIRY_DAYS) {
        resolutions.push(
          resolutionEntry(
            held,
            NEVER_CORROBORATED,
            `no second reading in ${CORROBORATION_EXPIRY_DAYS} days`,
            { now }
          )
        );
        continue;
      }
      stillHeld.push(held);
      continue;
    }
    answered.add(key);
    if (second.verdict === held.change_type) {
      const candidate = reading.accepted.find((entry) => keyOfReading(entry) === key);
      published.push(corroboratedRecord(held, candidate));
      resolutions.push(
        resolutionEntry(
          held,
          CORROBORATED,
          `a reading on ${today} read it as ${held.change_type} too`,
          { now }
        )
      );
      continue;
    }
    resolutions.push(
      resolutionEntry(
        held,
        CONTRADICTED,
        `a reading on ${today} ${second.detail}`,
        { now }
      )
    );
  }

  return { published, stillHeld, resolutions, answered };
}

export function partitionAccepted(accepted, answered, options = {}) {
  const now = options.now ?? new Date();
  const publishNow = [];
  const toHold = [];
  for (const candidate of accepted) {
    if (!demandsCorroboration(candidate)) {
      publishNow.push(candidate);
      continue;
    }
    if (answered.has(keyOfReading(candidate))) continue;
    toHold.push(heldReadingFor(candidate, { now }));
  }
  return { publishNow, toHold };
}

export function pruneResolutions(resolved, now = new Date()) {
  const today = isoDay(now);
  return resolved.filter(
    (entry) => daysBetween(entry.resolved_date, today) < RESOLUTION_HISTORY_DAYS
  );
}

export function mergeHeld(stillHeld, toHold) {
  const merged = new Map(stillHeld.map((held) => [keyOfReading(held), held]));
  for (const held of toHold) merged.set(keyOfReading(held), held);
  return [...merged.values()].sort((a, b) => keyOfReading(a).localeCompare(keyOfReading(b)));
}

export function serializeStore(document) {
  return JSON.stringify(document, null, 2) + "\n";
}

export function writeHeldReadings(held, resolved, options = {}) {
  const path = options.path ?? corroborationPath();
  const document = {
    held,
    resolved: pruneResolutions(resolved, options.now ?? new Date()),
  };
  const serialized = serializeStore(document);
  let onDisk = null;
  try {
    onDisk = readFileSync(path, "utf-8");
  } catch {
    onDisk = null;
  }
  const written = !options.dryRun && serialized !== onDisk;
  if (written) writeFileSync(path, serialized);
  return { document, path, written };
}

export function pagesAwaitingCorroboration(heldReadings) {
  return new Set(heldReadings.map(keyOfReading));
}

export function heldReadingLines(toHold) {
  return toHold.map(
    (held) =>
      `  ${held.vendor} (${held.change_type}) held for a second reading: ${held.summary ?? "no summary"}`
  );
}

export function resolutionLines(resolutions) {
  return resolutions.map(
    ({ vendor, change_type, outcome, detail }) => `  ${vendor} (${change_type}) ${outcome}: ${detail}`
  );
}
