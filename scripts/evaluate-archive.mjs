import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createArchiveClient, dayOurTextEntered, pairedReaderFor, PAIRED_READER_MAX_TOKENS, previousValueReaderFor, statedBeforeReaderFor } from "./archive-captures.js";
import { archiveSettlementSummary, runArchiveSettlement } from "./run-archive-settlement.js";
import { createVerifierClient, fetchPageText } from "./verify-freshness.js";

const dir = "archive-evaluation";
mkdirSync(dir, { recursive: true });
const hash = (text) => createHash("sha256").update(text).digest("hex");
const checkedFetch = async (url, options) => {
  const response = await fetch(url, options);
  const output = await response.clone().text();
  appendFileSync(`${dir}/model-calls.jsonl`, JSON.stringify({ request: JSON.parse(options.body), status: response.status, output }) + "\n");
  return response;
};
const archiveFetch = async (url, options) => {
  const response = await fetch(url, options);
  const text = await response.clone().text();
  const filename = `${hash(String(url))}.txt`;
  writeFileSync(`${dir}/${filename}`, text);
  appendFileSync(`${dir}/archive-fetches.jsonl`, JSON.stringify({ url: String(url), status: response.status, file: filename }) + "\n");
  return response;
};
const allChanges = JSON.parse(readFileSync("data/deal_changes.json", "utf8")).changes;
const mode = process.env.ARCHIVE_EVAL_MODE || "smoke";
const changes = mode === "backlog" ? allChanges : allChanges.filter((record) => ["OneSignal", "Mapbox"].includes(record.vendor));
const offers = JSON.parse(readFileSync("data/index.json", "utf8")).offers;
const originals = mode === "backlog" ? JSON.parse(execFileSync("git", ["show", "7a26c604^:data/deal_changes.json"], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 })).changes : undefined;
const client = createVerifierClient({ maxTokens: PAIRED_READER_MAX_TOKENS, fetchImpl: checkedFetch });
writeFileSync(`${dir}/metadata.json`, JSON.stringify({ mode, source: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(), model: client.model, started: new Date().toISOString() }, null, 2) + "\n");
const report = await runArchiveSettlement({
  changes, originals, offers, today: new Date().toISOString().slice(0, 10), archive: createArchiveClient({ fetchImpl: archiveFetch }),
  pairReaderForListing: (listing) => pairedReaderFor(client, listing),
  statedReaderForRecord: (record) => statedBeforeReaderFor(client, record),
  previousReaderForRecord: (record) => previousValueReaderFor(client, record),
  fetchToday: (url) => fetchPageText(url), textDayOf: (text) => dayOurTextEntered(text),
  onSettled: (result) => {
    appendFileSync(`${dir}/progress.jsonl`, JSON.stringify(result) + "\n");
    console.log(`${result.pass}: ${result.vendor} ${result.date} ${result.outcome} ${result.why || ""}`);
  },
});
writeFileSync(`${dir}/report.json`, JSON.stringify(report, null, 2) + "\n");
writeFileSync(`${dir}/report.md`, archiveSettlementSummary(report));
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, archiveSettlementSummary(report));
console.log(`Finished ${report.results.length} unsettled records and ${report.audit?.results.length ?? 0} correction audits.`);
