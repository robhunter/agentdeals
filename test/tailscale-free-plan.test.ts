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
  "&nbsp;": " ", "&lt;": "<", "&gt;": ">", "&rarr;": "→", "&rsquo;": "’",
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

function textOutsideLinks(html: string): string {
  return readableText(html.replace(/<a\b[^>]*>[\s\S]*?<\/a>/gi, " "));
}

function tailscaleListing(): Record<string, any> {
  const listing = offers.find((o) => o.vendor === "Tailscale" && o.category === "Security");
  assert.ok(listing, "no Security listing is named Tailscale");
  return listing!;
}

function listedUsersAndDevices(): { users: string; devices: string } {
  const { description } = tailscaleListing();
  const match = String(description).match(/\b(\d+) users, (unlimited|\d[\d,]*) devices\b/);
  assert.ok(match, `the Tailscale listing no longer gives its users and devices as "N users, M devices": ${description}`);
  return { users: match![1], devices: match![2] };
}

function freeTierCellsOfTailscale(html: string): string[] {
  const rows: string[][] = [];
  for (const [, table] of html.matchAll(/<table\b[^>]*>([\s\S]*?)<\/table>/g)) {
    const headers = [...table.matchAll(/<th\b[^>]*>([\s\S]*?)<\/th>/g)].map((m) => readableText(m[1]));
    const column = headers.indexOf("Free Tier Limit");
    if (column < 0) continue;
    for (const [, row] of table.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/g)) {
      const cells = [...row.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/g)].map((m) => m[1]);
      if (cells.length > column && textOutsideLinks(cells[0]) === "Tailscale") rows.push([readableText(cells[column])]);
    }
  }
  assert.strictEqual(rows.length, 1, `expected one Tailscale row under a Free Tier Limit column, found ${rows.length}`);
  return rows[0];
}

function diffCards(html: string): { heading: string; body: string }[] {
  return [...html.matchAll(/<div class="diff-card">\s*<h3>([\s\S]*?)<\/h3>\s*<div class="diff-desc">([\s\S]*?)<\/div>/g)]
    .map(([, heading, body]) => ({ heading: textOutsideLinks(heading), body: readableText(body) }));
}

function tailscaleCard(html: string): { heading: string; body: string } {
  const cards = diffCards(html).filter((card) => /^Tailscale — /.test(card.heading));
  assert.strictEqual(cards.length, 1, `expected one card headed "Tailscale — ...", found ${cards.length}`);
  return cards[0];
}

function cardHeaded(html: string, heading: string): { heading: string; body: string } {
  const cards = diffCards(html).filter((card) => card.heading === heading);
  assert.strictEqual(cards.length, 1, `expected one card headed "${heading}", found ${cards.length}`);
  return cards[0];
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

const SECURITY_COMPARISON = "/security-free-tier-comparison-2026";
const SITEMAPS_OF_HAND_WRITTEN_PAGES = ["/sitemap-pages.xml", "/sitemap-reports.xml", "/sitemap-misc.xml"];

const WITHDRAWN: Record<string, RegExp> = {
  "Tailscale's free plan given as 3 users and 100 devices": /\b3 users, 100 devices\b/,
  "Tailscale called the best free mesh VPN": /best free mesh VPN/i,
  "Tailscale's free plan said to require a personal email domain": /requires (?:a )?personal email domain/i,
  "the 3-user limit called the real constraint": /3-user limit is the real constraint/,
};

describe("Tailscale's free plan is stated with the users, devices and non-commercial rule its listing gives", () => {
  let proc: ChildProcess | undefined;
  let html = "";

  before(async () => {
    proc = await startServer();
    html = await (await fetch(`${base}${SECURITY_COMPARISON}`)).text();
  });

  after(() => { proc?.kill(); });

  it("gives the users and devices the Tailscale listing states, in the security comparison's table row", () => {
    const { users, devices } = listedUsersAndDevices();
    assert.deepStrictEqual(freeTierCellsOfTailscale(html), [`${users} users, ${devices} devices, MagicDNS`]);
  });

  it("opens the mesh VPN card with the users and devices the Tailscale listing states", () => {
    const { users, devices } = listedUsersAndDevices();
    assert.match(
      tailscaleCard(html).body,
      new RegExp(`^Free for ${users} users with ${devices} devices and WireGuard-based mesh networking\\. `),
    );
  });

  it("says in the mesh VPN card that the free plan is only for non-commercial use, which the Tailscale listing's condition quotes", () => {
    const condition = (tailscaleListing().conditions ?? []).find((c: { rules_out?: string[] }) => c.rules_out?.includes("commercial use"));
    assert.ok(condition, "the Tailscale listing no longer has a condition ruling out commercial use");
    assert.match(condition.quote, /only suitable for non-commercial use/);
    assert.match(tailscaleCard(html).body, / The free plan is only suitable for non-commercial use\. /);
  });

  it("heads the mesh VPN card without naming it the best", () => {
    assert.strictEqual(tailscaleCard(html).heading, "Tailscale — free mesh VPN");
  });

  it("ends the mesh VPN card with the trial a custom domain starts, which the Tailscale listing's condition states", () => {
    const condition = (tailscaleListing().conditions ?? []).find((c: { quote?: string }) => /custom domain/.test(c.quote ?? ""));
    assert.ok(condition, "the Tailscale listing no longer has a condition about a tailnet on a custom domain");
    assert.match(condition.quote, /business use.*free trial/);
    assert.match(tailscaleCard(html).body, / A custom domain starts a 14-day Enterprise trial\.$/);
  });

  it("tells a team in the gotchas card that company or client work is commercial use, even with personal email accounts", () => {
    assert.match(
      cardHeaded(html, "Tailscale free plan is non-commercial only").body,
      /^The free plan is only for non-commercial use\. Using Tailscale for company or client work is commercial use, even with personal email accounts\. A custom domain starts a 14-day Enterprise trial\. Headscale /,
    );
  });

  it("leaves no guide, report or other hand-written page making any of the withdrawn Tailscale claims", async () => {
    const routes = new Set<string>();
    for (const sitemap of SITEMAPS_OF_HAND_WRITTEN_PAGES) {
      const xml = await (await fetch(`${base}${sitemap}`)).text();
      for (const [, loc] of xml.matchAll(/<loc>([^<]+)<\/loc>/g)) routes.add(new URL(loc).pathname);
    }
    assert.ok(routes.has(SECURITY_COMPARISON), "the sitemaps no longer list the page this sweep is for");
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
