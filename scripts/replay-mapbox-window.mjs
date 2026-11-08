import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { judgePair, judgeStatedBefore, pairedPrompt, parsePairedAnswer, parseStatedBeforeAnswer, PAIRED_READER_MAX_TOKENS, statedBeforePrompt } from "./archive-captures.js";
import { listingFor } from "./settle-discovered-records.js";
import { createVerifierClient, fetchPageText, stripHtml } from "./verify-freshness.js";
const dir = "archive-evaluation";
mkdirSync(dir, { recursive: true });
const prior = "prior-evaluation";
const fetches = readFileSync(`${prior}/archive-fetches.jsonl`, "utf8").trim().split("\n").map(JSON.parse);
const page = (stamp) => {
  const saved = fetches.find((row) => row.url.includes(`/web/${stamp}`) && row.url.endsWith("/https://www.mapbox.com/pricing"));
  if (!saved || saved.status !== 200) throw new Error(`missing saved Mapbox capture ${stamp}`);
  return stripHtml(readFileSync(`${prior}/${saved.file}`, "utf8"));
};
const older = { day: "2026-02-25", text: page("20260225") };
const august = { day: "2026-08-27", text: page("20260827") };
const current = await fetchPageText("https://www.mapbox.com/pricing");
if (!current.ok) throw new Error(current.error);
const today = { day: new Date().toISOString().slice(0,10), text: current.text };
const record = JSON.parse(readFileSync("data/deal_changes.json", "utf8")).changes.find((row) => row.vendor === "Mapbox" && row.date === "2026-08-28");
const listing = listingFor(record, JSON.parse(readFileSync("data/index.json", "utf8")).offers);
const hash = (text) => createHash("sha256").update(text).digest("hex");
writeFileSync(`${dir}/snapshots.json`, JSON.stringify({ older, august, today, record, listing }, null, 2) + "\n");
const client = createVerifierClient({ maxTokens: PAIRED_READER_MAX_TOKENS, fetchImpl: async (url, options) => {
  const response = await fetch(url, options);
  appendFileSync(`${dir}/model-calls.jsonl`, JSON.stringify({ request: JSON.parse(options.body), status: response.status, output: await response.clone().text() }) + "\n");
  return response;
} });
const results = [];
for (const width of [12000, 100000]) {
  for (const [name, newer] of [["august", august], ["today", today]]) {
    const prompt = pairedPrompt(listing, older, newer, width);
    const answer = parsePairedAnswer(await client.complete(prompt));
    const verdict = judgePair(answer, older.text, newer.text);
    const result = { kind: "pair", name, width, prompt_sha256: hash(prompt), answer, verdict };
    results.push(result); appendFileSync(`${dir}/progress.jsonl`, JSON.stringify(result) + "\n");
    console.log(`pair ${name} ${width}: ${verdict.status} ${verdict.why || ""}`);
  }
  const prompt = statedBeforePrompt(record, older, width);
  const answer = parseStatedBeforeAnswer(await client.complete(prompt));
  const verdict = judgeStatedBefore(answer, record, older.text);
  const result = { kind: "stated-before", width, prompt_sha256: hash(prompt), answer, verdict };
  results.push(result); appendFileSync(`${dir}/progress.jsonl`, JSON.stringify(result) + "\n");
  console.log(`stated-before ${width}: ${verdict.status} ${verdict.why || ""}`);
}
writeFileSync(`${dir}/results.json`, JSON.stringify(results, null, 2) + "\n");
const summary = results.map((r) => `- ${r.kind} ${r.name || ""}, ${r.width} characters: ${r.verdict.status} ${r.verdict.why || ""}`).join("\n") + "\n";
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
