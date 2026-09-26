import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertPopulationFloor } from "./population-floor.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");

const ENDED_ON = "2026-06-18";
const ENDED_ON_SPELLED = /2026-06-18|June 18, 2026/;
const NAMED = /Gemini Code Assist|Gemini CLI/i;
const QUOTA =
  /6,000 (?:code[- ])?(?:code-related )?(?:completions|requests)|6K (?:completions|code)|180,000|180K|1,000 (?:req|requests)(?:\/day| a day| per day)|1K (?:req|requests)|60 (?:req|requests)(?:\/min| a minute| per minute)|60 RPM/gi;
const NAME_WITHIN = 150;
const DATE_WITHIN = 400;
const QUOTED_CONTEXT_BEFORE = 30;
const QUOTED_CONTEXT_AFTER = 15;

const changes = (() => {
  const parsed = JSON.parse(readFileSync(path.join(root, "data", "deal_changes.json"), "utf-8"));
  return (Array.isArray(parsed) ? parsed : parsed.changes ?? []) as Array<Record<string, string>>;
})();

const storedChangeProse = changes
  .flatMap((c) => [c.summary, c.previous_state, c.current_state])
  .filter((t): t is string => typeof t === "string")
  .map((t) => t.replace(/\s+/g, " "));

function quotesAStoredChangeRecord(body: string, at: number, quota: string): boolean {
  for (const prose of storedChangeProse) {
    for (let from = prose.indexOf(quota); from >= 0; from = prose.indexOf(quota, from + 1)) {
      const before = prose.slice(Math.max(0, from - QUOTED_CONTEXT_BEFORE), from);
      const after = prose.slice(from + quota.length, from + quota.length + QUOTED_CONTEXT_AFTER);
      if (body.slice(at - before.length, at) === before && body.slice(at + quota.length, at + quota.length + after.length) === after) return true;
    }
  }
  return false;
}

function readable(html: string): string {
  return html
    .replace(/<(style|svg)\b[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&rsquo;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ");
}

let server: ChildProcess;
let base = "";
const routes: string[] = [];
const undated: string[] = [];
let quotasNearTheNames = 0;

function startServer(): Promise<{ proc: ChildProcess; base: string }> {
  return new Promise((resolve, reject) => {
    const proc = spawn("node", [path.join(root, "dist", "serve.js")], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, PORT: "0", BASE_URL: "http://localhost", TZ: "UTC" },
    });
    const timeout = setTimeout(() => {
      proc.kill();
      reject(new Error("Server startup timeout"));
    }, 20000);
    proc.stderr!.on("data", (data: Buffer) => {
      const match = data.toString().match(/running on http:\/\/localhost:(\d+)/);
      if (match) {
        clearTimeout(timeout);
        resolve({ proc, base: `http://localhost:${match[1]}` });
      }
    });
    proc.on("error", (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });
}

async function locs(sitemap: string, seen: Set<string>): Promise<void> {
  const body = await (await fetch(`${base}${sitemap}`)).text();
  for (const m of body.matchAll(/<loc>([^<]+)<\/loc>/g)) {
    const route = m[1].replace(/^https?:\/\/[^/]+/, "");
    if (!route.endsWith(".xml")) seen.add(route);
    else if (!seen.has(route)) {
      seen.add(route);
      await locs(route, seen);
    }
  }
}

describe(`Google ended the free Gemini Code Assist individuals tier and Gemini CLI's personal sign-in on ${ENDED_ON} (#1900)`, () => {
  before(async () => {
    const started = await startServer();
    server = started.proc;
    base = started.base;
    const seen = new Set<string>();
    await locs("/sitemap.xml", seen);
    routes.push(...[...seen].filter((r) => !r.endsWith(".xml")));
    const queue = [...routes];
    const worker = async () => {
      while (queue.length) {
        const route = queue.shift()!;
        const res = await fetch(`${base}${route}`);
        if (res.status !== 200) continue;
        const body = readable(await res.text());
        for (const m of body.matchAll(QUOTA)) {
          const near = body.slice(Math.max(0, m.index! - NAME_WITHIN), m.index! + m[0].length + NAME_WITHIN);
          if (!NAMED.test(near)) continue;
          quotasNearTheNames++;
          const around = body.slice(Math.max(0, m.index! - DATE_WITHIN), m.index! + m[0].length + DATE_WITHIN);
          if (ENDED_ON_SPELLED.test(around)) continue;
          if (quotesAStoredChangeRecord(body, m.index!, m[0])) continue;
          undated.push(`${route}: ${body.slice(Math.max(0, m.index! - 110), m.index! + m[0].length + 60).trim()}`);
        }
      }
    };
    await Promise.all(Array.from({ length: 12 }, worker));
  });

  after(() => {
    server?.kill();
  });

  it("reads every published route", () => {
    assertPopulationFloor(routes.length, 1000, "routes in the sitemap");
  });

  it("finds the quotas still named beside the products, so the sweep can fail", () => {
    assert.ok(quotasNearTheNames > 0, "no quota is named near Gemini Code Assist or Gemini CLI on any route, so this sweep reads nothing");
  });

  it(`states ${ENDED_ON} wherever it names a personal-account quota for either product`, () => {
    assert.deepStrictEqual(undated.sort(), []);
  });

  it("records the ending on both products' risk endpoints", async () => {
    for (const [slug, type] of [["google-gemini-code-assist", "free_tier_removed"], ["gemini-cli", "restriction"]] as const) {
      const risk = await (await fetch(`${base}/api/vendor-risk/${slug}`)).json();
      const recorded = (risk.changes ?? []).filter((c: { date: string; change_type: string }) => c.date === ENDED_ON && c.change_type === type);
      assert.strictEqual(recorded.length, 1, `/api/vendor-risk/${slug} does not carry the ${ENDED_ON} ${type} record`);
    }
  });
});
