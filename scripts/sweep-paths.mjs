import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import path from "node:path";

const repo = process.argv[2];
const out = process.argv[3];
const CONCURRENCY = 16;

function startServer() {
  return new Promise((resolve, reject) => {
    const p = spawn("node", [path.join(repo, "dist", "serve.js")], {
      cwd: repo,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, PORT: "0", BASE_URL: "http://127.0.0.1", TZ: "UTC" },
    });
    const timeout = setTimeout(() => { p.kill("SIGKILL"); reject(new Error("timeout")); }, 60000);
    const onData = (b) => {
      const m = b.toString().match(/running on http:\/\/localhost:(\d+)/);
      if (m) { clearTimeout(timeout); resolve({ proc: p, port: parseInt(m[1], 10) }); }
    };
    p.stderr.on("data", onData);
    p.stdout.on("data", onData);
    p.on("error", (e) => { clearTimeout(timeout); reject(e); });
  });
}

const { proc, port } = await startServer();
const base = `http://127.0.0.1:${port}`;
const stripHost = (u) => u.replace(/^https?:\/\/[^/]+/, "");

const index = await (await fetch(`${base}/sitemap.xml`)).text();
const paths = new Set(["/", "/criteria", "/best", "/sitemap.xml"]);
for (const m of index.matchAll(/<loc>([^<]+)<\/loc>/g)) {
  const child = stripHost(m[1]);
  paths.add(child);
  const xml = await (await fetch(`${base}${child}`)).text();
  for (const l of xml.matchAll(/<loc>([^<]+)<\/loc>/g)) paths.add(stripHost(l[1]));
}

const list = [...paths].sort();
const results = {};
let i = 0;
await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
  while (i < list.length) {
    const p = list[i++];
    const res = await fetch(`${base}${p}`);
    const body = await res.text();
    results[p] = `${res.status} ${createHash("sha256").update(body).digest("hex").slice(0, 16)}`;
  }
}));

writeFileSync(out, JSON.stringify(results, null, 0));
console.error(`${list.length} paths -> ${out}`);
proc.kill("SIGKILL");
