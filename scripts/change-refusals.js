import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { isoDay } from "./change-log.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

const DEFAULT_REFUSALS_PATH = resolve(__dirname, "..", "data", "change_refusals.json");

export function refusalsPath() {
  return process.env.AGENTDEALS_REFUSALS_PATH || DEFAULT_REFUSALS_PATH;
}

export function offerKey(vendor, url) {
  return `${vendor}|${url}`;
}

export function refusalKey(refusal) {
  return [refusal.vendor, refusal.source_url, refusal.reason].join("|");
}

export function buildRefusalEntry({ candidate, reason, detail, collidedWith }, options = {}) {
  const now = options.now ?? new Date();
  const entry = {
    vendor: candidate.vendor,
    change_type: candidate.change_type,
    reason,
    detail: detail ?? null,
    summary: candidate.summary ?? null,
    previous_state: candidate.previous_state ?? null,
    current_state: candidate.current_state ?? null,
    source_url: candidate.source_url ?? null,
    category: candidate.category ?? null,
    refused_date: isoDay(now),
  };
  if (collidedWith) entry.collided_with = collidedWith;
  return entry;
}

export function readRefusals(path = refusalsPath()) {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8"));
    return Array.isArray(parsed?.refusals) ? parsed.refusals : [];
  } catch {
    return [];
  }
}

export function mergeRefusals(existing, fresh) {
  const merged = new Map(existing.map((refusal) => [refusalKey(refusal), refusal]));
  for (const refusal of fresh) merged.set(refusalKey(refusal), refusal);
  return [...merged.values()].sort((a, b) => refusalKey(a).localeCompare(refusalKey(b)));
}

export function recordRefusals(rejected, options = {}) {
  const path = options.path ?? refusalsPath();
  const fresh = rejected.map((entry) => buildRefusalEntry(entry, { now: options.now }));
  if (options.dryRun) return { written: fresh, path };
  const merged = mergeRefusals(readRefusals(path), fresh);
  writeFileSync(path, JSON.stringify({ refusals: merged }, null, 2) + "\n");
  return { written: fresh, path };
}

const admissionKey = (entry) =>
  [entry.vendor, entry.source_url, entry.change_type, entry.summary].join("|");

export function withoutAdmitted(refusals, admitted) {
  const readmitted = new Set(admitted.map(admissionKey));
  return refusals.filter((refusal) => !readmitted.has(admissionKey(refusal)));
}

export function withdrawRefusals(admitted, options = {}) {
  const path = options.path ?? refusalsPath();
  const existing = readRefusals(path);
  const remaining = withoutAdmitted(existing, admitted);
  const withdrawn = existing.length - remaining.length;
  if (withdrawn > 0 && !options.dryRun) {
    writeFileSync(path, JSON.stringify({ refusals: remaining }, null, 2) + "\n");
  }
  return { withdrawn, path };
}

export function refusalHolds(refusals, offers) {
  const byKey = new Map(offers.map((offer) => [offerKey(offer.vendor, offer.url), offer]));
  const holds = new Map();
  for (const refusal of refusals) {
    const key = offerKey(refusal.vendor, refusal.source_url);
    const offer = byKey.get(key);
    if (!offer) continue;
    if (refusal.previous_state !== offer.description) continue;
    if (!refusal.refused_date) continue;
    const held = holds.get(key);
    if (!held || refusal.refused_date > held) holds.set(key, refusal.refused_date);
  }
  return holds;
}
