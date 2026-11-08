import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const [worktree, saved, output] = process.argv.slice(2, 5).map((path) => resolve(path));
const live = process.argv.includes("--live-history");
if (!output) throw new Error("Usage: worktree saved-input-directory output-directory [--live-history]");
mkdirSync(output, { recursive: true });
const read = (file) => readFileSync(`${saved}/${file}`, "utf8");
const jsonl = (file) => read(file).trim().split("\n").filter(Boolean).map(JSON.parse);
const hash = (value) => createHash("sha256").update(value).digest("hex");
const runtime = await import(pathToFileURL(`${worktree}/scripts/archive-captures.js`));
const settlement = await import(pathToFileURL(`${worktree}/scripts/settle-discovered-records.js`));
const runner = await import(pathToFileURL(`${worktree}/scripts/run-archive-settlement.js`));
const { createVerifierClient } = await import(pathToFileURL(`${worktree}/scripts/verify-freshness.js`));
const report = JSON.parse(read("report.json"));
const gitJson = (ref, file) => JSON.parse(execFileSync("git", ["show", `${ref}:${file}`], { cwd: worktree, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }));
const source = JSON.parse(read("metadata.json")).source;
const changes = gitJson(source, "data/deal_changes.json").changes;
const originals = gitJson("7a26c604^", "data/deal_changes.json").changes;
const restored = runner.originalCorrections(changes, originals).map(({ original }) => original);
const offers = gitJson(source, "data/index.json").offers;
const keyOf = (record) => JSON.stringify([record.vendor, settlement.recordKey(record)]);
const resultKey = (result) => JSON.stringify([result.vendor, result.record_key]);
const calls = jsonl("model-calls.jsonl");
const requestKey = (request) => JSON.stringify([request.model, request.max_tokens, request.temperature, request.reasoning, request.messages]);
const responses = new Map(calls.filter((call) => call.status === 200).map((call) => [requestKey(call.request), call]));
const fetches = jsonl("archive-fetches.jsonl");
const savedFetches = new Map(fetches.map((row) => [row.url, row]));
const originalUrls = new Set([...report.results, ...report.audit.results].map((row) => row.source_url));
const queriesBySource = new Map();
let group;
for (const row of fetches) {
  if (!row.url.includes("/cdx/")) continue;
  const url = new URL(row.url).searchParams.get("url");
  if (originalUrls.has(url)) group = url;
  if (!group) throw new Error("CDX group has no source");
  queriesBySource.set(group, [...new Set([...(queriesBySource.get(group) ?? []), url])]);
}
const targets = [];
for (const [pass, results, records] of [["unsettled", report.results, changes], ["audit", report.audit.results, restored]]) {
  const byKey = new Map(records.map((record) => [keyOf(record), record]));
  for (const original of results) {
    const record = byKey.get(resultKey(original));
    if (!record) throw new Error(`Missing original: ${resultKey(original)}`);
    targets.push({ pass, original, record });
  }
}
let active;
let sequence = 0;
const networkFetch = globalThis.fetch;
const liveArchive = runtime.createArchiveClient({ fetchImpl: async (url, options) => {
  const row = { vendor: active.vendor, url, status: null };
  active.live_archive.push(url);
  try {
    const response = await networkFetch(url, options);
    row.status = response.status;
    row.file = `${hash(url)}-${sequence++}.txt`;
    writeFileSync(`${output}/${row.file}`, await response.clone().text());
    appendFileSync(`${output}/archive-fetches.jsonl`, JSON.stringify(row) + "\n");
    return response;
  } catch (error) {
    row.error = String(error.message);
    appendFileSync(`${output}/archive-fetches.jsonl`, JSON.stringify(row) + "\n");
    throw error;
  }
} });
const archive = {
  async captures(url, from, to) {
    const key = runtime.cdxUrl(url, from, to);
    const row = savedFetches.get(key);
    if (!row) { active.missing_archive.push(key); return { unavailable: "missing saved CDX inventory" }; }
    active.archive_hits.push(key);
    return row.status === 200 ? { captures: runtime.parseCdxRows(read(row.file)) } : { unavailable: `saved HTTP ${row.status}` };
  },
  async captureHtml(capture) {
    const key = runtime.captureUrl(capture);
    const row = savedFetches.get(key);
    if (row) {
      active.archive_hits.push(key);
      return row.status === 200 ? { html: read(row.file) } : { unavailable: `saved HTTP ${row.status}` };
    }
    if (live && active.historical_started) return liveArchive.captureHtml(capture);
    active.missing_archive.push(key);
    return { unavailable: "missing saved capture; incomplete evaluation" };
  },
};
const client = createVerifierClient({ apiKey: live ? undefined : "offline-replay", maxTokens: runtime.PAIRED_READER_MAX_TOKENS, fetchImpl: async (url, options) => {
  const request = JSON.parse(options.body);
  const saved = responses.get(requestKey(request));
  if (saved) { active.model_hits.push(hash(request.messages[0].content)); return new Response(saved.output, { status: saved.status }); }
  const prompt = request.messages[0].content;
  if (!live || !prompt.startsWith("You are checking whether an old copy of a web page already said what a change record calls new.")) {
    active.missing_model.push({ hash: hash(prompt), prompt });
    throw new Error("Missing exact saved model response; no live paired-reader requests allowed");
  }
  active.live_model.push(hash(prompt));
  try {
    const response = await networkFetch(url, options);
    appendFileSync(`${output}/model-calls.jsonl`, JSON.stringify({ vendor: active.vendor, request, status: response.status, output: await response.clone().text() }) + "\n");
    return response;
  } catch (error) {
    appendFileSync(`${output}/model-calls.jsonl`, JSON.stringify({ vendor: active.vendor, request, error: String(error.message) }) + "\n");
    throw error;
  }
} });
globalThis.fetch = async () => { throw new Error("Direct network access disabled"); };
const runtimeHashes = Object.fromEntries(["scripts/archive-captures.js", "scripts/settle-discovered-records.js", "scripts/run-archive-settlement.js", "scripts/verify-freshness.js"].map((file) => [file, hash(readFileSync(`${worktree}/${file}`))]));
const metadata = { source: execFileSync("git", ["rev-parse", "HEAD"], { cwd: worktree, encoding: "utf8" }).trim(), prior_source: source, runtime: runtimeHashes, started: new Date().toISOString(), live, expected: targets.map(({ pass, original }) => ({ pass, vendor: original.vendor, record_key: original.record_key })) };
writeFileSync(`${output}/metadata.json`, JSON.stringify(metadata, null, 2) + "\n");
const outcomes = [];
for (const { pass, original, record } of targets) {
  active = { pass, vendor: record.vendor, record_key: settlement.recordKey(record), archive_hits: [], model_hits: [], missing_archive: [], missing_model: [], live_archive: [], live_model: [], historical_started: false };
  const readings = [];
  let measured;
  if (["text_day_unknown", "page_unreadable_today"].includes(original.outcome)) {
    measured = { outcome: original.outcome, why: original.why, reads: 0 };
    active.scope = "preserved saved non-reading outcome";
  } else {
    const queries = queriesBySource.get(record.source_url) ?? [];
    if (queries.length > 2) throw new Error(`Ambiguous redirect for ${record.vendor}`);
    const marker = `NEW PAGE (saved ${report.today}, truncated):\n`;
    const todayTexts = calls.filter((call) => call.status === 200 && call.request.messages[0].content.includes(`- Vendor: ${record.vendor}\n`) && call.request.messages[0].content.includes(marker)).map((call) => call.request.messages[0].content.split(marker)[1].split("\n\nStep 1.")[0]);
    if (new Set(todayTexts).size > 1) active.saved_today_variants = todayTexts.map(hash);
    measured = await runtime.settleAgainstCaptures({
      url: record.source_url, finalUrl: queries[1], textDay: original.text_day, recordDay: record.date,
      todayText: todayTexts.at(-1) ?? "", today: report.today, archive,
      readPair: runtime.pairedReaderFor(client, settlement.listingFor(record, offers)),
      readStatedBefore: runtime.statedBeforeReaderFor(client, record),
      onRead: (row) => { readings.push(row); if (row.newer === "the record") active.historical_started = true; },
    }).catch((error) => ({ outcome: "reader_failed", why: error.message }));
  }
  const entry = { ...active, original, measured, readings, complete: active.missing_archive.length === 0 && active.missing_model.length === 0 };
  outcomes.push(entry);
  appendFileSync(`${output}/progress.jsonl`, JSON.stringify(entry) + "\n");
  console.log(`${pass}: ${record.vendor}: ${measured.outcome}; complete=${entry.complete}`);
}
const result = { ...metadata, results: outcomes, network_requests: outcomes.reduce((n, row) => n + row.live_archive.length, 0), model_requests: outcomes.reduce((n, row) => n + row.live_model.length, 0), catalogue_writes: 0 };
writeFileSync(`${output}/year-rule-replay.json`, JSON.stringify(result, null, 2) + "\n");
const projected = (entry) => ({ vendor: entry.vendor, date: entry.original.date, change_type: entry.original.change_type, ...entry.measured, verdict_changed: entry.measured.outcome !== "ours" });
writeFileSync(`${output}/report.md`, runner.archiveSettlementSummary({ results: outcomes.filter((row) => row.pass === "unsettled" && row.complete).map(projected), audit: { results: outcomes.filter((row) => row.pass === "audit" && row.complete).map(projected) } }));
console.log(`Complete: ${outcomes.filter((row) => row.complete).length}/${targets.length}; Archive attempts: ${result.network_requests}; model calls: ${result.model_requests}`);
