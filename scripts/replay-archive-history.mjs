import { readFileSync, writeFileSync, mkdirSync, appendFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

const [worktree, evaluation, replay, output] = process.argv.slice(2, 6).map((path) => resolve(path));
if (!output) throw new Error("give worktree, original evaluation, review replay and output directory");
const allowMissingHistory = process.argv.slice(6).includes("--allow-missing-history");
mkdirSync(output, { recursive: true });
const read = (dir, file) => readFileSync(`${dir}/${file}`, "utf8");
const json = (dir, file) => JSON.parse(read(dir, file));
const jsonl = (dir, file) => read(dir, file).trim().split("\n").map(JSON.parse);
const hash = (text) => createHash("sha256").update(text).digest("hex");
const runtime = await import(pathToFileURL(`${worktree}/scripts/archive-captures.js`));
const settlement = await import(pathToFileURL(`${worktree}/scripts/settle-discovered-records.js`));
const verification = await import(pathToFileURL(`${worktree}/scripts/verify-freshness.js`));
const { originalCorrections } = await import(pathToFileURL(`${worktree}/scripts/run-archive-settlement.js`));
const report = json(evaluation, "report.json");
const candidates = json(replay, "review-candidates.json").candidates.filter((row) => row.eligible_before_historical_guard);
const changes = json(worktree, "data/deal_changes.json").changes;
const originals = JSON.parse(execFileSync("git", ["show", "7a26c604^:data/deal_changes.json"], { cwd: worktree, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 })).changes;
const restored = originalCorrections(changes, originals).map(({ original }) => original);
const offers = json(worktree, "data/index.json").offers;
const calls = [...jsonl(evaluation, "model-calls.jsonl"), ...jsonl(replay, "model-calls.jsonl")];
const requestKey = (request) => JSON.stringify([request.model, request.max_tokens, request.temperature, request.reasoning, request.messages]);
const responses = new Map(calls.filter((call) => call.status === 200).map((call, index) => [requestKey(call.request), { ...call, index }]));
const fetches = jsonl(evaluation, "archive-fetches.jsonl");
const savedFetches = new Map(fetches.map((row) => [row.url, row]));
const savedKey = (row) => JSON.stringify([row.vendor, row.record_key]);
const originalKey = (row) => JSON.stringify([row.vendor, settlement.recordKey(row)]);
const targets = [];
for (const [pass, results, records] of [["unsettled", report.results, changes], ["audit", report.audit.results, restored]]) {
  const byKey = new Map(records.map((row) => [originalKey(row), row]));
  for (const result of results) {
    const candidate = candidates.find((row) => row.pass === pass && row.vendor === result.vendor && row.date === result.date);
    if (!candidate && !["Mapbox", "OneSignal", "Mux", "ScaleGrid Startup Program"].includes(result.vendor)) continue;
    const record = byKey.get(savedKey(result));
    if (!record) throw new Error(`original missing: ${savedKey(result)}`);
    targets.push({ pass, result, record, candidate });
  }
}
if (targets.filter((row) => row.candidate).length !== candidates.length) throw new Error("candidate membership differs");
let active;
let archiveSequence = 0;
writeFileSync(`${output}/metadata.json`, JSON.stringify({
  source: execFileSync("git", ["rev-parse", "HEAD"], { cwd: worktree, encoding: "utf8" }).trim(),
  started: new Date().toISOString(), allow_missing_history: allowMissingHistory,
  prior_source: json(evaluation, "metadata.json").source,
  prior_report_hash: hash(read(evaluation, "report.json")),
  review_replay_hash: hash(read(replay, "review-candidates.json")),
  expected: targets.map(({ pass, record, candidate }) => ({ pass, vendor: record.vendor, record_key: settlement.recordKey(record), eligible_review_candidate: Boolean(candidate) })),
}, null, 2) + "\n");
const networkFetch = globalThis.fetch;
const liveArchive = runtime.createArchiveClient({ fetchImpl: async (url, options) => {
  const row = { vendor: active.vendor, url, status: null };
  active.live_archive.push(row);
  const response = await networkFetch(url, options).catch((error) => {
    row.error = String(error?.message ?? error);
    appendFileSync(`${output}/archive-fetches.jsonl`, JSON.stringify(row) + "\n");
    throw error;
  });
  const text = await response.clone().text();
  const file = `${hash(url)}-${archiveSequence++}.txt`;
  writeFileSync(`${output}/${file}`, text);
  Object.assign(row, { status: response.status, file });
  appendFileSync(`${output}/archive-fetches.jsonl`, JSON.stringify(row) + "\n");
  return response;
} });
const archive = {
  async captures(url, from, to) {
    const key = runtime.cdxUrl(url, from, to);
    const saved = savedFetches.get(key);
    if (!saved) {
      active.missing_archive.push(key);
      active.unresolved_archive.push(key);
      return { unavailable: "not present in the saved evaluation; offline replay cannot read it" };
    }
    active.archive_hits.push(key);
    return saved.status === 200 ? { captures: runtime.parseCdxRows(read(evaluation, saved.file)) } : { unavailable: `saved HTTP ${saved.status}` };
  },
  async captureHtml(capture) {
    const key = runtime.captureUrl(capture);
    const saved = savedFetches.get(key);
    if (!saved) {
      active.missing_archive.push(key);
      if (allowMissingHistory && active.eligible_review_candidate && active.historical_started) return liveArchive.captureHtml(capture);
      active.unresolved_archive.push(key);
      return { unavailable: "not present in the saved evaluation; offline replay cannot read it" };
    }
    active.archive_hits.push(key);
    return saved.status === 200 ? { html: read(evaluation, saved.file) } : { unavailable: `saved HTTP ${saved.status}` };
  },
};
const client = verification.createVerifierClient({
  apiKey: allowMissingHistory ? undefined : "offline-replay",
  maxTokens: runtime.PAIRED_READER_MAX_TOKENS,
  fetchImpl: async (url, options) => {
    const request = JSON.parse(options.body);
    const saved = responses.get(requestKey(request));
    if (!saved) {
      active.missing_model.push({ prompt_hash: hash(request.messages[0].content), prompt: request.messages[0].content });
      if (allowMissingHistory && active.eligible_review_candidate && active.historical_started && request.messages[0].content.startsWith("You are checking whether an archived page states an earlier value that a change record says changed.")) {
        const attempt = { status: null, prompt_hash: hash(request.messages[0].content) };
        active.live_model.push(attempt);
        const response = await networkFetch(url, options).catch((error) => {
          attempt.error = String(error?.message ?? error);
          appendFileSync(`${output}/model-calls.jsonl`, JSON.stringify({ vendor: active.vendor, request, error: attempt.error }) + "\n");
          throw error;
        });
        const row = { vendor: active.vendor, request, status: response.status, output: await response.clone().text() };
        appendFileSync(`${output}/model-calls.jsonl`, JSON.stringify(row) + "\n");
        attempt.status = response.status;
        return response;
      }
      active.unresolved_model.push(hash(request.messages[0].content));
      throw new Error("no exact saved completion for this request; offline replay cannot judge it");
    }
    active.model_hits.push({ index: saved.index, prompt_hash: hash(request.messages[0].content) });
    return new Response(saved.output, { status: saved.status });
  },
});
globalThis.fetch = async () => { throw new Error("network disabled in the offline replay"); };
const originalSourceUrls = new Set([...report.results, ...report.audit.results].map((row) => row.source_url));
const queriesBySource = new Map();
let source;
for (const row of fetches) {
  if (!row.url.includes("/cdx/")) continue;
  const queried = new URL(row.url).searchParams.get("url");
  if (originalSourceUrls.has(queried)) source = queried;
  if (!source) throw new Error("capture inventory has no record source");
  queriesBySource.set(source, [...new Set([...(queriesBySource.get(source) ?? []), queried])]);
}
const outcomes = [];
for (const target of targets) {
  const { pass, result, record, candidate } = target;
  active = { pass, vendor: record.vendor, record_key: settlement.recordKey(record), eligible_review_candidate: Boolean(candidate), missing_archive: [], missing_model: [], archive_hits: [], model_hits: [], unresolved_archive: [], unresolved_model: [], live_archive: [], live_model: [], historical_started: false };
  const queries = queriesBySource.get(record.source_url) ?? [];
  if (queries.length > 2) throw new Error(`ambiguous redirect for ${record.vendor}`);
  active.inventory_queries = queries;
  const todayMarker = `NEW PAGE (saved ${report.today}, truncated):\n`;
  const todayTexts = calls.filter((call) => call.status === 200 && call.request.messages[0].content.includes(`- Vendor: ${record.vendor}\n`) && call.request.messages[0].content.includes(todayMarker)).map((call) => call.request.messages[0].content.split(todayMarker)[1].split("\n\nStep 1.")[0]);
  if (new Set(todayTexts).size > 1) active.multiple_saved_today_pages = todayTexts.map(hash);
  const readings = [];
  const measured = await runtime.settleAgainstCaptures({
    url: record.source_url, finalUrl: queries[1], textDay: result.text_day, recordDay: record.date,
    todayText: todayTexts.at(-1) ?? "", today: report.today, archive,
    readPair: runtime.pairedReaderFor(client, settlement.listingFor(record, offers)),
    readStatedBefore: runtime.statedBeforeReaderFor(client, record),
    readPreviousValue: runtime.previousValueReaderFor(client, record),
    onRead: (row) => {
      readings.push(row);
      if (row.newer === "the record" && ["stated", "removal_stated"].includes(row.verdict.status)) active.historical_started = true;
    },
  }).catch((error) => ({ outcome: "reader_failed", why: error.message }));
  const entry = { ...active, measured, readings, complete_from_saved_inputs: active.missing_archive.length === 0 && active.missing_model.length === 0,
    complete_evidence: active.unresolved_archive.length === 0 && active.unresolved_model.length === 0 };
  outcomes.push(entry);
  appendFileSync(`${output}/progress.jsonl`, JSON.stringify(entry) + "\n");
  console.log(`${pass}: ${record.vendor}: ${measured.outcome}; saved inputs complete: ${entry.complete_from_saved_inputs}`);
}
mkdirSync(output, { recursive: true });
const metadata = {
  source: execFileSync("git", ["rev-parse", "HEAD"], { cwd: worktree, encoding: "utf8" }).trim(),
  runtime: Object.fromEntries(["scripts/archive-captures.js", "scripts/settle-discovered-records.js", "scripts/run-archive-settlement.js", "scripts/verify-freshness.js"].map((file) => [file, hash(read(worktree, file))])),
  prior_source: json(evaluation, "metadata.json").source,
  prior_report_hash: hash(read(evaluation, "report.json")),
  review_replay_hash: hash(read(replay, "review-candidates.json")),
  network_requests: outcomes.reduce((total, row) => total + row.live_archive.length, 0),
  model_requests: outcomes.reduce((total, row) => total + row.live_model.length, 0), catalogue_writes: 0,
  candidate_count: candidates.length, target_count: targets.length,
  complete_targets: outcomes.filter((row) => row.complete_from_saved_inputs).length,
  results: outcomes,
};
writeFileSync(`${output}/history-replay.json`, JSON.stringify(metadata, null, 2) + "\n");
