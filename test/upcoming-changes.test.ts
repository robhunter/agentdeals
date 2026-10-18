import { describe, it, before } from "node:test";
import assert from "node:assert";
import { spawn } from "node:child_process";
import vm from "node:vm";
import { assertPopulationFloor } from "./population-floor.ts";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(__dirname, "..");

const { splitAtTheDayServed, UPCOMING_CHANGES_HEADING, UPCOMING_CHANGES_INTRO, LATEST_PRICING_CHANGES_HEADING, LATEST_PRICING_CHANGES_SHOWN } = await import("../dist/upcoming-changes.js");

type Change = { vendor: string; date: string; change_type: string; summary: string };

const TODAY = new Date().toISOString().slice(0, 10);
const dayOffset = (days: number) => new Date(Date.parse(TODAY) + days * 86400000).toISOString().slice(0, 10);

const PAGES = [
  { route: "/llm-api-pricing", inEffectAnchor: "changes", shownAtMost: 20, vendor: "OpenAI" },
  { route: "/openai-assistants-alternatives", inEffectAnchor: "openai-timeline", shownAtMost: null, vendor: "OpenAI" },
  { route: "/openai-assistants-migration-2026", inEffectAnchor: "openai-changes", shownAtMost: null, vendor: "OpenAI" },
  { route: "/openai-assistants-migration", inEffectAnchor: "openai-changes", shownAtMost: 10, vendor: "OpenAI" },
  { route: "/shutdowns", inEffectAnchor: "pricing-changes", shownAtMost: 10, vendor: "OpenAI" },
  { route: "/ai-coding-tools-pricing", inEffectAnchor: "changes", shownAtMost: null, vendor: "OpenAI Codex" },
  { route: "/gcp-free-tier-2026", inEffectAnchor: "changes", shownAtMost: 12, vendor: "Google Gemini API" },
  { route: "/aws-free-tier-2026", inEffectAnchor: "changes", shownAtMost: 10, vendor: "AWS" },
  { route: "/azure-free-tier-2026", inEffectAnchor: "changes", shownAtMost: 10, vendor: "Microsoft for Startups" },
  { route: "/digitalocean-free-tier-2026", inEffectAnchor: "changes", shownAtMost: 10, vendor: "DigitalOcean" },
  { route: "/startup-credits", inEffectAnchor: "changes", shownAtMost: null, vendor: "Google for Startups Cloud Program" },
  { route: "/ci-cd-pricing", inEffectAnchor: "changes", shownAtMost: null, vendor: "GitHub Actions" },
  { route: "/database-pricing", inEffectAnchor: "changes", shownAtMost: null, vendor: "Xata" },
  { route: "/vector-database-pricing", inEffectAnchor: "changes", shownAtMost: 15, vendor: "Pinecone" },
  { route: "/hosting-pricing", inEffectAnchor: "changes", shownAtMost: null, vendor: "PythonAnywhere" },
];

const TOC_LINKED_ROUTES = [
  "/llm-api-pricing",
  "/ai-coding-tools-pricing",
  "/gcp-free-tier-2026",
  "/aws-free-tier-2026",
  "/azure-free-tier-2026",
  "/digitalocean-free-tier-2026",
  "/startup-credits",
  "/ci-cd-pricing",
  "/database-pricing",
  "/vector-database-pricing",
  "/hosting-pricing",
];

function fixture(vendor: string, date: string, change_type: string, summary: string) {
  return {
    vendor,
    change_type,
    date,
    date_source: "vendor_page",
    summary,
    previous_state: "The fixture model is served.",
    current_state: "The fixture model is retired.",
    impact: "medium",
    source_url: "https://example.com/fixture/deprecations",
    category: "AI / ML",
    alternatives: [],
    recorded_date: TODAY,
    ...(change_type === "product_deprecated" ? { listing_effect: "narrows" } : {}),
  };
}

function fixturesFor(vendor: string) {
  return {
    later: fixture(vendor, dayOffset(75), "product_deprecated", `The later ${vendor} fixture model retires.`),
    sooner: fixture(vendor, dayOffset(12), "product_deprecated", `The sooner ${vendor} fixture model retires.`),
    onTheDayServed: fixture(vendor, TODAY, "pricing_restructured", `The ${vendor} fixture price change takes effect on the day served.`),
  };
}

const FIXTURES = new Map([...new Set(PAGES.map((p) => p.vendor))].map((vendor) => [vendor, fixturesFor(vendor)]));
const MORE_THAN_90_DAYS_AWAY = { ...fixture("OpenAI", dayOffset(200), "product_deprecated", "The far-off OpenAI fixture model retires."), what_ends: "The far-off fixture model" };

