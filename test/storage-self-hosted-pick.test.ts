import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

const SELF_HOSTED_ANSWER = "MinIO's open-source edition is no longer maintained, and its free AIStor edition runs on one node under a commercial licence. SeaweedFS (Apache 2.0) and Garage (AGPLv3) are maintained open-source, S3-compatible options.";

const SELLS_MINIO_AS_MAINTAINED = /open[- ]source|actively developed|active development|default|industry standard/i;

function plain(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&rsquo;|&#39;/g, "'").replace(/&mdash;/g, "—").replace(/&rarr;/g, "→").replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .replace(/ ([.,;:])/g, "$1")
    .trim();
}

function startServer(): Promise<{ child: ChildProcess; port: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn("node", [path.join(REPO, "dist", "serve.js")], {
      stdio: ["ignore", "ignore", "pipe"],
      env: { ...process.env, PORT: "0", BASE_URL: "http://localhost", TZ: "UTC" },
    });
    const timeout = setTimeout(() => { child.kill(); reject(new Error("Server startup timeout")); }, 60000);
    child.stderr!.on("data", (data: Buffer) => {
      const m = data.toString().match(/running on http:\/\/localhost:(\d+)/);
      if (m) { clearTimeout(timeout); resolve({ child, port: parseInt(m[1], 10) }); }
    });
    child.on("error", err => { clearTimeout(timeout); reject(err); });
  });
}

describe("/storage-comparison-2026 points self-hosters at maintained open-source storage", () => {
  let child: ChildProcess | undefined;
  let body = "";

  before(async () => {
    const started = await startServer();
    child = started.child;
    const html = await (await fetch(`http://localhost:${started.port}/storage-comparison-2026`)).text();
    body = html.replace(/<head>[\s\S]*?<\/head>/, " ").replace(/<script[\s\S]*?<\/script>/g, " ").replace(/<style[\s\S]*?<\/style>/g, " ");
  });

  after(() => child?.kill());

  it("never sells MinIO as open-source, maintained, the default or the standard without saying its open-source edition is unmaintained", () => {
    const sentences = plain(body).split(/(?<=[.!?])\s+/).filter(sentence => /MinIO/.test(sentence));
    assert.ok(sentences.length >= 3, `the page names MinIO in ${sentences.length} sentences, so the rule checks little`);
    const selling = sentences.filter(sentence => SELLS_MINIO_AS_MAINTAINED.test(sentence) && !sentence.includes("no longer maintained"));
    assert.deepStrictEqual(selling, []);
  });

  it("gives the same self-hosted answer in the quick verdict and the self-hosted pick, ranking no option first", () => {
    const quickVerdict = plain(body.match(/<p><strong>Quick verdict:<\/strong>([\s\S]*?)<\/p>/)?.[1] ?? "");
    assert.ok(quickVerdict.endsWith(`For self-hosted: ${SELF_HOSTED_ANSWER}`), quickVerdict);
    const picks = [...body.matchAll(/<div class="verdict-item">\s*<strong>([\s\S]*?)<\/strong>\s*<p>([\s\S]*?)<\/p>/g)].map(match => ({ heading: plain(match[1]!), text: plain(match[2]!) }));
    assert.ok(picks.length >= 3, `found ${picks.length} picks`);
    assert.deepStrictEqual(picks.filter(pick => /self-hosted/i.test(pick.heading)), [{ heading: "Self-hosted", text: SELF_HOSTED_ANSWER }]);
  });

  it("no longer calls MinIO actively developed or the default choice on its card", () => {
    const card = plain(body.match(/<h3>MinIO\b(?:(?!<\/h3>)[\s\S])*<\/h3>\s*<div class="diff-desc">([\s\S]*?)<\/div>/)?.[1] ?? "");
    assert.ok(card.includes("The original AGPLv3 edition is no longer maintained"), card);
    assert.doesNotMatch(card, /Active development|frequent releases|default choice/);
  });
});
