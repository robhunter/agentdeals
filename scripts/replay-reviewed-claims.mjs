import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { PAIRED_READER_MAX_TOKENS, comparableText, parsePairedAnswer, statedBeforeReaderFor } from "./archive-captures.js";
import { originalCorrections } from "./run-archive-settlement.js";
import { recordKey } from "./settle-discovered-records.js";
import { createVerifierClient } from "./verify-freshness.js";
const dir = "archive-evaluation";
mkdirSync(dir, { recursive: true });
const prior = "prior-evaluation";
const report = JSON.parse(readFileSync(`${prior}/report.json`, "utf8"));
const modelCalls = readFileSync(`${prior}/model-calls.jsonl`, "utf8").trim().split("\n").map(JSON.parse);
const changes = JSON.parse(readFileSync("data/deal_changes.json", "utf8")).changes;
const originals = JSON.parse(execFileSync("git", ["show", "7a26c604^:data/deal_changes.json"], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 })).changes;
const restored = originalCorrections(changes, originals).map(({ original }) => original);
const key = (record) => JSON.stringify([record.vendor, record.record_key ?? recordKey(record)]);
const currentByKey = new Map(changes.map((record) => [key(record), record]));
const originalByKey = new Map(restored.map((record) => [key(record), record]));
const client = createVerifierClient({ maxTokens: PAIRED_READER_MAX_TOKENS, fetchImpl: async (url, options) => {
  const response = await fetch(url, options);
  appendFileSync(`${dir}/model-calls.jsonl`, JSON.stringify({ request: JSON.parse(options.body), status: response.status, output: await response.clone().text() }) + "\n");
  return response;
} });
const fragments = (value) => (Array.isArray(value) ? value : value == null ? [] : [value]).map((text) => String(text ?? "").trim()).filter((text) => comparableText(text));
const candidates = [];
for (const [pass, results, records] of [["unsettled", report.results, currentByKey], ["audit", report.audit?.results ?? [], originalByKey]]) {
  for (const result of results) {
    const reading = result.readings?.findLast((reading) => reading.verdict?.status === "review");
    if (result.outcome !== "no_usable_capture" || !result.review || !reading) continue;
    const record = records.get(key(result));
    if (!record) throw new Error(`original record missing: ${result.vendor} ${result.date}`);
    const excerpts = [];
    for (const call of modelCalls) {
      if (call.status !== 200) continue;
      const prompt = call.request.messages[0].content;
      if (!prompt.includes(`- Vendor: ${record.vendor}\n`)) continue;
      const output = JSON.parse(call.output);
      const answer = parsePairedAnswer(output.choices?.[0]?.message?.content);
      if (!answer || JSON.stringify(fragments(answer.old_terms)) !== JSON.stringify(reading.verdict.old_terms) || JSON.stringify(fragments(answer.new_terms)) !== JSON.stringify(reading.verdict.new_terms)) continue;
      const marker = `OLD PAGE (saved ${result.capture.day}, truncated):\n`;
      const start = prompt.indexOf(marker);
      const end = prompt.indexOf("\n\nNEW PAGE (saved ", start + marker.length);
      if (start < 0 || end < 0) continue;
      excerpts.push(prompt.slice(start + marker.length, end));
    }
    const unique = [...new Set(excerpts)];
    if (unique.length !== 1) throw new Error(`expected one recorded old-page excerpt for ${result.vendor} ${result.date}, found ${unique.length}`);
    const older = { day: result.capture.day, text: unique[0] };
    if (older.text.length > 12000) throw new Error("the recorded paired-reader excerpt exceeds its original window");
    const stated = await statedBeforeReaderFor(client, record)(older);
    const eligible = result.capture.side === "before" && ["stated", "removal_stated"].includes(stated.status);
    const candidate = { pass, vendor: result.vendor, date: result.date, change_type: result.change_type, older_capture: result.capture, old_text_source: "recorded paired prompt excerpt", stated_before: stated, review: result.review, eligible_before_historical_guard: eligible, historical_guard_replayed: false };
    candidates.push(candidate);
    appendFileSync(`${dir}/progress.jsonl`, JSON.stringify(candidate) + "\n");
    console.log(`${pass}: ${result.vendor} ${result.date} ${stated.status}; eligible before historical guard: ${eligible}`);
  }
}
const measured = { kind: "review-question-replay", additional_archive_requests: 0, catalogue_writes: 0, historical_guard_replayed: false, candidates };
writeFileSync(`${dir}/review-candidates.json`, JSON.stringify(measured, null, 2) + "\n");
const cell = (text) => String(text ?? "").replaceAll("|", "\\|").replace(/\s+/g, " ");
const lines = ["### Stated-before readings for pairs left in review", "", "These are candidates before the historical-value safeguard, not settled verdicts. No Archive requests or data writes were made.", "", "| Pass | Vendor | Record day | Stated-before | Eligible before history | Quoted lines | Review lines |", "|---|---|---|---|---|---|---|"];
for (const row of candidates) {
  const stated = (row.stated_before.stated_then ?? []).map((line) => `${line.record}: ${line.old}`).join("; ");
  const review = row.review.map((line) => `${line.old ?? ""} → ${line.new ?? ""}: ${line.why ?? ""}`).join("; ");
  lines.push(`| ${[row.pass, row.vendor, row.date, row.stated_before.status, row.eligible_before_historical_guard, stated, review].map(cell).join(" | ")} |`);
}
const markdown = lines.join("\n") + "\n";
writeFileSync(`${dir}/review-candidates.md`, markdown);
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, markdown);