function escapedLikeThePage(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function sectionFrom(html: string, anchor: string): string | null {
  const at = html.search(new RegExp(`<h[23] id="${anchor}"`));
  if (at < 0) return null;
  const rest = html.slice(at + 1);
  const next = rest.search(/<h[23][ >]/);
  return next < 0 ? rest : rest.slice(0, next);
}

function h2SectionFrom(html: string, anchor: string): string | null {
  const at = html.indexOf(`<h2 id="${anchor}">`);
  if (at < 0) return null;
  const next = html.indexOf("<h2", at + 1);
  return next < 0 ? html.slice(at) : html.slice(at, next);
}

function rowCount(section: string): number {
  return (section.split("<tbody>")[1]?.split("</tbody>")[0].match(/<tr>/g) ?? []).length;
}

async function withServedChangeLog<T>(changes: unknown[], use: (base: string, inventoryPath: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(path.join(tmpdir(), "upcoming-changes-"));
  const changesPath = path.join(dir, "changes.json");
  const inventoryPath = path.join(dir, "inventory.json");
  writeFileSync(changesPath, JSON.stringify({ changes }));
  const proc = spawn("node", [path.join(REPO, "dist", "serve.js")], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, PORT: "0", BASE_URL: "http://localhost", TZ: "UTC", AGENTDEALS_CHANGES_PATH: changesPath, AGENTDEALS_PAGE_INVENTORY_OUT: inventoryPath },
  });
  try {
    const base = await new Promise<string>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Server startup timeout")), 30000);
      proc.stderr!.on("data", (data: Buffer) => {
        const match = data.toString().match(/running on http:\/\/localhost:(\d+)/);
        if (match) {
          clearTimeout(timeout);
          resolve(`http://localhost:${match[1]}`);
        }
      });
      proc.on("error", (err) => {
        clearTimeout(timeout);
        reject(err);
      });
    });
    return await use(base, inventoryPath);
  } finally {
    proc.kill();
    rmSync(dir, { recursive: true, force: true });
  }
}

async function servedPages(changes: unknown[]): Promise<Map<string, string>> {
  return withServedChangeLog(changes, async (base) => {
    const pages = new Map<string, string>();
    for (const { route } of PAGES) {
      const response = await fetch(base + route);
      assert.strictEqual(response.status, 200, `${route} answered ${response.status}`);
      pages.set(route, await response.text());
    }
    return pages;
  });
}

const shipped: Change[] = JSON.parse(readFileSync(path.join(REPO, "data", "deal_changes.json"), "utf-8")).changes;

describe("splitting a change list at the day served", () => {
  it("keeps a record dated on the day served in effect and lists later records soonest first", () => {
    const newestFirst = [{ date: "2026-11-30" }, { date: "2026-10-14" }, { date: "2026-10-10" }, { date: "2026-09-28" }, { date: "2026-09-28" }];
    const { inEffect, upcoming } = splitAtTheDayServed(newestFirst, "2026-10-10");
    assert.deepStrictEqual(inEffect.map((c: { date: string }) => c.date), ["2026-10-10", "2026-09-28", "2026-09-28"]);
    assert.deepStrictEqual(upcoming.map((c: { date: string }) => c.date), ["2026-10-14", "2026-11-30"]);
  });
});

