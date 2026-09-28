import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Population } from "./population-floor.ts";
import {
  REFUSAL_REASONS_THAT_LEAVE_THE_READ_STANDING,
  REFUSAL_REASONS_THAT_MEASURED_NO_DIFFERENCE,
  REFUSAL_REASONS_THAT_VOID_THE_READS_STANDING,
} from "../dist/change-refusal.js";

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const DAY_MS = 86_400_000;

const daysFromToday = (days: number): string => new Date(Date.now() + days * DAY_MS).toISOString().slice(0, 10);

export const SUBJECTS_CONFIRMED_ON = daysFromToday(-10);
export const SUBJECTS_REFUSED_ON = daysFromToday(-3);

export type RefusalFamily = "voids_the_read" | "measured_no_difference" | "leaves_the_read_standing";

export interface RefusedReadSubject {
  vendor: string;
  reason: string;
  family: RefusalFamily;
  url: string;
}

const REASONS_BY_FAMILY: Array<[RefusalFamily, readonly string[]]> = [
  ["voids_the_read", REFUSAL_REASONS_THAT_VOID_THE_READS_STANDING],
  ["measured_no_difference", REFUSAL_REASONS_THAT_MEASURED_NO_DIFFERENCE],
  ["leaves_the_read_standing", REFUSAL_REASONS_THAT_LEAVE_THE_READ_STANDING],
];

export const REFUSED_READ_SUBJECTS: RefusedReadSubject[] = REASONS_BY_FAMILY.flatMap(([family, reasons]) =>
  reasons.map((reason) => ({
    vendor: `Refused Read Subject ${reason.replace(/_/g, " ")}`,
    reason,
    family,
    url: `https://${reason.replace(/_/g, "-")}.refused-read-subject.example/pricing`,
  })));

export const isRefusedReadSubject = (vendor: string): boolean =>
  REFUSED_READ_SUBJECTS.some((subject) => subject.vendor === vendor);

export const builtAmong = (vendors: Array<{ vendor: string }>): number =>
  vendors.filter((subject) => isRefusedReadSubject(subject.vendor)).length;

export const listingsBuiltToHoldARefusedRead = (): Population => ({
  size: REFUSED_READ_SUBJECTS.length,
  read: "listings built to withhold on a refused read alone",
});

export const listingsBuiltWithAnEqualityRefusal = (): Population => ({
  size: REFUSED_READ_SUBJECTS.filter((subject) => subject.family === "measured_no_difference").length,
  read: "listings built to withhold on a refusal that measured no difference",
});

const storePath = (variable: string, name: string): string =>
  process.env[variable] || path.join(REPO, "data", name);

const readStore = (variable: string, name: string) => JSON.parse(readFileSync(storePath(variable, name), "utf-8"));

const scratch = mkdtempSync(path.join(tmpdir(), "refused-read-subjects-"));
const index = readStore("AGENTDEALS_INDEX_PATH", "index.json");
const refusals = readStore("AGENTDEALS_REFUSALS_PATH", "change_refusals.json");
const readings = readStore("AGENTDEALS_VERIFICATION_STATE_PATH", "verification_state.json");

for (const subject of REFUSED_READ_SUBJECTS) {
  index.offers.push({
    vendor: subject.vendor,
    category: "Databases",
    description: "Free plan: 1 GB of storage and 10,000 requests a month.",
    tier: "Free",
    url: subject.url,
    tags: [],
    verifiedDate: SUBJECTS_CONFIRMED_ON,
    source_check: {
      checked: SUBJECTS_CONFIRMED_ON,
      outcome: "ok",
      detail: `the page names ${subject.vendor} and states the terms we publish`,
    },
  });
  refusals.refusals.push({
    vendor: subject.vendor,
    change_type: "limits_reduced",
    reason: subject.reason,
    detail: "a listing whose only withholding is this refusal",
    summary: "Storage cut from 1 GB to 500 MB.",
    previous_state: "Free plan: 1 GB of storage and 10,000 requests a month.",
    current_state: "Free plan: 500 MB of storage and 10,000 requests a month.",
    source_url: subject.url,
    category: "Databases",
    refused_date: SUBJECTS_REFUSED_ON,
  });
  readings.records.push({
    vendor: subject.vendor,
    url: subject.url,
    last_attempt_at: SUBJECTS_REFUSED_ON,
    last_outcome: "changed",
    last_error: null,
    failure_category: null,
    consecutive_failures: 0,
    last_success: SUBJECTS_CONFIRMED_ON,
    quarantined_since: null,
  });
}

const write = (variable: string, name: string, store: unknown): void => {
  const at = path.join(scratch, name);
  writeFileSync(at, JSON.stringify(store));
  process.env[variable] = at;
};

write("AGENTDEALS_INDEX_PATH", "index.json", index);
write("AGENTDEALS_REFUSALS_PATH", "change_refusals.json", refusals);
write("AGENTDEALS_VERIFICATION_STATE_PATH", "verification_state.json", readings);
process.on("exit", () => rmSync(scratch, { recursive: true, force: true }));
