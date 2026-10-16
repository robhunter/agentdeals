import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");

const offers = JSON.parse(readFileSync(path.join(root, "data", "index.json"), "utf-8")).offers as Array<Record<string, any>>;

const ENTITIES: Record<string, string> = {
  "&mdash;": "—", "&ndash;": "–", "&amp;": "&", "&quot;": '"', "&#39;": "'",
  "&nbsp;": " ", "&lt;": "<", "&gt;": ">", "&rarr;": "→",
};

function readableText(html: string): string {
  return html
    .replace(/<(script|style|svg)\b[\s\S]*?<\/\1>/gi, " ")
    .replace(/<\/?(?:strong|em|b|i|a|span|code)\b[^>]*>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&[a-z#0-9]+;/gi, (e) => ENTITIES[e] ?? e)
    .replace(/\s+/g, " ")
    .trim();
}

function listingText(vendor: string): string {
  const record = offers.find((o) => o.vendor === vendor && o.category === "Databases");
  assert.ok(record, `no Databases listing is named ${vendor}`);
  return [record!.description, ...(record!.conditions ?? []).map((c: { text: string }) => c.text)].join(" ");
}

function listingFigures(vendor: string, pattern: RegExp): string[] {
  const text = listingText(vendor);
  const match = text.match(pattern);
  assert.ok(match, `the ${vendor} listing no longer matches ${pattern}: ${text}`);
  return match!.slice(1);
}

function tableRows(html: string, header: string): string[][] {
  for (const [, table] of html.matchAll(/<table\b[^>]*>([\s\S]*?)<\/table>/g)) {
    const headers = [...table.matchAll(/<th\b[^>]*>([\s\S]*?)<\/th>/g)].map((m) => readableText(m[1]));
    if (!headers.includes(header)) continue;
    return [...table.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/g)]
      .map(([, row]) => [...row.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/g)].map((m) => readableText(m[1])))
      .filter((cells) => cells.length > 0);
  }
  assert.fail(`no table has a ${header} column`);
}

function between(html: string, start: string, end: string): string {
  const from = html.indexOf(start);
  assert.ok(from >= 0, `the page has no ${start}`);
  const to = html.indexOf(end, from + start.length);
  assert.ok(to >= 0, `nothing closes ${start}`);
  return readableText(html.slice(from, to));
}

function diffCard(html: string, title: string): string {
  const card = html.match(new RegExp(`<h3>${title}</h3>\\s*<p class="diff-desc">([\\s\\S]*?)</p>`));
  assert.ok(card, `no card is headed ${title}`);
  return readableText(card![1]);
}

function verdictItem(html: string, lead: string): string {
  const item = html.match(new RegExp(`<div class="verdict-item">\\s*<strong>${lead}</strong>\\s*<p>([\\s\\S]*?)</p>`));
  assert.ok(item, `no decision guide item starts ${lead}`);
  return readableText(item![1]);
}

let base = "";

function startServer(): Promise<ChildProcess> {
  return new Promise((resolve, reject) => {
    const proc = spawn("node", [path.join(root, "dist", "serve.js")], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, PORT: "0", BASE_URL: "http://localhost", TZ: "UTC" },
    });
    const timeout = setTimeout(() => { proc.kill(); reject(new Error("Server startup timeout")); }, 20000);
    proc.stderr!.on("data", (data: Buffer) => {
      const match = data.toString().match(/running on http:\/\/localhost:(\d+)/);
      if (match) { base = `http://localhost:${match[1]}`; clearTimeout(timeout); resolve(proc); }
    });
    proc.on("error", (err) => { clearTimeout(timeout); reject(err); });
  });
}

const NEON_VS_SUPABASE = "/neon-vs-supabase";
const DATABASE_COMPARISON = "/database-free-tier-comparison-2026";
const SITEMAPS_OF_HAND_WRITTEN_PAGES = ["/sitemap-pages.xml", "/sitemap-reports.xml", "/sitemap-misc.xml"];

const WITHDRAWN: Record<string, RegExp> = {
  "Neon's pricing page said to list no realtime": /lists no realtime|does not list realtime|which Neon's pricing page does not list/i,
  "a database named the winner for most developers": /wins for most developers/i,
};