describe("announced records added to a copy of the change log", () => {
  let pages = new Map<string, string>();

  before(async () => {
    pages = await servedPages([...shipped, ...[...FIXTURES.values()].flatMap((f) => [f.later, f.sooner, f.onTheDayServed]), MORE_THAN_90_DAYS_AWAY]);
  });

  for (const { route, inEffectAnchor, vendor } of PAGES) {
    const { later: LATER, sooner: SOONER, onTheDayServed: ON_THE_DAY_SERVED } = FIXTURES.get(vendor)!;
    it(`${route} lists them under ${UPCOMING_CHANGES_HEADING}, soonest first, and not in its table of changes in effect`, () => {
      const html = pages.get(route)!;
      const upcoming = sectionFrom(html, "upcoming-changes");
      const inEffect = sectionFrom(html, inEffectAnchor);
      assert.ok(upcoming, `${route} prints no ${UPCOMING_CHANGES_HEADING} section`);
      assert.ok(inEffect, `${route} prints no table of changes in effect`);
      assert.ok(upcoming.includes(`>${UPCOMING_CHANGES_HEADING}</h`), `${route}'s section is not headed ${UPCOMING_CHANGES_HEADING}`);
      assert.ok(upcoming.includes(UPCOMING_CHANGES_INTRO), `${route}'s ${UPCOMING_CHANGES_HEADING} section does not open with its intro`);
      const sooner = upcoming.indexOf(SOONER.summary);
      const later = upcoming.indexOf(LATER.summary);
      assert.ok(sooner >= 0 && later >= 0, `${route} leaves an announced change out of ${UPCOMING_CHANGES_HEADING}`);
      assert.ok(sooner < later, `${route} lists the change dated ${LATER.date} before the one dated ${SOONER.date}`);
      for (const announced of [SOONER, LATER]) {
        assert.ok(!inEffect.includes(announced.summary), `${route} lists the change dated ${announced.date} among changes in effect`);
      }
    });

    it(`${route} keeps a change dated on the day served in its table of changes in effect`, () => {
      const html = pages.get(route)!;
      assert.ok(sectionFrom(html, inEffectAnchor)!.includes(ON_THE_DAY_SERVED.summary), `${route} leaves out the change dated ${TODAY}`);
      assert.ok(!sectionFrom(html, "upcoming-changes")!.includes(ON_THE_DAY_SERVED.summary), `${route} lists the change dated ${TODAY} as upcoming`);
    });
  }

  for (const { route, inEffectAnchor, shownAtMost } of PAGES.filter((p) => p.route === "/llm-api-pricing" || p.route === "/shutdowns")) {
    it(`prints no record dated after the day served in ${route}'s table of changes in effect, and still shows ${shownAtMost} rows`, () => {
      const inEffect = sectionFrom(pages.get(route)!, inEffectAnchor)!;
      const announced = [...shipped, ...[...FIXTURES.values()].flatMap((f) => [f.later, f.sooner])].filter((c) => c.date > TODAY);
      assert.ok(announced.length >= 2);
      for (const c of announced) {
        assert.ok(!inEffect.includes(escapedLikeThePage(c.summary)), `${route} lists ${c.vendor}'s change dated ${c.date} among changes in effect`);
      }
      assert.strictEqual(rowCount(inEffect), shownAtMost);
    });
  }

  it("heads /shutdowns' section for shutdowns more than 90 days away Later, and no text there says later this year", () => {
    const html = pages.get("/shutdowns")!;
    const later = h2SectionFrom(html, "later");
    assert.ok(later, "/shutdowns prints no section for shutdowns more than 90 days away");
    assert.ok(later.startsWith('<h2 id="later">Later <span class="section-count">'), `the section is headed: ${later.slice(0, 60)}`);
    assert.ok(later.includes('<p class="section-intro">These shutdowns are more than 90 days away.</p>'), "the section does not open with its intro");
    assert.ok(later.includes(MORE_THAN_90_DAYS_AWAY.what_ends), "the shutdown 200 days out is not in the section");
    assert.ok(html.includes("up to 90 is Upcoming, beyond that is Later."), "the calendar notice does not name the section Later");
    assert.ok(!/later this year/i.test(html), "/shutdowns still says later this year");
  });

  for (const route of TOC_LINKED_ROUTES) {
    it(`links the section from ${route}'s list of sections`, () => {
      assert.ok(pages.get(route)!.includes(`<li><a href="#upcoming-changes">${UPCOMING_CHANGES_HEADING}</a></li>`));
    });
  }
});

describe("a copy of the change log with no record dated after the day served", () => {
  let pages = new Map<string, string>();

  before(async () => {
    pages = await servedPages(shipped.map((c) => ({ ...c, discontinued_date: "unknown" })).filter((c) => c.date <= TODAY));
  });

  for (const { route, inEffectAnchor, shownAtMost } of PAGES) {
    it(`${route} prints no ${UPCOMING_CHANGES_HEADING} section and keeps its table of changes in effect`, () => {
      const html = pages.get(route)!;
      assert.ok(!html.includes('id="upcoming-changes"'), `${route} prints an empty ${UPCOMING_CHANGES_HEADING} section`);
      assert.ok(!html.includes(`>${UPCOMING_CHANGES_HEADING}<`), `${route} names ${UPCOMING_CHANGES_HEADING} with nothing to list`);
      const rows = rowCount(sectionFrom(html, inEffectAnchor)!);
      assert.ok(rows > 0, `${route} prints no changes in effect`);
      if (shownAtMost !== null) assert.ok(rows <= shownAtMost, `${route} prints ${rows} rows, more than ${shownAtMost}`);
    });
  }
});

const CENSUS_CHANGE_TYPES = ["pricing_restructured", "limits_reduced", "limits_increased", "product_deprecated"];
const CENSUS_VENDORS = [...new Set([...shipped.map((c) => c.vendor), "Datadog", "New Relic"])];
const CENSUS_FIXTURES = CENSUS_VENDORS.flatMap((vendor, index) =>
  CENSUS_CHANGE_TYPES.map((type) => fixture(vendor, dayOffset(30), type, `Census fixture ${index}-${type} announced for a later day.`)),
);
const A_CENSUS_FIXTURE = /Census fixture \d+-[a-z_]+ announced for a later day\./;
const HEADED_RECENT = /(?<![\w-])(recent|recently|latest|newest)(?![\w-])/i;

