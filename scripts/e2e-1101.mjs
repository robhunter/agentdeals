#!/usr/bin/env node
import { createServer } from "node:http";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const requests = [];

const PAGES = {
  "/pricing/moved":
    "Free plan: 5 GB storage per month. Paid plans start at $5 per month and add 100 GB. " +
    "This paragraph exists so the extractor has enough text to read.",
  "/pricing/reworded":
    "Free plan: 10 GB storage per month, 3 projects, 1 seat. Starter: 10 GB storage per month, " +
    "3 projects, 1 seat, $12 per month per project. Text padding so the extractor has enough to read.",
  "/pricing/restated":
    "Free plan: 10 GB storage per month across 3 projects. Nothing about these terms has moved. " +
    "Text padding so the extractor has enough to read.",
};

const DETECTIONS = {
  StubMoved:
    '{"status":"changed","summary":"Free storage is now 5 GB, down from 10 GB","change_type":"limits_reduced","current_state":"Free plan includes 5 GB storage","impact":"high"}',
  StubReworded:
    '{"status":"changed","summary":"The free tier now has 3 projects instead of 3, and the Starter tier is now priced at $12 per month per project","change_type":"limits_reduced","current_state":"Free plan: 10 GB storage per month, 3 projects, 1 seat. Starter: 10 GB storage per month, 3 projects, 1 seat, $12 per month per project","impact":"medium"}',
  StubRestated:
    '{"status":"changed","summary":"The page states 10 GB across 3 projects, which matches the stored deal info","change_type":"pricing_restructured","current_state":"Free plan: 10 GB storage per month across 3 projects","impact":"medium"}',
};

function vendorIn(prompt) {
  return Object.keys(DETECTIONS).find((v) => prompt.includes(v)) ?? null;
}

const server = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    if (req.url === "/api/v1/chat/completions") {
      const parsed = JSON.parse(body);
      const prompt = parsed.messages[0].content;
      const isSecondOpinion = prompt.includes("THE JOB'S REPORT:");
      requests.push({ isSecondOpinion, prompt });
      let answer;
      if (isSecondOpinion) {
        answer = prompt.includes("which matches the stored deal info")
          ? '{"change":"no","reason":"the report restates the stored terms"}'
          : '{"change":"yes"}';
      } else {
        answer = DETECTIONS[vendorIn(prompt)] ?? '{"status":"confirmed"}';
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { content: answer } }] }));
      return;
    }
    const page = PAGES[req.url];
    if (page) {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(`<html><body><h1>Pricing</h1><p>${page}</p></body></html>`);
      return;
    }
    res.writeHead(404);
    res.end();
  });
});

await new Promise((r) => server.listen(0, r));
const port = server.address().port;
const base = `http://localhost:${port}`;

const dir = mkdtempSync(join(tmpdir(), "e2e-1101-"));
const indexPath = join(dir, "index.json");
const changesPath = join(dir, "deal_changes.json");
writeFileSync(
  indexPath,
  JSON.stringify({
    offers: [
      { vendor: "StubMoved", category: "Cloud Storage", url: `${base}/pricing/moved`, tier: "Free", description: "10 GB free storage per month", verifiedDate: "2025-01-01" },
      { vendor: "StubReworded", category: "Cloud Storage", url: `${base}/pricing/reworded`, tier: "Free", description: "Free plan: 10 GB storage per month, 3 projects, 1 seat", verifiedDate: "2025-01-02" },
      { vendor: "StubRestated", category: "Cloud Storage", url: `${base}/pricing/restated`, tier: "Free", description: "Free plan: 10 GB storage per month across 3 projects", verifiedDate: "2025-01-03" },
    ],
  })
);
writeFileSync(changesPath, JSON.stringify({ changes: [] }));

const run = () =>
  new Promise((done) => {
    const p = spawn("node", [join(REPO, "scripts", "reverify-rolling.js"), "--ai", "--limit", "3"], {
      env: {
        ...process.env,
        AGENTDEALS_INDEX_PATH: indexPath,
        AGENTDEALS_CHANGES_PATH: changesPath,
        OPENROUTER_BASE_URL: `${base}/api/v1`,
        OPENROUTER_API_KEY: "stub-key",
      },
    });
    let out = "";
    p.stdout.on("data", (c) => (out += c));
    p.stderr.on("data", (c) => (out += c));
    p.on("close", (code) => done({ code, out }));
  });

const result = await run();
console.log("── the run ──");
console.log(`exit ${result.code}`);
console.log(result.out.trim());

const detections = requests.filter((r) => !r.isSecondOpinion);
const secondOpinions = requests.filter((r) => r.isSecondOpinion);
console.log("");
console.log("── what reached the model ──");
console.log(`page readings: ${detections.length}`);
console.log(`second opinions: ${secondOpinions.length}`);
for (const v of Object.keys(DETECTIONS)) {
  const summary = JSON.parse(DETECTIONS[v]).summary;
  console.log(`  ${v} asked for a second opinion: ${secondOpinions.some((r) => r.prompt.includes(summary))}`);
}

const written = JSON.parse(readFileSync(changesPath, "utf-8"));
console.log("");
console.log("── change log after the run ──");
console.log(`records: ${written.changes.length}`);
for (const c of written.changes) console.log(`  ${c.vendor} (${c.change_type}) — ${c.summary}`);

server.close();
