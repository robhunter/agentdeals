import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function startServer(inventoryOut) {
  return new Promise((resolve, reject) => {
    const child = spawn("node", [path.join(__dirname, "..", "dist", "serve.js")], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, PORT: "0", BASE_URL: "http://127.0.0.1", AGENTDEALS_PAGE_INVENTORY_OUT: inventoryOut },
    });
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("startup timeout")); }, 180000);
    child.stderr.on("data", (b) => {
      const m = b.toString().match(/running on http:\/\/localhost:(\d+)/);
      if (m) { clearTimeout(timer); resolve({ proc: child, base: `http://127.0.0.1:${m[1]}` }); }
    });
    child.on("error", (e) => { clearTimeout(timer); reject(e); });
  });
}

const readable = (html) => html
  .replace(/<script[\s\S]*?<\/script>/g, " ")
  .replace(/<datalist[\s\S]*?<\/datalist>/g, " ")
  .replace(/<select[\s\S]*?<\/select>/g, " ")
  .replace(/<style[\s\S]*?<\/style>/g, " ");

const entities = (s) => s
  .replace(/&mdash;/g, "—")
  .replace(/&rsquo;/g, "’")
  .replace(/&nbsp;/g, " ")
  .replace(/&#10003;/g, "yes")
  .replace(/&#10007;/g, "no")
  .replace(/&amp;/g, "&");

const flatten = (chunk) => entities(chunk.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();

const text = (html) => flatten(readable(html));

const BLOCK_END = /<\/(?:td|th|p|li|dd|dt|h[1-6]|div|figcaption|caption|option|summary|blockquote)>/g;
const BLOCK_MARK = "␞";

const blocksOf = (html) =>
  readable(html).replace(BLOCK_END, BLOCK_MARK).split(BLOCK_MARK).map(flatten).filter(Boolean);

const NAMES_AWS = /\bAWS\b|\bS3\b|Amazon S3|CloudFront/;
const NAMES_AZURE = /\bAzure\b/;
const EGRESS = /egress|bandwidth|data transfer|transfer out|data out|outbound data|internet transfer|free transfer/i;
const EXPIRES = /12[- ]mo\b|12[- ]months?\b|first year|expires?\b|expired|after the trial|trial only|introductory/i;

const inventoryOut = path.join(mkdtempSync(path.join(tmpdir(), "census-1432-")), "inventory.json");
const { proc, base } = await startServer(inventoryOut);
const served = JSON.parse(readFileSync(inventoryOut, "utf-8"));

const expiryClaims = [];
const cells = [];
const refused = [];

try {
  for (const pagePath of served) {
    const response = await fetch(base + pagePath, { redirect: "manual" });
    if (response.status !== 200) { refused.push(`${pagePath} answered ${response.status}`); continue; }
    const html = await response.text();

    for (const cell of readable(html).match(/<td[^>]*>[^<]*100 GB\/mo \(12 mo\)[^<]*<\/td>/g) ?? []) {
      cells.push({ page: pagePath, cell: text(cell) });
    }

    for (const block of blocksOf(html)) {
      if (!EGRESS.test(block)) continue;
      if (!EXPIRES.test(block)) continue;
      const aws = NAMES_AWS.test(block);
      const azure = NAMES_AZURE.test(block);
      if (!aws && !azure) continue;
      expiryClaims.push({ page: pagePath, vendor: aws && azure ? "AWS+Azure" : aws ? "AWS" : "Azure", block });
    }
  }
} finally {
  proc.kill();
}

const pagesIn = (rows) => [...new Set(rows.map(r => r.page))].sort();

const distinct = new Map();
for (const claim of expiryClaims) {
  const seen = distinct.get(claim.block) ?? { vendor: claim.vendor, pages: [] };
  seen.pages.push(claim.page);
  distinct.set(claim.block, seen);
}

const out = {
  served: served.length,
  refused,
  freeEgressCells: { count: cells.length, pages: pagesIn(cells) },
  expiryClaims: {
    assertions: expiryClaims.length,
    pages: pagesIn(expiryClaims).length,
    distinctBlocks: [...distinct.entries()]
      .map(([block, seen]) => ({ vendor: seen.vendor, pages: seen.pages.length, examplePage: seen.pages[0], block }))
      .sort((a, b) => b.pages - a.pages),
  },
};

writeFileSync(path.join(__dirname, "..", "artifacts", "census-1432-aws-egress.json"), JSON.stringify(out, null, 2) + "\n");

const lines = [];
lines.push(`pages served: ${out.served}, refused: ${refused.length}`);
lines.push(`"100 GB/mo (12 mo)" cells: ${out.freeEgressCells.count} on ${out.freeEgressCells.pages.join(", ")}`);
lines.push(`blocks pairing an AWS/Azure egress term with an expiry marker: ${out.expiryClaims.assertions} across ${out.expiryClaims.pages} pages, ${out.expiryClaims.distinctBlocks.length} distinct`);
for (const row of out.expiryClaims.distinctBlocks) {
  lines.push(`  [${row.vendor}] x${row.pages} e.g. ${row.examplePage}`);
  lines.push(`    ${row.block.slice(0, 300)}`);
}
process.stderr.write(lines.join("\n") + "\n");