const UPCOMING_LISTED_ON = [
  ...PAGES.map((p) => p.route),
  "/alternative-to/openai",
  "/alternative-to/google-gemini-api",
  "/events/google-io-2026",
  "/events/microsoft-build-2026",
  "/supabase-vs-firebase",
  "/vercel-vs-netlify",
  "/neon-vs-supabase",
  "/railway-vs-render",
  "/datadog-vs-new-relic",
];

interface Heading {
  at: number;
  end: number;
  level: number;
  id: string | null;
  text: string;
}

function headingsOf(page: string): Heading[] {
  return [...page.matchAll(/<h([1-6])\b([^>]*)>([\s\S]*?)<\/h\1>/gi)].map((m) => ({
    at: m.index!,
    end: m.index! + m[0].length,
    level: Number(m[1]),
    id: m[2]!.match(/\bid="([^"]+)"/)?.[1] ?? null,
    text: m[3]!.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim(),
  }));
}

function withoutScriptsOrStyles(html: string): string {
  return html.replace(/<script\b[\s\S]*?<\/script>/gi, "").replace(/<style\b[\s\S]*?<\/style>/gi, "");
}

function bodyUnder(page: string, headings: Heading[], heading: Heading): string {
  const next = headings.find((other) => other.at > heading.at && other.level <= heading.level);
  return page.slice(heading.end, next ? next.at : page.length);
}

function sectionsHeadedRecent(html: string): { heading: string; body: string }[] {
  const page = withoutScriptsOrStyles(html);
  const headings = headingsOf(page);
  return headings.filter((h) => HEADED_RECENT.test(h.text)).map((h) => ({ heading: h.text, body: bodyUnder(page, headings, h) }));
}

function sectionWithId(html: string, id: string): string | null {
  const page = withoutScriptsOrStyles(html);
  const headings = headingsOf(page);
  const heading = headings.find((h) => h.id === id);
  return heading ? bodyUnder(page, headings, heading) : null;
}

describe("every section a page heads Recent or Latest, with announced changes for every vendor in the change log", () => {
  let inventory: string[] = [];
  const pages = new Map<string, string>();
  const refused: string[] = [];

  before(async () => {
    await withServedChangeLog([...shipped, ...CENSUS_FIXTURES], async (base, inventoryPath) => {
      inventory = JSON.parse(readFileSync(inventoryPath, "utf-8"));
      for (let i = 0; i < inventory.length; i += 8) {
        await Promise.all(inventory.slice(i, i + 8).map(async (route) => {
          const response = await fetch(base + route);
          if (response.status !== 200) refused.push(`${route} ${response.status}`);
          pages.set(route, await response.text());
        }));
      }
    });
  });

  it("reads every page the site serves", () => {
    assertPopulationFloor(inventory.length, 1500, "pages in the inventory the census reads");
    assert.deepStrictEqual(refused, []);
  });

  it("lists none of those announced changes as a recent or latest change", () => {
    const listed: string[] = [];
    let sections = 0;
    for (const [route, html] of pages) {
      for (const { heading, body } of sectionsHeadedRecent(html)) {
        sections++;
        const found = body.match(A_CENSUS_FIXTURE);
        if (found) listed.push(`${route} "${heading}": ${found[0]}`);
      }
    }
    assertPopulationFloor(sections, 50, "sections headed Recent, Latest or Newest across the inventory");
    assert.deepStrictEqual(listed, []);
  });

  for (const route of UPCOMING_LISTED_ON) {
    it(`${route} lists its vendors' announced changes under ${UPCOMING_CHANGES_HEADING}`, () => {
      const upcoming = sectionWithId(pages.get(route)!, "upcoming-changes");
      assert.ok(upcoming, `${route} prints no ${UPCOMING_CHANGES_HEADING} section`);
      assert.match(upcoming, A_CENSUS_FIXTURE);
      assert.ok(upcoming.includes(UPCOMING_CHANGES_INTRO), `${route}'s ${UPCOMING_CHANGES_HEADING} section does not open with its intro`);
    });
  }
});

