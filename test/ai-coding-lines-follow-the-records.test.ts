import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

const STATED: Record<string, string[]> = {
  "/ai-coding-tools-pricing": ["Cursor, Windsurf and Augment Code include a usage allowance rather than a fixed number of requests."],
};

const WITHDRAWN: Record<string, string[]> = {
  "/free-tier-tracker": ["New free tier: 2K completions + 50 chat messages/mo"],
  "/state-of-free-tiers": ["Trend worth watching", "free-tier arms race"],
  "/ai-coding-tools-pricing": ["include a monthly usage allowance"],
};

const PAGES = [...new Set([...Object.keys(STATED), ...Object.keys(WITHDRAWN)])];

function readable(html: string): string {
  return html
    .replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, " ")
    .replace(/<\/?(?:a|abbr|b|code|em|i|small|span|strong|sub|sup)\b[^>]*>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&#39;|&#x27;|&rsquo;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ");
}

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
    const response = await fetch(`http://localhost:${port}${page}`);
    assert.strictEqual(response.status, 200, page);
    served.set(page, readable(await response.text()));
  }
});

after(() => { proc?.kill(); });

describe("the AI coding lines on the tracker, the state report and the pricing guide follow the records", () => {
  it("states each replacement on its page", () => {
    const missing = Object.entries(STATED).flatMap(([page, lines]) =>
      lines.filter((line) => !served.get(page)!.includes(line)).map((line) => `${page}: ${line}`),
    );
    assert.deepStrictEqual(missing, []);
  });

  it("prints none of the withdrawn lines", () => {
    const left = Object.entries(WITHDRAWN).flatMap(([page, lines]) =>
      lines.filter((line) => served.get(page)!.includes(line)).map((line) => `${page}: ${line}`),
    );
    assert.deepStrictEqual(left, []);
  });
});
