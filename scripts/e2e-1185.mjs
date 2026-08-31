import vm from "node:vm";
import { createHash } from "node:crypto";

const base = process.argv[2] ?? "http://localhost:3000";

async function text(path) {
  const response = await fetch(`${base}${path}`);
  return response.ok ? await response.text() : "";
}

function locsIn(xml) {
  return [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
}

async function allPaths() {
  const index = await text("/sitemap.xml");
  const children = locsIn(index).map((u) => u.replace(/^https?:\/\/[^/]+/, ""));
  const paths = new Set(["/"]);
  for (const child of children) {
    for (const loc of locsIn(await text(child))) {
      paths.add(loc.replace(/^https?:\/\/[^/]+/, "") || "/");
    }
  }
  return [...paths].filter((p) => !p.endsWith(".xml"));
}

function inlineScripts(html) {
  const blocks = [];
  const re = /<script([^>]*)>([\s\S]*?)<\/script>/gi;
  let match;
  while ((match = re.exec(html)) !== null) {
    const attrs = match[1];
    const body = match[2];
    const type = (attrs.match(/type\s*=\s*["']([^"']+)["']/i)?.[1] ?? "").toLowerCase();
    if (type.includes("json")) continue;
    if (/\bsrc\s*=/i.test(attrs)) continue;
    if (!body.trim()) continue;
    blocks.push(body);
  }
  return blocks;
}

const paths = await allPaths();
const seen = new Map();
const failures = [];
let blockCount = 0;

for (const path of paths) {
  const html = await text(path);
  if (!html) continue;
  for (const body of inlineScripts(html)) {
    blockCount++;
    const digest = createHash("sha256").update(body).digest("hex");
    if (!seen.has(digest)) {
      let error = null;
      try {
        new vm.Script(body);
      } catch (e) {
        error = e.message;
      }
      seen.set(digest, { error, bytes: body.length, firstPath: path, paths: 0 });
    }
    const record = seen.get(digest);
    record.paths++;
    if (record.error) failures.push({ path, bytes: record.bytes, error: record.error });
  }
}

const distinct = [...seen.values()];
console.log(`paths scanned            ${paths.length}`);
console.log(`inline script blocks     ${blockCount}`);
console.log(`distinct block bodies    ${distinct.length}`);
console.log(`distinct that fail       ${distinct.filter((d) => d.error).length}`);
console.log(`pages affected           ${new Set(failures.map((f) => f.path)).size}`);
for (const failure of failures.slice(0, 20)) {
  console.log(`  FAIL ${failure.path} (${failure.bytes} bytes): ${failure.error}`);
}

const shared = distinct.filter((d) => d.paths > 1).length;
console.log(`distinct blocks on >1 path  ${shared}`);
console.log(`distinct blocks on 1 path   ${distinct.length - shared}`);

process.exit(failures.length === 0 ? 0 : 1);
