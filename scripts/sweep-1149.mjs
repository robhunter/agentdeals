import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const repo = process.argv[2];
const out = process.argv[3];

function startServer() {
  return new Promise((resolve, reject) => {
    const p = spawn("node", [path.join(repo, "dist", "serve.js")], {
      cwd: repo,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, PORT: "0", BASE_URL: "http://127.0.0.1" },
    });
    const timeout = setTimeout(() => { p.kill("SIGKILL"); reject(new Error("timeout")); }, 30000);
    p.stderr.on("data", (b) => {
      const m = b.toString().match(/running on http:\/\/localhost:(\d+)/);
      if (m) { clearTimeout(timeout); resolve({ proc: p, port: parseInt(m[1], 10) }); }
    });
    p.on("error", (e) => { clearTimeout(timeout); reject(e); });
  });
}

const changes = JSON.parse(readFileSync(path.join(repo, "data", "deal_changes.json"), "utf8"));
const arr = Array.isArray(changes) ? changes : changes.changes;

function isoWeek(dstr) {
  const d = new Date(Date.UTC(...dstr.split("-").map((x, i) => (i === 1 ? +x - 1 : +x))));
  d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return `${d.getUTCFullYear()}-w${String(week).padStart(2, "0")}`;
}

const weekKeys = [...new Set(arr.map((c) => isoWeek(c.date)))].sort();

const paths = [
  "/this-week",
  ...Array.from({ length: 10 }, (_, i) => `/this-week?week=${i + 1}`),
  "/digest/archive",
  ...weekKeys.map((k) => `/digest/${k}`),
  "/feed.xml",
  "/api/digest",
  "/api/digest/weekly",
  "/api/digest/weekly?format=markdown",
  "/api/digest/weekly?weeks_ago=1",
  "/api/changes",
  "/api/changes?since=2026-08-22",
  "/changes",
  "/pricing-changes",
  "/expiring",
];

const { proc, port } = await startServer();
const result = {};
for (const p of paths) {
  const res = await fetch(`http://127.0.0.1:${port}${p}`);
  const body = await res.text();
  result[p] = { status: res.status, length: body.length, body };
}
proc.kill("SIGKILL");
writeFileSync(out, JSON.stringify(result));
console.log(`swept ${paths.length} paths -> ${out}`);
const bad = Object.entries(result).filter(([, v]) => v.status !== 200);
if (bad.length) console.log("NON-200:", bad.map(([k, v]) => `${k}=${v.status}`).join(", "));
