import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Population } from "./population-floor.ts";

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

export interface StoredChange {
  vendor: string;
  date: string;
  change_type: string;
  impact: string;
  resolution?: { state: string; date: string } | null;
}

export function storedChanges(): StoredChange[] {
  const at = process.env.AGENTDEALS_CHANGES_PATH || path.join(REPO, "data", "deal_changes.json");
  const raw = JSON.parse(readFileSync(at, "utf-8"));
  return Array.isArray(raw) ? raw : raw.changes;
}

export function recordKey(change: { vendor: string; date: string; change_type: string }): string {
  return `${change.vendor}|${change.date}|${change.change_type}`;
}

export function withdrawnRecords(): StoredChange[] {
  return storedChanges().filter((change) => change.resolution?.state === "retracted");
}

export function undoneRecords(): StoredChange[] {
  return storedChanges().filter((change) => change.resolution?.state === "reversed");
}

export function changeTypesHoldingAWithdrawnRecord(): string[] {
  return [...new Set(withdrawnRecords().map((change) => change.change_type))].sort();
}

export function typesHoldingAWithdrawnRecord(): Population {
  return {
    size: changeTypesHoldingAWithdrawnRecord().length,
    read: "change types the log holds a record we have withdrawn under",
  };
}

export function recordsWeHaveWithdrawn(): Population {
  return { size: withdrawnRecords().length, read: "records in the log we have withdrawn as our own error" };
}
