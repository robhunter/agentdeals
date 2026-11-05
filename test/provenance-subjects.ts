import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const scratch = mkdtempSync(path.join(tmpdir(), "provenance-subjects-"));
const read = (variable: string, name: string) =>
  JSON.parse(readFileSync(process.env[variable] || path.join(REPO, "data", name), "utf-8"));
const index = read("AGENTDEALS_INDEX_PATH", "index.json");
const readings = read("AGENTDEALS_VERIFICATION_STATE_PATH", "verification_state.json");
const refusals = read("AGENTDEALS_REFUSALS_PATH", "change_refusals.json");
const day = new Date().toISOString().slice(0, 10);
const earlier = new Date(Date.now() - 2 * 86_400_000).toISOString().slice(0, 10);

export const PROVENANCE_SUBJECTS = [
  { vendor: "Provenance Subject Unreported", outcome: "ok", dated: false },
  { vendor: "Provenance Subject Contradicted", outcome: "changed", dated: false },
  { vendor: "Provenance Subject Settled", outcome: "changed", dated: false },
  { vendor: "Provenance Subject No Terms", outcome: "states_no_price", dated: false },
  { vendor: "Provenance Subject Confirmed", outcome: "confirmed", dated: true },
  { vendor: "Provenance Subject Restated", outcome: "ok", dated: true },
] as const;

for (const subject of PROVENANCE_SUBJECTS) {
  const url = `https://${subject.vendor.toLowerCase().replaceAll(" ", "-")}.example/pricing`;
  index.offers.push({
    vendor: subject.vendor,
    category: "Databases",
    description: "Free plan: 1 GB of storage and 10,000 requests a month.",
    tier: subject.vendor.endsWith("Settled") ? "Legacy Free" : "Free",
    url,
    tags: [],
    verifiedDate: day,
    source_check: { checked: earlier, outcome: "ok", detail: "the page states 1 GB of storage" },
    ...(subject.vendor.endsWith("Restated") ? {
      restated_from: { reading_date: day, source_url: url, record_date: day, change_type: "limits_reduced", restated_on: day },
    } : {}),
  });
  readings.records.push({
    vendor: subject.vendor,
    url,
    last_attempt_at: day,
    last_outcome: subject.outcome,
    last_success: subject.outcome === "confirmed" ? day : null,
    consecutive_failures: 0,
    last_error: null,
    failure_category: null,
    quarantined_since: null,
  });
  if (subject.vendor.endsWith("Settled")) refusals.refusals.push({
    vendor: subject.vendor,
    change_type: "limits_reduced",
    reason: "states_no_difference",
    detail: "the reading repeats the stored allowance",
    summary: "Free plan: 1 GB of storage and 10,000 requests a month.",
    previous_state: "Free plan: 1 GB of storage and 10,000 requests a month.",
    current_state: "Free plan: 1 GB of storage and 10,000 requests a month.",
    source_url: url,
    category: "Databases",
    refused_date: day,
  });
}

for (const [variable, name, store] of [
  ["AGENTDEALS_INDEX_PATH", "index.json", index],
  ["AGENTDEALS_VERIFICATION_STATE_PATH", "verification_state.json", readings],
  ["AGENTDEALS_REFUSALS_PATH", "change_refusals.json", refusals],
] as const) {
  const at = path.join(scratch, name);
  writeFileSync(at, JSON.stringify(store));
  process.env[variable] = at;
}
process.on("exit", () => rmSync(scratch, { recursive: true, force: true }));
