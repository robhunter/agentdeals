import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import path from "node:path";

const repo = process.argv[2];
const out = process.argv[3];
const slugs = process.argv.slice(4);

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

const text = (s) => s.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();

const result = {};
for (const slug of slugs) {
  const html = await (await fetch(`${base}/vendor/${slug}`)).text();
  const h1 = /<h1>([\s\S]*?)<\/h1>/.exec(html);
  const badge = h1 ? /<span class="risk-badge"[^>]*>([a-z]+)<\/span>/.exec(h1[1]) : null;
  const verdict = /<div class="quick-verdict">\s*<p>([\s\S]*?)<\/p>/.exec(html);
  const faq = {};
  for (const [, q, a] of html.matchAll(/"name":"([^"]*?)","acceptedAnswer":\{"@type":"Answer","text":"([\s\S]*?)"\}/g)) {
    if (/alternatives to|category is/.test(q)) continue;
    faq[q.replace(/^[A-Za-z0-9. ]*?(free|reliable|production|changed|outgrow)/, "$1")] = a;
  }
  const alts = /<h2[^>]*>[^<]*[Aa]lternatives[\s\S]*?<\/table>/.exec(html);
  result[slug] = {
    h1: h1 ? text(h1[1]) : null,
    badge: badge ? badge[1] : null,
    verdict: verdict ? text(verdict[1]) : null,
    faq,
    altNames: alts ? [...alts[0].matchAll(/\/vendor\/([a-z0-9-]+)"/g)].map(m => m[1]) : [],
  };
}

writeFileSync(out, JSON.stringify(result, null, 0));
console.error(`${slugs.length} vendor pages -> ${out}`);
proc.kill("SIGKILL");