async function resourceTextOverHttp(base: string, uri: string): Promise<string> {
  const headers: Record<string, string> = { "Content-Type": "application/json", Accept: "application/json, text/event-stream" };
  const initialized = await fetch(`${base}/mcp`, {
    method: "POST",
    headers,
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "upcoming-changes", version: "1" } } }),
  });
  await initialized.text();
  const session = initialized.headers.get("mcp-session-id");
  if (session) headers["mcp-session-id"] = session;
  await (await fetch(`${base}/mcp`, { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) })).text();
  const response = await fetch(`${base}/mcp`, {
    method: "POST",
    headers,
    body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "resources/read", params: { uri } }),
  });
  const line = (await response.text()).split("\n").find((one) => one.startsWith("data: "));
  return line ? JSON.parse(line.slice(6)).result?.contents?.[0]?.text ?? "" : "";
}

function latestPricingChangesOverStdio(base: string): Promise<string> {
  const child = spawn("node", [path.join(REPO, "dist", "index.js")], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, AGENTDEALS_API_URL: base },
  });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(new Error("stdio MCP timeout")); }, 60000);
    let buffer = "";
    child.stdout!.on("data", (chunk: Buffer) => {
      buffer += chunk.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        let payload: { id?: number; result?: { contents?: Array<{ text?: string }> } };
        try { payload = JSON.parse(line); } catch { continue; }
        if (payload.id !== 2) continue;
        clearTimeout(timer);
        child.kill();
        resolve(payload.result?.contents?.[0]?.text ?? "");
      }
    });
    child.on("error", (err) => { clearTimeout(timer); reject(err); });
    child.stdin!.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "upcoming-changes", version: "1" } } })}\n`);
    child.stdin!.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
    child.stdin!.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "resources/read", params: { uri: "agentdeals://changes/latest" } })}\n`);
  });
}

