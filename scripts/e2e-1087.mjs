#!/usr/bin/env node
import { createServer } from "node:http";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const requests = [];

const server = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    if (req.url === "/api/v1/chat/completions") {
      const parsed = JSON.parse(body);
      requests.push({ headers: req.headers, body: parsed });
      const prompt = parsed.messages[0].content;
      const isSecondOpinion = prompt.includes("THE JOB'S REPORT:");
      const mentionsShrunkTier = requests.filter((r) => !r.body.messages[0].content.includes("THE JOB'S REPORT:")).length === 1;
      const answer = isSecondOpinion
        ? '{"change":"yes"}'
        : mentionsShrunkTier
        ? '```json\n{"status":"changed","summary":"Free tier cut from 10 GB to 5 GB","change_type":"limits_reduced","current_state":"Free plan includes 5 GB storage","impact":"medium"}\n```'
        : '{"status":"confirmed"}';
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { content: answer } }] }));
      return;
    }
    if (req.url.startsWith("/pricing")) {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(
        "<html><body><h1>Pricing</h1><p>The free plan now includes 5 GB of storage, down from the previous allowance. " +
          "Paid plans start at $5 per month and add 100 GB. This text exists so the extractor has something to read.</p></body></html>"
      );
      return;
    }
    res.writeHead(404);
    res.end();
  });
});

await new Promise((r) => server.listen(0, r));
const port = server.address().port;
const base = `http://localhost:${port}`;

const dir = mkdtempSync(join(tmpdir(), "e2e-1087-"));
const indexPath = join(dir, "index.json");
const changesPath = join(dir, "deal_changes.json");
writeFileSync(
  indexPath,
  JSON.stringify({
    offers: [
      { vendor: "StubOne", category: "Cloud Storage", url: `${base}/pricing/one`, tier: "Free", description: "10 GB free storage", verifiedDate: "2025-01-01" },
      { vendor: "StubTwo", category: "Cloud Storage", url: `${base}/pricing/two`, tier: "Free", description: "5 GB free storage", verifiedDate: "2025-01-02" },
    ],
  })
);
writeFileSync(changesPath, JSON.stringify({ changes: [] }));

function run(env) {
  return new Promise((done) => {
    const p = spawn("node", [join(REPO, "scripts", "reverify-rolling.js"), "--ai", "--limit", "2"], {
      env: { ...process.env, ...env },
    });
    let out = "";
    p.stdout.on("data", (c) => (out += c));
    p.stderr.on("data", (c) => (out += c));
    p.on("close", (code) => done({ code, out }));
  });
}

const shared = {
  AGENTDEALS_INDEX_PATH: indexPath,
  AGENTDEALS_CHANGES_PATH: changesPath,
  OPENROUTER_BASE_URL: `${base}/api/v1`,
};

const noKey = await run({ ...shared, OPENROUTER_API_KEY: "" });
console.log("── without a key ──");
console.log(`exit ${noKey.code}`);
console.log(noKey.out.trim().split("\n").slice(-3).join("\n"));
console.log(`upstream model requests: ${requests.length}`);

const withKey = await run({ ...shared, OPENROUTER_API_KEY: "stub-key" });
console.log("");
console.log("── with a key, against a stub endpoint ──");
console.log(`exit ${withKey.code}`);
console.log(withKey.out.trim());

console.log("");
console.log("── what the detector actually sent ──");
console.log(`requests: ${requests.length}`);
for (const r of requests) {
  console.log(`  authorization: ${r.headers.authorization}`);
  console.log(`  model: ${r.body.model}  temperature: ${r.body.temperature}  max_tokens: ${r.body.max_tokens}`);
  console.log(`  prompt mentions the vendor: ${/StubOne|StubTwo/.test(r.body.messages[0].content)}`);
  console.log(`  prompt carries the page text: ${/5 GB of storage/.test(r.body.messages[0].content)}`);
}

console.log("");
console.log("── change log after the run ──");
console.log(readFileSync(changesPath, "utf-8").trim().slice(0, 700));

server.close();