describe("Neon's Realtime is stated as in beta beside Supabase's generally available Realtime", () => {
  let proc: ChildProcess | undefined;
  const html: Record<string, string> = {};

  before(async () => {
    proc = await startServer();
    for (const route of [NEON_VS_SUPABASE, DATABASE_COMPARISON]) {
      html[route] = await (await fetch(`${base}${route}`)).text();
    }
  });

  after(() => { proc?.kill(); });

  it("gives Supabase's free Realtime the concurrent connections its listing states, in the verdict, the table and the backend card", () => {
    const [connections] = listingFigures("Supabase", /Realtime with ([\d,]+) concurrent connections/);
    const page = html[NEON_VS_SUPABASE];
    assert.match(
      between(page, '<div class="executive-summary">', "</div>"),
      new RegExp(`Choose Supabase for realtime with ${connections} concurrent connections on the free plan\\. Neon's Realtime is in beta and free during the beta\\.`),
    );
    const realtime = tableRows(page, "Neon Free").find((cells) => cells[0] === "Realtime");
    assert.deepStrictEqual(realtime, [
      "Realtime",
      "Realtime (Beta) — free during beta",
      `${connections} concurrent connections`,
      "Neon's Realtime is in beta. Supabase's Realtime is generally available.",
    ]);
    assert.match(
      diffCard(page, "Both Are Backend Platforms Now"),
      new RegExp(`Neon's Free plan includes Realtime \\(Beta\\); Supabase's Free plan includes GA Realtime with ${connections} concurrent connections\\.$`),
    );
  });

  it("rests its beta wording on Neon's listing, which says Realtime is in public beta and free during the beta", () => {
    const neon = listingText("Neon");
    assert.match(neon, /Neon Realtime has been in public beta\b/, `the Neon listing no longer says Realtime is in public beta: ${neon}`);
    assert.match(neon, /\bfree during the beta\b/, `the Neon listing no longer says Realtime is free during the beta: ${neon}`);
  });

  it("says each paid plan's Realtime is in beta on Neon and generally available on Supabase", () => {
    const page = html[NEON_VS_SUPABASE];
    assert.match(
      between(page, "<strong>Bottom line on scaling:</strong>", "</div>"),
      /Both paid plans include auth, file storage and functions; Neon adds Realtime \(Beta\), Supabase adds GA Realtime\.$/,
    );
    assert.strictEqual(
      verdictItem(page, "Choose Supabase if:"),
      "You want realtime subscriptions alongside Postgres, auth, file storage and edge functions on one platform. Neon's Realtime is in beta; Supabase's is generally available. Best for: apps that push live updates to clients.",
    );
  });

  it("states what Supabase's Free plan includes on the database comparison, with the database size its listing gives", () => {
    const [database] = listingFigures("Supabase", /a (\d[\d,]* MB) database/);
    assert.match(
      between(html[DATABASE_COMPARISON], "<strong>Quick verdict:</strong>", "</p>"),
      new RegExp(`^Quick verdict: Supabase's Free plan includes ${database} Postgres, auth, storage, and realtime\\. Choose Neon for serverless Postgres`),
    );
  });

  it("leaves no guide, report or other hand-written page saying Neon's pricing page lists no realtime, or naming a winner for most developers", async () => {
    const routes = new Set<string>();
    for (const sitemap of SITEMAPS_OF_HAND_WRITTEN_PAGES) {
      const xml = await (await fetch(`${base}${sitemap}`)).text();
      for (const [, loc] of xml.matchAll(/<loc>([^<]+)<\/loc>/g)) routes.add(new URL(loc).pathname);
    }
    assert.ok(routes.has(NEON_VS_SUPABASE) && routes.has(DATABASE_COMPARISON), "the sitemaps no longer list both pages this sweep is for");
    const found: string[] = [];
    for (const route of routes) {
      const text = readableText(await (await fetch(`${base}${route}`)).text());
      for (const [what, pattern] of Object.entries(WITHDRAWN)) {
        if (pattern.test(text)) found.push(`${route}: ${what}`);
      }
    }
    assert.deepStrictEqual(found, []);
  });
});
