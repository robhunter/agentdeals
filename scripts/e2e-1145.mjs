import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repo = process.argv[2] ?? resolve(__dirname, "..");
const out = process.argv[3] ?? "/tmp/sweep-1145.json";

const start = () =>
  new Promise((ok, bad) => {
    const child = spawn("node", [resolve(repo, "dist", "serve.js")], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, PORT: "0", BASE_URL: "http://localhost" },
    });
    const timer = setTimeout(() => { child.kill(); bad(new Error("timeout")); }, 30000);
    child.stderr.on("data", (b) => {
      const m = b.toString().match(/running on http:\/\/localhost:(\d+)/);
      if (m) { clearTimeout(timer); ok({ child, port: Number(m[1]) }); }
    });
    child.on("error", (e) => { clearTimeout(timer); bad(e); });
  });

const { child, port } = await start();
const get = async (route) => {
  const res = await fetch(`http://localhost:${port}${route}`, { headers: { "user-agent": "agentdeals-internal/1.0 (sweep-1145)" } });
  if (res.status !== 200) throw new Error(`${route} → ${res.status}`);
  return res.text();
};

const sitemap = await get("/sitemap-vendors.xml");
const slugs = [...sitemap.matchAll(/<loc>[^<]*\/vendor\/([^<]+)<\/loc>/g)].map((m) => m[1]).filter((s) => s !== "vendor");

const rows = {};
let index = 0;
const worker = async () => {
  while (index < slugs.length) {
    const slug = slugs[index++];
    let html;
    try { html = await get(`/vendor/${slug}`); } catch { rows[slug] = { error: true }; continue; }
    const verdict = html.match(/<div class="quick-verdict">\s*<p>([\s\S]*?)<\/p>/)?.[1] ?? null;
    const badge = (html.match(/<h1>[\s\S]*?<\/h1>/)?.[0] ?? "").match(/<span class="risk-badge"[^>]*>([a-z]+)<\/span>/)?.[1] ?? null;
    const banner = html.match(/<strong>Pricing change:<\/strong>([\s\S]*?)<\/span>/)?.[1]?.replace(/\s+/g, " ").trim() ?? null;
    rows[slug] = { verdict, badge, banner };
  }
};
await Promise.all(Array.from({ length: 12 }, worker));

const changes = await get("/changes");
writeFileSync(out, JSON.stringify({ slugs: slugs.length, rows, changesLength: changes.length }, null, 1));
console.log(`${slugs.length} vendor routes → ${out}`);
child.kill("SIGKILL");
