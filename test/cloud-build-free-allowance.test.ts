import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(__dirname, "..");

const PAGES = ["/ci-cd-pricing", "/hosting-pricing", "/cicd-free-tier-comparison-2026"];

const WITHDRAWN = [
  "120 min/day",
  "120 build minutes/day",
  "120 build-min/day",
  "120/day (Cloud Build)",
  "120 free/day",
  "~3,600",
];

const STATED: Record<string, string[]> = {
  "/ci-cd-pricing": [
    "2,500 min/mo",
    "2,500 build-minutes a month per billing account, on e2-standard-2 machines in the default pool. Google calls this free tier promotional and subject to change.",
    "The free minutes cover e2-standard-2 only. Also:",
    "Google Cloud Build offers 2,500 build-minutes a month on e2-standard-2 machines for free.",
    "Google Cloud Build's 2,500 min/month",
    "(2,500 min/month free)",
    "The counter-trend: Buildkite continues to offer unlimited free self-hosted agents.",
  ],
  "/hosting-pricing": ["2,500/mo (Cloud Build)"],
  "/cicd-free-tier-comparison-2026": [
    "2,500 min/mo (e2-standard-2)",
    "2,500 build-min/mo (e2-standard-2)",
    "gives 2,500 min/month but",
  ],
};

let proc: ChildProcess | null = null;
const served = new Map<string, string>();

before(async () => {
  const child = spawn("node", [path.join(REPO, "dist", "serve.js")], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, PORT: "0", BASE_URL: "http://localhost", TZ: "UTC" },
  });
  proc = child;
  const port = await new Promise<number>((resolve, reject) => {
    const timeout = setTimeout(() => { child.kill(); reject(new Error("Server startup timeout")); }, 30000);
    child.stderr!.on("data", (data: Buffer) => {
      const m = data.toString().match(/running on http:\/\/localhost:(\d+)/);
      if (m) { clearTimeout(timeout); resolve(parseInt(m[1], 10)); }
    });
  });
  for (const page of PAGES) {
    served.set(page, await (await fetch(`http://localhost:${port}${page}`)).text());
  }
});

after(() => { proc?.kill(); });

function textOf(html: string): string {
  return html
    .replace(/<script(?![^>]*ld\+json)[\s\S]*?<\/script>/g, " ")
    .replace(/<style[\s\S]*?<\/style>/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#39;|&#x27;|&rsquo;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&mdash;/g, "—")
    .replace(/\s+/g, " ");
}

describe("the CI/CD and hosting pages state Cloud Build's free allowance as Google does", () => {
  it("prints none of the daily allowance, in the body or the structured data", () => {
    const left = PAGES.flatMap((page) =>
      WITHDRAWN.filter((phrase) => textOf(served.get(page)!).includes(phrase)).map((phrase) => `${page}: ${phrase}`),
    );
    assert.deepStrictEqual(left, []);
  });

  it("does not call Cloud Build's allowance stable", () => {
    for (const page of PAGES) {
      const sentences = textOf(served.get(page)!).split(/(?<=[.!?])\s+/);
      assert.deepStrictEqual(sentences.filter((s) => /Cloud Build/.test(s) && /remained stable/.test(s)), [], page);
    }
  });

  it("renders every replacement where it belongs", () => {
    const missing = Object.entries(STATED).flatMap(([page, lines]) =>
      lines.filter((line) => !textOf(served.get(page)!).includes(line)).map((line) => `${page}: ${line}`),
    );
    assert.deepStrictEqual(missing, []);
  });
});
