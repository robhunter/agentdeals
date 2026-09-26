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
const BLOCK_END = /<\/(?:td|th|p|li|div|h[1-6]|tr|dd|dt|summary|figcaption)>|<br\s*\/?>|<\/script>/gi;
const BLOCKS_BEFORE_THAT_MAY_NAME_IT = 4;
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
        const html = (await res.text()).replace(/<(style|svg)\b[\s\S]*?<\/\1>/gi, " ");
        const blocks = html.split(BLOCK_END).map(readable);
        blocks.forEach((block, i) => {
          for (const m of block.matchAll(QUOTA)) {
            const neighbourhood = blocks.slice(Math.max(0, i - BLOCKS_BEFORE_THAT_MAY_NAME_IT), i + 2).join(" ");
            if (!NAMED.test(neighbourhood)) continue;
            quotasNearTheNames++;
            if (ENDED_ON_SPELLED.test(block)) continue;
            if (quotesAStoredChangeRecord(block, m.index!, m[0])) continue;
            undated.push(`${route}: ${block.slice(Math.max(0, m.index! - 110), m.index! + m[0].length + 60).trim()}`);
          }
        });
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

  it(`states ${ENDED_ON} in the same block wherever it names a personal-account quota for either product`, () => {
    assert.deepStrictEqual(undated.sort(), []);
  });

  it("states the ending on /gcp-free-tier-2026 and links Google's deprecation notice from those words", async () => {
    const html = await (await fetch(`${base}/gcp-free-tier-2026`)).text();
    assert.match(
      html,
      /<a href="https:\/\/developers\.google\.com\/gemini-code-assist\/docs\/deprecations\/code-assist-individuals"[^>]*>deprecation notice<\/a> says that starting June 18, 2026, the IDE extensions stopped serving requests/,
    );
  });

  it("offers Gemini Code Assist on /free-tier-tracker neither as a current expansion nor as still free", async () => {
    const html = await (await fetch(`${base}/free-tier-tracker`)).text();
    const from = html.indexOf('id="expanded"');
    const to = html.indexOf('id="patterns"');
    assert.ok(from >= 0 && to > from, "/free-tier-tracker no longer marks its expansions section, so this reads nothing");
    assert.doesNotMatch(html.slice(from, to), /Gemini Code Assist/);
    const stillFree = [...html.matchAll(/Still free:<\/strong>([\s\S]*?)<\/p>/g)].map((m) => m[1]);
    assert.ok(stillFree.length > 0, "/free-tier-tracker prints no \"Still free\" list, so this reads nothing");
    assert.deepStrictEqual(stillFree.filter((list) => /Gemini Code Assist/.test(list)), []);
  });

  it("records the ending on both products' risk endpoints", async () => {
    for (const [slug, type] of [["google-gemini-code-assist", "free_tier_removed"], ["gemini-cli", "restriction"]] as const) {
      const risk = await (await fetch(`${base}/api/vendor-risk/${slug}`)).json();
      const recorded = (risk.changes ?? []).filter((c: { date: string; change_type: string }) => c.date === ENDED_ON && c.change_type === type);
      assert.strictEqual(recorded.length, 1, `/api/vendor-risk/${slug} does not carry the ${ENDED_ON} ${type} record`);
    }
  });
});
