import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { VerificationLedger } from "./ranking.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const QUARANTINE_RETRY_DAYS = 7;
export const QUARANTINE_AFTER_FAILURES = 3;

function verificationStatePath(): string {
  return (
    process.env.AGENTDEALS_VERIFICATION_STATE_PATH ||
    path.join(__dirname, "..", "data", "verification_state.json")
  );
}

export interface VerificationStateRecord {
  vendor: string;
  url: string;
  last_attempt_at: string | null;
  last_outcome: string | null;
  last_error: string | null;
  failure_category: string | null;
  consecutive_failures: number;
  last_success: string | null;
  quarantined_since: string | null;
}

export interface QuarantineEntry extends VerificationStateRecord {
  next_retry: string | null;
}

export interface QuarantineSummary {
  count: number;
  retry_after_days: number;
  by_reason: Record<string, number>;
  entries: QuarantineEntry[];
}

let cachedState: Map<string, VerificationStateRecord> | null = null;

export function resetVerificationStateCache(): void {
  cachedState = null;
}

export function loadVerificationState(): Map<string, VerificationStateRecord> {
  if (cachedState) return cachedState;
  const state = new Map<string, VerificationStateRecord>();
  try {
    const parsed = JSON.parse(fs.readFileSync(verificationStatePath(), "utf-8"));
    const records: VerificationStateRecord[] = Array.isArray(parsed?.records) ? parsed.records : [];
    for (const record of records) {
      if (!record?.vendor || !record?.url) continue;
      state.set(`${record.vendor}|${record.url}`, record);
    }
  } catch {
    state.clear();
  }
  cachedState = state;
  return state;
}

export function isQuarantined(record: VerificationStateRecord | undefined | null): boolean {
  return Boolean(record?.quarantined_since);
}

export function nextRetryDate(record: VerificationStateRecord): string | null {
  if (!isQuarantined(record) || !record.last_attempt_at) return null;
  const ms = Date.parse(`${record.last_attempt_at}T00:00:00Z`);
  if (Number.isNaN(ms)) return null;
  return new Date(ms + QUARANTINE_RETRY_DAYS * 86_400_000).toISOString().slice(0, 10);
}

export function verificationLedger(): VerificationLedger {
  const ledger: VerificationLedger = new Map();
  for (const record of loadVerificationState().values()) {
    if ((record.consecutive_failures ?? 0) < 1) continue;
    const key = record.vendor.toLowerCase();
    const held = ledger.get(key);
    if (held && held.consecutive_failures >= record.consecutive_failures) continue;
    ledger.set(key, {
      vendor: record.vendor,
      url: record.url,
      consecutive_failures: record.consecutive_failures,
      last_success: record.last_success,
      last_attempt: record.last_attempt_at ?? "",
      last_error: record.last_error ?? record.failure_category ?? "no reason recorded",
    });
  }
  return ledger;
}

export function quarantineSummary(): QuarantineSummary {
  const entries: QuarantineEntry[] = [];
  const byReason: Record<string, number> = {};
  for (const record of loadVerificationState().values()) {
    if (!isQuarantined(record)) continue;
    const reason = record.failure_category ?? "unrecorded";
    byReason[reason] = (byReason[reason] ?? 0) + 1;
    entries.push({ ...record, next_retry: nextRetryDate(record) });
  }
  entries.sort((a, b) => (a.last_attempt_at ?? "").localeCompare(b.last_attempt_at ?? ""));
  return {
    count: entries.length,
    retry_after_days: QUARANTINE_RETRY_DAYS,
    by_reason: byReason,
    entries,
  };
}
