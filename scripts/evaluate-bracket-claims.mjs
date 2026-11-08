import { readFileSync, writeFileSync, appendFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";

const [worktree, inputFile, cacheFile, output] = process.argv.slice(2, 6);
if (!output) throw new Error("Usage: worktree inputs.json cached-calls.jsonl output [--allow-network]");
const allowNetwork = process.argv.includes("--allow-network");
const { readBracketClaims, bracketStatesRecord, createArchiveClient, PAIRED_READER_MAX_TOKENS, previousValueReaderFor, statedBeforeReaderFor } = await import(pathToFileURL(resolve(worktree, "scripts/archive-captures.js")));
const { createVerifierClient, stripHtml, MIN_PAGE_TEXT_LENGTH } = await import(pathToFileURL(resolve(worktree, "scripts/verify-freshness.js")));
const input = JSON.parse(readFileSync(inputFile, "utf8"));
if (input.fixed.length !== 16 || input.published.length !== 42) throw new Error("expected the complete 16/42 input census");
const cachedCalls = readFileSync(cacheFile, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse);
const requestKey = (request) => JSON.stringify([request.model, request.max_tokens, request.temperature, request.reasoning, request.messages]);
const cache = new Map(cachedCalls.filter((row) => row.status === 200).map((row) => [requestKey(row.request), row]));
mkdirSync(output, { recursive: true });
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const write = (name, value) => appendFileSync(`${output}/${name}`, JSON.stringify(value) + "\n");
const networkFetch = globalThis.fetch;
let active;
let sequence = 0;
let archiveAttempts = 0;
let modelAttempts = 0;
let cacheHits = 0;
const client = createVerifierClient({
  ...(allowNetwork ? {} : { apiKey: "offline-cache" }), maxTokens: PAIRED_READER_MAX_TOKENS,
  fetchImpl: async (url, options) => {
    const request = JSON.parse(options.body);
    const key = requestKey(request);
    if (cache.has(key)) {
      cacheHits++;
      const saved = cache.get(key);
      write("cache-hits.jsonl", { ...active, request_sha256: hash(key) });
      return new Response(saved.output, { status: saved.status });
    }
    if (!allowNetwork) throw new Error("no saved response for the exact endpoint prompt");
    modelAttempts++;
    write("model-attempts.jsonl", { ...active, request });
    try {
      const response = await networkFetch(url, options);
      const row = { ...active, request, status: response.status, output: await response.clone().text() };
      write("model-calls.jsonl", row);
      if (response.ok) cache.set(key, row);
      return response;
    } catch (error) {
      write("model-calls.jsonl", { ...active, request, error: error.message });
      throw error;
    }
  },
});
const archive = createArchiveClient({ fetchImpl: async (url, options) => {
  if (!allowNetwork) throw new Error("no saved endpoint body");
  archiveAttempts++;
  write("archive-attempts.jsonl", { ...active, url });
  try {
    const response = await networkFetch(url, options);
    const file = `${hash(String(url))}-${sequence++}.txt`;
    writeFileSync(`${output}/${file}`, await response.clone().text());
    write("archive-fetches.jsonl", { ...active, url, status: response.status, file });
    return response;
  } catch (error) {
    write("archive-fetches.jsonl", { ...active, url, error: error.message });
    throw error;
  }
} });
globalThis.fetch = async () => { throw new Error("unlogged network access refused"); };
const pages = new Map();
async function endpoint(stored) {
  if (stored.text) return stored;
  if (!stored.url) return stored;
  if (!allowNetwork) return stored;
  if (pages.has(stored.url)) return pages.get(stored.url);
  const parts = stored.url.match(/^https:\/\/web\.archive\.org\/web\/(\d{14})\/(.+)$/);
  if (!parts) return { ...stored, unavailable: "unrecognized archived endpoint URL" };
  const copy = { timestamp: parts[1], original: parts[2] };
  const read = await archive.captureHtml(copy);
  const redirect = !read.unavailable && (/<meta\b[^>]*http-equiv\s*=\s*["']?refresh\b/i.test(read.html) || [...read.html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script\s*>/gi)].some((match) => /^\s*(?:(?:window|document|self|top)\.)?location(?:(?:\.href)?\s*=\s*["'][^"']+["']|\.(?:replace|assign)\s*\(\s*["'][^"']+["']\s*\))\s*;?\s*$/i.test(match[1])));
  const text = read.unavailable || redirect ? "" : stripHtml(read.html);
  const result = read.unavailable || text.length < MIN_PAGE_TEXT_LENGTH ? { ...stored, unavailable: read.unavailable ?? (redirect ? "redirect shell" : "too little page text") } : { ...stored, text, sha256: hash(text) };
  pages.set(stored.url, result);
  return result;
}
const pageOf = (stored) => {
  const parts = stored.url?.match(/^https:\/\/web\.archive\.org\/web\/(\d{14})\/(.+)$/);
  return { page: stored.url ?? `saved live page ${stored.day}`, day: stored.day, text: stored.text, ...(parts ? { capture: { timestamp: parts[1], original: parts[2] } } : {}) };
};
const metadata = { source: execFileSync("git", ["rev-parse", "HEAD"], { cwd: worktree, encoding: "utf8" }).trim(), input_sha256: hash(readFileSync(inputFile)), started: new Date().toISOString(), allow_network: allowNetwork, runtime_sha256: hash(readFileSync(resolve(worktree, "scripts/archive-captures.js"))), scope: allowNetwork ? "endpoint readings, retaining missing or unreadable endpoints explicitly" : "incomplete saved-response replay; cache misses are not claim evidence" };
writeFileSync(`${output}/metadata.json`, JSON.stringify(metadata, null, 2) + "\n");
const outcomes = [];
for (const [population, rows] of [["fixed", input.fixed], ["published", input.published]]) {
  for (const row of rows) {
    const record = row.record;
    active = { population, vendor: record?.vendor ?? row.identity[0], recorded_day: record?.recorded_date ?? record?.date ?? row.identity[1] };
    const result = { ...active, disposition: row.disposition ?? "fixed-input evaluation", record, brackets: [] };
    for (const [index, bracket] of row.brackets.entries()) {
      active = { ...active, bracket: index };
      const older = await endpoint(bracket.older);
      const newer = await endpoint(bracket.newer);
      let readingComplete = true;
      const read = (stored, reader) => async (page) => {
        if (!stored.text) {
          readingComplete = false;
          return { status: "unknown", why: stored.unavailable ?? "endpoint body unavailable" };
        }
        try { return await reader(page); } catch (error) { readingComplete = false; throw error; }
      };
      const proof = await readBracketClaims(pageOf(older), pageOf(newer), read(older, previousValueReaderFor(client, record)), read(newer, statedBeforeReaderFor(client, record)));
      const checked = { ...bracket.bracket, claim_proof: proof };
      result.brackets.push({ ...checked, states_record: bracketStatesRecord(checked), endpoint_readings_complete: readingComplete, endpoint_inputs: { older, newer } });
      write("progress.jsonl", { ...active, ...result.brackets.at(-1) });
    }
    result.verified_brackets = result.brackets.filter((bracket) => bracket.states_record).length;
    result.endpoint_readings_complete = result.brackets.length > 0 && result.brackets.every((bracket) => bracket.endpoint_readings_complete);
    outcomes.push(result);
    console.log(`${population}: ${active.vendor}: ${result.verified_brackets}/${result.brackets.length} brackets establish the claim (${result.disposition})`);
    writeFileSync(`${output}/report.json`, JSON.stringify({ ...metadata, results: outcomes, archive_attempts: archiveAttempts, model_attempts: modelAttempts, cache_hits: cacheHits, catalogue_writes: 0 }, null, 2) + "\n");
  }
}
console.log(`Processed: ${outcomes.length}/58; Archive attempts: ${archiveAttempts}; model attempts: ${modelAttempts}; saved responses: ${cacheHits}`);
