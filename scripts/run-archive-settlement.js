import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { createArchiveClient, dayOurTextEntered, pairedReaderFor, PAIRED_READER_MAX_TOKENS, previousValueReaderFor, statedBeforeReaderFor } from "./archive-captures.js";
import { firstReadingsInForce, recordKey, settleFirstReadings } from "./settle-discovered-records.js";
import { createVerifierClient, fetchPageText } from "./verify-freshness.js";

function originalIdentity(record) {
  return JSON.stringify([record.vendor, record.recorded_date ?? record.date, record.previous_state, record.current_state]);
}

export function originalCorrections(changes, originals) {
  const byIdentity = new Map();
  for (const record of firstReadingsInForce(originals, { includeResolved: true })) {
    const key = originalIdentity(record);
    byIdentity.set(key, [...(byIdentity.get(key) ?? []), record]);
  }
  return changes.filter((record) => record.archive_check?.outcome === "ours").map((current) => {
    const matches = byIdentity.get(originalIdentity(current)) ?? [];
    if (matches.length !== 1) throw new Error(`expected one original first reading for ${current.vendor} ${current.recorded_date ?? current.date}, found ${matches.length}`);
    return { current, original: matches[0] };
  });
}

export async function runArchiveSettlement({ changes, originals, onSettled = () => {}, ...options }) {
  const corrections = originals ? originalCorrections(changes, originals) : [];
  const report = await settleFirstReadings({ ...options, changes, unsettledOnly: true, logReads: true, onSettled: (result) => onSettled({ pass: "unsettled", ...result }) });
  let audit = null;
  if (originals) {
    const previous = new Map(corrections.map(({ current, original }) => [JSON.stringify([original.vendor, recordKey(original)]), current]));
    const checked = await settleFirstReadings({ ...options, changes: corrections.map(({ original }) => original), includeResolved: true, logReads: true, onSettled: (result) => onSettled({ pass: "audit", ...result }) });
    audit = {
      ...checked,
      results: checked.results.map((result) => ({ ...result, previous_archive_check: previous.get(JSON.stringify([result.vendor, result.record_key])).archive_check, verdict_changed: result.outcome !== "ours" })),
    };
  }
  return { ...report, audit };
}

function tableCell(value) {
  return String(value ?? "").replaceAll("|", "\\|").replace(/\s+/g, " ");
}

export function archiveSettlementSummary(report) {
  const rows = (results) => results.map((result) => `| ${[result.vendor, result.date, result.change_type, result.outcome, result.why ?? ""].map(tableCell).join(" | ")} |`);
  const table = (results) => ["| Vendor | Record day | Type | Outcome | Reason |", "|---|---|---|---|---|", ...rows(results)];
  const lines = [`### Archive settlement: ${report.results.length} unsettled first readings`, "", ...table(report.results)];
  if (report.audit) lines.push("", `### Existing corrections audited: ${report.audit.results.length}`, "", `${report.audit.results.filter((result) => result.verdict_changed).length} verdicts differ from the earlier ours outcome. Audit results are not written by this run.`, "", ...table(report.audit.results));
  lines.push("", reviewCorrectionsSummary(report));
  return lines.join("\n") + "\n";
}

export function reviewCorrectionsSummary(report) {
  const reviewed = [
    ...report.results.map((result) => ({ pass: "unsettled", ...result })),
    ...(report.audit?.results ?? []).map((result) => ({ pass: "audit", ...result })),
  ].filter((result) => result.settled_from_review && result.outcome === "ours");
  const lines = [`### Review records settled as our corrections: ${reviewed.length}`, "", "| Pass | Vendor | Record day | Stated-before lines | Review lines |", "|---|---|---|---|---|"];
  for (const result of reviewed) {
    const stated = result.stated_then.map((line) => `${line.record}: ${line.old}`).join("; ");
    const review = (result.review ?? []).map((line) => `${line.old ?? ""} → ${line.new ?? ""}: ${line.why ?? ""}`).join("; ");
    lines.push(`| ${[result.pass, result.vendor, result.date, stated, review].map(tableCell).join(" | ")} |`);
  }
  return lines.join("\n") + "\n";
}

async function main() {
  const args = process.argv.slice(2);
  const option = (name) => { const at = args.indexOf(name); return at < 0 ? undefined : args[at + 1]; };
  const out = option("--out");
  if (!out) throw new Error("give --out <report.json>; optionally --audit-ours-from <git-ref>");
  const auditRef = option("--audit-ours-from");
  const originals = auditRef ? JSON.parse(execFileSync("git", ["show", `${auditRef}:data/deal_changes.json`], { encoding: "utf-8", maxBuffer: 64 * 1024 * 1024 })).changes : undefined;
  const changes = JSON.parse(readFileSync("data/deal_changes.json", "utf-8")).changes;
  const offers = JSON.parse(readFileSync("data/index.json", "utf-8")).offers;
  const client = createVerifierClient({ maxTokens: PAIRED_READER_MAX_TOKENS });
  const progress = `${out}.jsonl`;
  writeFileSync(progress, "");
  const report = await runArchiveSettlement({
    changes, originals, offers, today: new Date().toISOString().slice(0, 10), archive: createArchiveClient(),
    pairReaderForListing: (listing) => pairedReaderFor(client, listing),
    statedReaderForRecord: (record) => statedBeforeReaderFor(client, record),
    previousReaderForRecord: (record) => previousValueReaderFor(client, record),
    fetchToday: (url) => fetchPageText(url), textDayOf: (text) => dayOurTextEntered(text),
    onSettled: (result) => { appendFileSync(progress, `${JSON.stringify(result)}\n`); console.log(`${result.pass}: ${result.vendor} ${result.date} ${result.outcome}`); },
  });
  writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
  writeFileSync(`${out}.md`, archiveSettlementSummary(report));
  writeFileSync(`${out}.review.md`, reviewCorrectionsSummary(report));
  console.log(`Report: ${out}`);
}

if (import.meta.url === `file://${process.argv[1]}`) main().catch((error) => { console.error(error?.message ?? error); process.exitCode = 1; });
