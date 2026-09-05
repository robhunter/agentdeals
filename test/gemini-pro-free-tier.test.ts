import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let server: ChildProcess;
let base = "";

function startServer(): Promise<ChildProcess> {
  return new Promise((resolve, reject) => {
    const serverPath = path.join(__dirname, "..", "dist", "serve.js");
    const proc = spawn("node", [serverPath], {
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
        base = `http://localhost:${match[1]}`;
        clearTimeout(timeout);
        resolve(proc);
      }
    });
    proc.on("error", (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });
}

const ENTITIES: Record<string, string> = {
  "&mdash;": "—", "&ndash;": "–", "&amp;": "&", "&quot;": '"', "&#39;": "'",
  "&rsquo;": "'", "&lsquo;": "'", "&nbsp;": " ", "&darr;": "↓", "&rsaquo;": ">",
  "&lt;": "<", "&gt;": ">", "&middot;": "·",
};

function readableText(html: string): string {
  const withoutMarkup = html
    .replace(/<head[\s\S]*?<\/head>/gi, " ")
    .replace(/<(script|style|svg)\b[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, " ");
  const decoded = withoutMarkup.replace(/&[a-z#0-9]+;/gi, (e) => ENTITIES[e] ?? e);
  return decoded.replace(/\s+/g, " ").trim();
}

function metaAndStructuredData(html: string): string {
  const parts: string[] = [];
  for (const m of html.matchAll(/<meta[^>]+content="([^"]*)"/gi)) parts.push(m[1]);
  for (const m of html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/gi)) parts.push(m[1]);
  const decoded = parts.join(" ").replace(/&[a-z#0-9]+;/gi, (e) => ENTITIES[e] ?? e);
  return decoded.replace(/\s+/g, " ").trim();
}

const PRO_IS_WITHHELD_AFTER = /\b(?:paid[- ]only|is\s+paid\b|are\s+paid\b|removed|gone|no longer free|not free|not available|restricted to paid|now require|require[sd]?\s+(?:a\s+)?paid|has no free|have no free)/i;
const PRO_IS_WITHHELD_BEFORE = /\b(?:no|zero|0)\s+free\s+$|\bremoval of free\s+$/i;
const VERSION_IMMEDIATELY_BEFORE = /\d+\.\d+\s+$/;

const FREE_TIER_IS_FLASH_ONLY = [
  /\bflash[- ]only\b/i,
  /\bflash(?:\s*(?:and|,|\/)\s*flash[- ]lite)?\s*(?:models\s*)?only\b/i,
  /\b(?:restricted|limited|preserved|reserved|covers?|covered)\b[^.]{0,15}?\b(?:to|for)\s+flash\b[^.]{0,60}/i,
];

export type Claim = { route: string; surface: "page" | "metadata"; sentence: string };

function claimsIn(route: string, surface: "page" | "metadata", body: string): Claim[] {
  const found: Claim[] = [];
  const seen = new Set<string>();
  const record = (sentence: string) => {
    const trimmed = sentence.trim();
    if (seen.has(trimmed)) return;
    seen.add(trimmed);
    found.push({ route, surface, sentence: trimmed });
  };
  const mentionsGemini = (index: number, length: number) =>
    /gemini/i.test(body.slice(Math.max(0, index - 240), Math.min(body.length, index + length + 240)));

  const quotable = (index: number, length: number) =>
    body.slice(Math.max(0, index - 34), Math.min(body.length, index + length + 90));

  for (const m of body.matchAll(/\bPro\b(?!\+)/gi)) {
    const index = m.index!;
    const before = body.slice(Math.max(0, index - 34), index);
    const rest = body.slice(index + m[0].length, index + m[0].length + 74);
    const after = rest.split(/(?<=[.;])\s+(?=[A-Z0-9])/)[0];
    const withheld = PRO_IS_WITHHELD_AFTER.test(after) || PRO_IS_WITHHELD_BEFORE.test(before);
    if (!withheld) continue;
    if (VERSION_IMMEDIATELY_BEFORE.test(before)) continue;
    if (!mentionsGemini(index, m[0].length)) continue;
    record(quotable(index, m[0].length));
  }

  for (const pattern of FREE_TIER_IS_FLASH_ONLY) {
    for (const m of body.matchAll(new RegExp(pattern.source, "gi"))) {
      const span = body.slice(m.index!, m.index! + Math.max(m[0].length, 60));
      if (/\bpro\b/i.test(span)) continue;
      if (!mentionsGemini(m.index!, m[0].length)) continue;
      record(quotable(m.index!, m[0].length));
    }
  }
  return found;
}

const WORDS_THAT_MAKE_A_QUOTE = 6;

function quotesStoredProse(claim: Claim, prose: string): boolean {
  const words = claim.sentence.split(/\s+/);
  for (let start = 0; start + WORDS_THAT_MAKE_A_QUOTE <= words.length; start++) {
    const run = words.slice(start, start + WORDS_THAT_MAKE_A_QUOTE).join(" ");
    if (prose.includes(run)) return true;
  }
  return false;
}

function storedChangeProse(): string {
  const file = path.join(__dirname, "..", "data", "deal_changes.json");
  const parsed = JSON.parse(readFileSync(file, "utf8"));
  const records = Array.isArray(parsed) ? parsed : (parsed.changes ?? parsed.deal_changes ?? []);
  return JSON.stringify(records).replace(/\\"/g, '"').replace(/\s+/g, " ");
}

function changeRecordsMakingTheClaim(): string[] {
  const file = path.join(__dirname, "..", "data", "deal_changes.json");
  const parsed = JSON.parse(readFileSync(file, "utf8"));
  const records: any[] = Array.isArray(parsed) ? parsed : (parsed.changes ?? parsed.deal_changes ?? []);
  return records
    .filter((r) => {
      const prose = [r.summary, r.previous_state, r.current_state].filter(Boolean).join(" ");
      return /gemini/i.test(prose) && claimsIn("record", "page", prose).length > 0;
    })
    .map((r) => `${r.vendor} ${r.date}`);
}

const CHANGE_RECORDS_AWAITING_A_DATA_FIX = [
  "Google Gemini 2025-12-15",
  "Google Gemini API 2026-04-08",
];

async function locs(sitemap: string): Promise<string[]> {
  const body = await (await fetch(`${base}${sitemap}`)).text();
  return [...body.matchAll(/<loc>([^<]+)<\/loc>/g)].map(
    (m) => m[1].replace(/^https?:\/\/[^/]+/, "") || "/",
  );
}

async function everyPublishedRoute(): Promise<string[]> {
  const routes = new Set<string>(["/"]);
  const index = await (await fetch(`${base}/sitemap.xml`)).text();
  for (const m of index.matchAll(/<loc>([^<]+)<\/loc>/g)) {
    const child = m[1].replace(/^https?:\/\/[^/]+/, "");
    for (const p of await locs(child)) routes.add(p);
  }
  return [...routes].filter((p) => !p.endsWith(".xml"));
}

async function claimsAcrossTheSite(routes: string[]): Promise<{ claims: Claim[]; geminiPages: number }> {
  const claims: Claim[] = [];
  let geminiPages = 0;
  const queue = [...routes];
  const worker = async () => {
    for (let route = queue.pop(); route !== undefined; route = queue.pop()) {
      const response = await fetch(`${base}${route}`);
      if (!response.ok) continue;
      const html = await response.text();
      if (!/gemini/i.test(html)) continue;
      geminiPages++;
      claims.push(...claimsIn(route, "page", readableText(html)));
      claims.push(...claimsIn(route, "metadata", metaAndStructuredData(html)));
    }
  };
  await Promise.all(Array.from({ length: 12 }, worker));
  return { claims, geminiPages };
}

describe("Gemini free tier claims", () => {
  let claims: Claim[] = [];
  let geminiPages = 0;
  let routes: string[] = [];

  before(async () => {
    server = await startServer();
    routes = await everyPublishedRoute();
    ({ claims, geminiPages } = await claimsAcrossTheSite(routes));
  });
  after(() => {
    server?.kill();
  });

  it("reads every published page that mentions Gemini", () => {
    assert.ok(routes.length > 2000, `expected the whole sitemap, got ${routes.length} routes`);
    assert.ok(geminiPages > 20, `expected many pages to mention Gemini, got ${geminiPages}`);
  });

  it("names the Pro version wherever page copy says a Pro model is off the free tier", () => {
    const prose = storedChangeProse();
    const fromPageCopy = [
      ...new Set(
        claims
          .filter((c) => !quotesStoredProse(c, prose))
          .map((c) => `${c.route} (${c.surface}): ${c.sentence}`),
      ),
    ].sort();

    assert.deepStrictEqual(fromPageCopy, []);
  });

  it("traces every remaining claim to a change record already filed for correction", () => {
    const prose = storedChangeProse();
    const fromRecords = claims.filter((c) => quotesStoredProse(c, prose));
    assert.ok(fromRecords.length >= 0);

    const unfiled = changeRecordsMakingTheClaim()
      .filter((r) => !CHANGE_RECORDS_AWAITING_A_DATA_FIX.includes(r))
      .sort();

    assert.deepStrictEqual(
      unfiled,
      [],
      `change records state a Gemini Pro model is off the free tier without naming a version, or name 2.5 Pro, which the vendor lists as free: ${unfiled.join("; ")}`,
    );
  });

  it("publishes Gemini 2.5 Pro as a free-tier model on the two Gemini pricing pages", async () => {
    for (const route of ["/gemini-api-pricing-changes", "/gemini-api-pricing-2026"]) {
      const text = readableText(await (await fetch(`${base}${route}`)).text());
      assert.ok(
        /2\.5 Pro/.test(text),
        `${route} does not name Gemini 2.5 Pro at all`,
      );
      assert.ok(
        /free[^.]{0,60}2\.5 Pro|2\.5 Pro[^.]{0,60}(?:free|still free)/i.test(text),
        `${route} never places Gemini 2.5 Pro on the free tier`,
      );
    }
  });

  it("keeps saying Gemini 3.1 Pro is paid-only", async () => {
    for (const route of ["/gemini-api-pricing-changes", "/gemini-api-pricing-2026"]) {
      const text = readableText(await (await fetch(`${base}${route}`)).text());
      assert.ok(
        /3\.1 Pro[^.]{0,60}(?:paid|no free)/i.test(text),
        `${route} no longer states that Gemini 3.1 Pro requires payment`,
      );
    }
  });
});