function entryDatesUnder(text: string, heading: string): string[] {
  const at = text.indexOf(`# ${heading}\n`);
  if (at < 0) return [];
  const rest = text.slice(at + heading.length + 3);
  const next = rest.search(/^# /m);
  return [...(next < 0 ? rest : rest.slice(0, next)).matchAll(/^- \*\*(\d{4}-\d{2}-\d{2})\*\* \|/gm)].map((m) => m[1]!);
}

describe(`the ${LATEST_PRICING_CHANGES_HEADING} MCP resource, with announced records in the change log`, () => {
  const announced = [...FIXTURES.values()].flatMap((f) => [f.later, f.sooner]);
  const resource = new Map<string, string>();

  before(async () => {
    await withServedChangeLog([...shipped, ...announced], async (base) => {
      resource.set("Streamable HTTP", await resourceTextOverHttp(base, "agentdeals://changes/latest"));
      resource.set("stdio", await latestPricingChangesOverStdio(base));
    });
  });

  for (const transport of ["Streamable HTTP", "stdio"]) {
    it(`over ${transport}, lists ${LATEST_PRICING_CHANGES_SHOWN} changes in effect as the latest`, () => {
      const latest = entryDatesUnder(resource.get(transport)!, LATEST_PRICING_CHANGES_HEADING);
      assert.strictEqual(latest.length, LATEST_PRICING_CHANGES_SHOWN);
      assert.deepStrictEqual(latest.filter((date) => date > TODAY), []);
      assert.deepStrictEqual(latest, [...latest].sort().reverse());
    });

    it(`over ${transport}, lists every announced record under ${UPCOMING_CHANGES_HEADING}, soonest first`, () => {
      const text = resource.get(transport)!;
      const upcoming = entryDatesUnder(text, UPCOMING_CHANGES_HEADING);
      assert.ok(text.includes(`# ${UPCOMING_CHANGES_HEADING}\n\n${UPCOMING_CHANGES_INTRO}\n\n`), `the ${UPCOMING_CHANGES_HEADING} part does not open with its intro`);
      assert.deepStrictEqual(upcoming, [...upcoming].sort());
      assert.ok(upcoming.every((date) => date > TODAY));
      for (const change of announced) assert.ok(text.slice(text.indexOf(`# ${UPCOMING_CHANGES_HEADING}`)).includes(change.summary), `${change.summary} is not listed as upcoming`);
    });
  }
});

function inlineScripts(html: string): string[] {
  return [...html.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/gi)]
    .filter(([, attrs]) => !/\bsrc\s*=/i.test(attrs!) && !/type\s*=\s*["'][^"']*json/i.test(attrs!))
    .map(([, , source]) => source!);
}

function browserElement() {
  let text = "";
  return {
    value: "",
    innerHTML: "",
    get textContent() { return text; },
    set textContent(value: string) {
      text = String(value);
      this.innerHTML = text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    },
    className: "",
    disabled: false,
    firstChild: null,
    children: [],
    style: {},
    dataset: {},
    classList: { add() {}, remove() {}, toggle() {} },
    addEventListener() {},
    insertBefore() {},
    setAttribute() {},
    querySelectorAll() { return []; },
  };
}

function comparisonToolCards(pageHtml: string, comparison: unknown): string[] {
  const elements = new Map<string, ReturnType<typeof browserElement>>();
  const document = {
    getElementById(id: string) {
      if (!elements.has(id)) elements.set(id, browserElement());
      return elements.get(id)!;
    },
    createElement: () => browserElement(),
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener() {},
  };
  const context = vm.createContext({
    window: { location: { search: "", pathname: "/", origin: "http://localhost", href: "http://localhost/" }, open() {} },
    document,
    navigator: { clipboard: { writeText: async () => {} } },
    history: { replaceState() {} },
    alert() {},
    fetch: (url: string) => Promise.reject(new Error(`unexpected request for ${url}`)),
    URL,
    URLSearchParams,
    console,
    setTimeout,
    clearTimeout,
  });
  const blocks = inlineScripts(pageHtml).filter((source) => source.includes("function renderComparison("));
  assert.strictEqual(blocks.length, 1, "one script block defines renderComparison");
  vm.runInContext(blocks[0]!, context, { timeout: 10000 });
  (context.renderComparison as (data: unknown) => void)(comparison);
  return elements.get("results")!.innerHTML.split('<div class="vendor-card">').slice(1);
}

function riskViewRendering(viewHtml: string, data: unknown): string {
  const script = viewHtml.slice(viewHtml.indexOf("function render(args, data)"), viewHtml.lastIndexOf("</script>"));
  assert.ok(script.startsWith("function render(args, data)"), "the Compare Vendors view no longer defines render(args, data)");
  const app = { innerHTML: "", querySelectorAll: () => [] };
  const document = {
    getElementById: (id: string) => (id === "app" ? app : null),
    createElement: () => {
      let text = "";
      return {
        set textContent(value: string) { text = value; },
        get innerHTML() { return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); },
      };
    },
  };
  vm.runInNewContext(`${script}\nrender({ vendors: ["Google Gemini API"] }, data);`, { document, data });
  return app.innerHTML;
}

function partsAround(html: string, recentMarker: string, upcomingMarker: string): { recent: string; upcoming: string } {
  const recentAt = html.indexOf(recentMarker);
  const upcomingAt = html.indexOf(upcomingMarker);
  return {
    recent: recentAt < 0 ? "" : html.slice(recentAt, upcomingAt > recentAt ? upcomingAt : html.length),
    upcoming: upcomingAt < 0 ? "" : html.slice(upcomingAt),
  };
}

const labelledDatesIn = (html: string) => [...html.matchAll(/<span class="change-date">[^<]*?(\d{4}-\d{2}-\d{2})[^<]*<\/span>/g)].map((m) => m[1]!);

describe("the change lists the browser builds from the API, with announced records in the change log", () => {
  const announced = [...FIXTURES.values()].flatMap((f) => [f.later, f.sooner]);
  let cards: string[] = [];
  let riskView = "";

  before(async () => {
    await withServedChangeLog([...shipped, ...announced], async (base) => {
      const comparison = await (await fetch(`${base}/api/compare?a=OpenAI&b=${encodeURIComponent("OpenAI Codex")}`)).json();
      cards = comparisonToolCards(await (await fetch(`${base}/compare-tool`)).text(), comparison);
      riskView = riskViewRendering(
        await resourceTextOverHttp(base, "ui://agentdeals/compare-vendors"),
        await (await fetch(`${base}/api/vendor-risk/google-gemini-api`)).json(),
      );
    });
  });

  it("the comparison tool's cards keep announced changes out of Recent Changes and list them under Upcoming Changes, soonest first", () => {
    assert.strictEqual(cards.length, 2);
    const { later, sooner } = FIXTURES.get("OpenAI Codex")!;
    for (const card of cards) {
      const { recent, upcoming } = partsAround(card, ">Recent Changes</strong>", `>${UPCOMING_CHANGES_HEADING}</strong>`);
      assert.ok(recent, "a card prints no Recent Changes");
      assert.ok(labelledDatesIn(recent).length > 0, "a card dates none of its Recent Changes");
      assert.deepStrictEqual(labelledDatesIn(recent).filter((date) => date > TODAY), [], "a card lists an announced change under Recent Changes");
      assert.ok(upcoming, `a card prints no ${UPCOMING_CHANGES_HEADING}`);
      assert.ok(labelledDatesIn(upcoming).length > 0, `a card dates none of its ${UPCOMING_CHANGES_HEADING}`);
      assert.deepStrictEqual(labelledDatesIn(upcoming).filter((date) => date <= TODAY), [], `a card lists a change in effect under ${UPCOMING_CHANGES_HEADING}`);
      assert.deepStrictEqual(labelledDatesIn(upcoming), [...labelledDatesIn(upcoming)].sort(), `a card lists its ${UPCOMING_CHANGES_HEADING} out of date order`);
    }
    const codexUpcoming = partsAround(cards[1]!, ">Recent Changes</strong>", `>${UPCOMING_CHANGES_HEADING}</strong>`).upcoming;
    assert.ok(codexUpcoming.indexOf(sooner.summary) >= 0 && codexUpcoming.indexOf(sooner.summary) < codexUpcoming.indexOf(later.summary));
  });

  it("the Compare Vendors view's risk assessment keeps announced changes out of Recent Pricing Changes and lists them under Upcoming Changes, soonest first", () => {
    const { recent, upcoming } = partsAround(riskView, "<h3>Recent Pricing Changes</h3>", `<h3>${UPCOMING_CHANGES_HEADING}</h3>`);
    assert.ok(recent, "the view prints no Recent Pricing Changes");
    const recentDates = [...recent.matchAll(/<td style="white-space:nowrap">(\d{4}-\d{2}-\d{2})<\/td>/g)].map((m) => m[1]!);
    assert.ok(recentDates.length > 0, "the view dates none of its Recent Pricing Changes");
    assert.deepStrictEqual(recentDates.filter((date) => date > TODAY), []);
    const upcomingDates = [...upcoming.matchAll(/<td style="white-space:nowrap">(\d{4}-\d{2}-\d{2})<\/td>/g)].map((m) => m[1]!);
    const { later, sooner } = FIXTURES.get("Google Gemini API")!;
    assert.ok(upcomingDates.includes(sooner.date) && upcomingDates.includes(later.date), `the view lists ${upcomingDates.join(", ")} as upcoming`);
    assert.ok(upcomingDates.every((date) => date > TODAY));
    assert.deepStrictEqual(upcomingDates, [...upcomingDates].sort());
  });
});


describe("announced retirements on records already in effect", () => {
  const retirement = dayOffset(18);
  const earlier = dayOffset(6);
  const subjects = [...FIXTURES.keys(), "Prisma Accelerate", "smartlook.com"].map((vendor) => ({
    later: { ...fixture(vendor, dayOffset(-1), "product_deprecated", `The ${vendor} later retirement fixture.`), discontinued_date: retirement },
    sooner: { ...fixture(vendor, dayOffset(-2), "product_deprecated", `The ${vendor} sooner retirement fixture.`), discontinued_date: earlier },
    unknown: { ...fixture(vendor, dayOffset(-3), "product_deprecated", `The ${vendor} unknown retirement fixture.`), discontinued_date: "unknown" },
  }));
  const pages = new Map<string, string>();
  const resources = new Map<string, string>();
  let pricingUpcoming = "";

  before(async () => {
    await withServedChangeLog([...shipped, ...subjects.flatMap((s) => [s.later, s.sooner, s.unknown])], async (base) => {
      for (const route of [...PAGES.map((p) => p.route), "/alternative-to/openai", "/pricing-changes", "/changes"]) {
        const response = await fetch(base + route, { redirect: "error" });
        assert.strictEqual(response.status, 200);
        pages.set(route, await response.text());
      }
      pricingUpcoming = pages.get("/pricing-changes")!.split('<div class="upcoming-section" id="upcoming">')[1]!.split('<div class="pc-filters">')[0]!;
      resources.set("Streamable HTTP", await resourceTextOverHttp(base, "agentdeals://changes/latest"));
      resources.set("stdio", await latestPricingChangesOverStdio(base));
    });
  });

  for (const { route, vendor, inEffectAnchor } of PAGES) {
    it(`${route} lists a future retirement on its retirement date and retains its earlier event`, () => {
      const subject = subjects.find((s) => s.later.vendor === vendor)!;
      const html = pages.get(route)!;
      const upcoming = sectionFrom(html, "upcoming-changes")!;
      assert.ok(upcoming.includes(subject.sooner.summary));
      assert.ok(upcoming.includes(subject.later.summary));
      assert.ok(upcoming.indexOf(subject.sooner.summary) < upcoming.indexOf(subject.later.summary));
      assert.ok(!upcoming.includes(subject.unknown.summary));
      const inEffect = sectionFrom(html, inEffectAnchor)!;
      assert.ok(inEffect.includes(subject.later.summary));
      assert.ok(inEffect.includes(subject.unknown.summary));
      const row = upcoming.split(/<tr>/).find((r) => r.includes(subject.later.summary))!;
      const label = new Date(retirement + "T00:00:00Z").toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
      assert.ok((row.replace(/\u00a0/g, " ").includes(label) || row.includes(retirement)), `${route} retirement row does not label ${label}`);
    });
  }

  it("lists retirement dates on vendor alternatives and in the pricing tracker without removing history", () => {
    const subject = subjects.find((s) => s.later.vendor === "OpenAI")!;
    const upcoming = sectionFrom(pages.get("/alternative-to/openai")!, "upcoming-changes")!;
    assert.ok(upcoming.includes(subject.later.summary));
    assert.ok(!upcoming.includes(subject.unknown.summary));
    assert.ok(upcoming.includes(retirement));
    for (const subject of subjects) {
      assert.ok(pricingUpcoming.includes(subject.later.summary));
      assert.ok(!pricingUpcoming.includes(subject.unknown.summary));
      assert.ok(pages.get("/changes")!.includes(subject.later.summary));
    }
    const label = new Date(retirement + "T00:00:00Z").toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
    const entry = pricingUpcoming.split('<div class="pc-entry').find((e) => e.includes(subject.later.summary))!;
    assert.ok(entry.includes(retirement));
  });

  it("includes retirements represented by forecast cards and counts every upcoming tracker entry", () => {
    const shutdowns = sectionFrom(pages.get("/shutdowns")!, "upcoming-changes")!;
    for (const vendor of ["Prisma Accelerate", "smartlook.com"]) {
      const subject = subjects.find((s) => s.later.vendor === vendor)!;
      assert.ok(shutdowns.includes(subject.later.summary));
      assert.ok(shutdowns.includes(subject.sooner.summary));
      assert.ok(!shutdowns.includes(subject.unknown.summary));
    }
    const count = pages.get("/pricing-changes")!.match(/<div class="stat-value">(\d+)<\/div>\s*<div class="stat-label">Upcoming<\/div>/);
    assert.ok(count);
    assert.strictEqual(Number(count[1]), (pricingUpcoming.match(/class="pc-entry/g) ?? []).length);
  });

  for (const transport of ["Streamable HTTP", "stdio"]) {
    it(`over ${transport}, labels and sorts retirement dates without discarding the earlier event`, () => {
      const text = resources.get(transport)!;
      const upcoming = text.split(`# ${UPCOMING_CHANGES_HEADING}\n`)[1]!;
      const latest = text.split(`# ${UPCOMING_CHANGES_HEADING}\n`)[0]!;
      const subject = subjects.find((s) => s.later.vendor === "OpenAI")!;
      assert.ok(upcoming.includes(`**${retirement}** | OpenAI`));
      assert.ok(upcoming.includes(subject.later.summary));
      assert.ok(!upcoming.includes(subject.unknown.summary));
      assert.ok(latest.includes(subject.later.summary));
      const dates = entryDatesUnder(text, UPCOMING_CHANGES_HEADING);
      assert.deepStrictEqual(dates, [...dates].sort());
    });
  }
});

describe("the retirement date boundary", () => {
  const record = { date: "2026-10-02", discontinued_date: "2026-12-01", summary: "An earlier event with a later retirement." };

  it("preserves the original event and does not mutate the stored record", () => {
    const split = splitAtTheDayServed([record], "2026-10-18");
    assert.deepStrictEqual(split.inEffect, [record]);
    assert.deepStrictEqual(split.upcoming.map((c) => c.date), ["2026-12-01"]);
    assert.strictEqual(record.date, "2026-10-02");
  });

  for (const discontinued_date of ["unknown", "December 1, 2026", "12/01/2026", "", null, undefined]) {
    it(`does not schedule a retirement from ${JSON.stringify(discontinued_date)}`, () => {
      const split = splitAtTheDayServed([{ ...record, discontinued_date }], "2026-10-18");
      assert.strictEqual(split.upcoming.length, 0);
      assert.strictEqual(split.inEffect.length, 1);
    });
  }

  for (const discontinued_date of ["2026-10-17", "2026-10-18"]) {
    it(`keeps a separate future event when its retirement date is ${discontinued_date}`, () => {
      const event = { ...record, date: "2026-11-01", discontinued_date };
      const split = splitAtTheDayServed([event], "2026-10-18");
      assert.deepStrictEqual(split.inEffect, []);
      assert.deepStrictEqual(split.upcoming, [event]);
    });
  }

  for (const day of ["2026-12-01", "2026-12-02"]) {
    it(`keeps the earlier event and leaves the upcoming list on ${day}`, () => {
      const split = splitAtTheDayServed([record], day);
      assert.deepStrictEqual(split.upcoming, []);
      assert.deepStrictEqual(split.inEffect, [record]);
    });
  }
});
