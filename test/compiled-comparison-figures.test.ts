import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fetchBadgeVerdicts, type SiteFreeTierVerdict } from "./badge-verdicts.ts";

const {
  comparedServicesOn,
  compiledFigureSlots,
  markCompiledFigures,
  recordsSinceCompiled,
  staticHalfOf,
  subjectOfCardHeading,
  timelineRecordsFor,
  vendorSlugForSubject,
} = await import("../dist/compiled-figures.js");
const { CHANGE_IMPACT_LEVELS, changeImpactColor, changeImpactLabel, isChangeImpactLevel } =
  await import("../dist/change-impact.js");
const { vendorSlugMap } = await import("../dist/vendor-slug.js");

type DealChange = import("../src/types.ts").DealChange;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(__dirname, "..");

const changes: DealChange[] = JSON.parse(
  readFileSync(path.join(REPO, "data", "deal_changes.json"), "utf-8"),
).changes;

const COMPILED_ON: Record<string, string> = {
  analytics: "2026-04-01",
  "api-development": "2026-04-01",
  cicd: "2026-03-31",
  cloud: "2026-03-31",
  database: "2026-03-31",
  hosting: "2026-04-03",
  security: "2026-04-01",
  serverless: "2026-03-31",
  testing: "2026-04-01",
};
const SLUGS = Object.keys(COMPILED_ON);

const ESCAPE: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" };
const esc = (text: string) => text.replace(/[&<>"]/g, c => ESCAPE[c]!);
const shortDate = (iso: string) =>
  new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
const markup = { compiledOn: "2026-04-01", esc, shortDate };

const FREE_TIER_FIGURE = /<strong>Free tier:<\/strong>(?!\s*none\.)/;
const TODAY = new Date().toISOString().slice(0, 10);

function cardBody(html: string, headingMarkup: string): string {
  const at = html.indexOf(headingMarkup);
  if (at < 0) return "";
  const rest = html.slice(at + headingMarkup.length);
  const close = rest.indexOf("</div>");
  return close < 0 ? rest.slice(0, 1500) : rest.slice(0, close);
}

let port = 0;
let proc: ChildProcess | null = null;
let verdicts = new Map<string, SiteFreeTierVerdict>();
const pages = new Map<string, string>();

function startServer(): Promise<ChildProcess> {
  return new Promise((resolve, reject) => {
    const child = spawn("node", [path.join(REPO, "dist", "serve.js")], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, PORT: "0", BASE_URL: "http://localhost", TZ: "UTC" },
    });
    const timeout = setTimeout(() => { child.kill(); reject(new Error("Server startup timeout")); }, 60000);
    child.stderr!.on("data", (data: Buffer) => {
      const m = data.toString().match(/running on http:\/\/localhost:(\d+)/);
      if (m) { port = parseInt(m[1], 10); clearTimeout(timeout); resolve(child); }
    });
    child.on("error", (e) => { clearTimeout(timeout); reject(e); });
  });
}

async function page(pathname: string): Promise<string> {
  const cached = pages.get(pathname);
  if (cached !== undefined) return cached;
  const body = await (await fetch(`http://localhost:${port}${pathname}`)).text();
  pages.set(pathname, body);
  return body;
}

function comparisonPage(slug: string): Promise<string> {
  return page(`/${slug}-free-tier-comparison-2026`);
}

function timelineHalf(html: string): string {
  const at = html.indexOf('<h2 id="changes"');
  return at < 0 ? "" : html.slice(at);
}

const subjectSlug = vendorSlugForSubject;

function changesForSlug(slug: string): DealChange[] {
  const vendor = vendorSlugMap.get(slug);
  if (!vendor) return [];
  return changes.filter(c => c.vendor.toLowerCase() === vendor.toLowerCase());
}

describe("the join between a compiled figure and the records that postdate it", () => {
  const vendorChanges = [
    { date: "2026-03-01", summary: "before" },
    { date: "2026-04-02", summary: "after" },
    { date: "2026-09-09", summary: "not yet in force" },
  ];

  it("returns only records dated after the compile date and no later than the served day", () => {
    const since = recordsSinceCompiled(vendorChanges, "2026-04-01", "2026-09-06");
    assert.deepStrictEqual(since.map(c => c.summary), ["after"]);
  });

  it("returns nothing when every record predates the compile date", () => {
    assert.deepStrictEqual(recordsSinceCompiled(vendorChanges, "2026-12-31", "2027-01-01"), []);
  });

  it("orders the records newest first", () => {
    const since = recordsSinceCompiled(vendorChanges, "2026-01-01", "2026-12-31");
    assert.deepStrictEqual(since.map(c => c.date), ["2026-09-09", "2026-04-02", "2026-03-01"]);
  });
});

describe("reading the subject a comparison card is about", () => {
  it("takes the name before an em-dash tagline", () => {
    assert.strictEqual(subjectOfCardHeading("Semgrep — best free SAST for teams"), "Semgrep");
  });

  it("drops a trailing parenthetical qualifier", () => {
    assert.strictEqual(subjectOfCardHeading("Heap (Contentsquare)"), "Heap");
  });

  it("leaves a sentence heading whole so it resolves to no vendor", () => {
    assert.strictEqual(
      subjectOfCardHeading("Vercel Hobby plan bans commercial use"),
      "Vercel Hobby plan bans commercial use",
    );
  });
});

describe("resolving the vendor a compiled figure is about", () => {
  it("takes the vendor the page links before anything the label says", () => {
    const slug = vendorSlugForSubject({ kind: "row", label: "Neon", linkedSlug: "supabase" });
    assert.strictEqual(slug, "supabase");
  });

  it("reads the label when the page links no vendor", () => {
    assert.strictEqual(vendorSlugForSubject({ kind: "row", label: "Supabase", linkedSlug: null }), "supabase");
  });

  it("ignores a link to a vendor the catalogue does not hold", () => {
    const slug = vendorSlugForSubject({ kind: "row", label: "Supabase", linkedSlug: "a-vendor-we-do-not-track" });
    assert.strictEqual(slug, "supabase");
  });

  it("refuses a card heading that only mentions a vendor in passing", () => {
    const slug = vendorSlugForSubject({
      kind: "card",
      label: "Vercel Hobby plan bans commercial use",
      linkedSlug: null,
    });
    assert.strictEqual(slug, null);
  });
});

describe("the timeline population a compiled page draws on", () => {
  const declared = [{ date: "2026-05-01", vendor: "Declared" }];
  const held: Record<string, { date: string; vendor: string }[]> = {
    Supabase: [{ date: "2026-09-03", vendor: "Supabase" }],
  };

  it("adds the records of a vendor the page prices and the declared scope misses", () => {
    const rows = timelineRecordsFor(
      declared,
      [{ kind: "row", label: "Supabase", linkedSlug: null }],
      (vendor: string) => held[vendor] ?? [],
      12,
    );
    assert.deepStrictEqual(rows.map(r => r.vendor), ["Supabase", "Declared"]);
  });

  it("keeps the declared scope when the page names no vendor it can resolve", () => {
    const rows = timelineRecordsFor(
      declared,
      [{ kind: "card", label: "Egress charges", linkedSlug: null }],
      (vendor: string) => held[vendor] ?? [],
      12,
    );
    assert.deepStrictEqual(rows.map(r => r.vendor), ["Declared"]);
  });

  it("holds the row limit and takes the newest records", () => {
    const many = Array.from({ length: 20 }, (_, i) => ({ date: `2026-01-${String(i + 1).padStart(2, "0")}`, vendor: `v${i}` }));
    const rows = timelineRecordsFor(many, [], () => [], 12);
    assert.strictEqual(rows.length, 12);
    assert.strictEqual(rows[0]!.date, "2026-01-20");
  });
});

describe("marking a compiled figure whose vendor has moved since", () => {
  const row =
    '<table class="comp-table"><tbody><tr><td class="provider-col">Acme</td>' +
    "<td>500 MB</td><td>Yes</td></tr></tbody></table>" +
    '<h2 id="changes">Pricing Change Timeline</h2><tbody></tbody>';

  it("flags a row whose vendor holds a record dated after the compile date", () => {
    const marked = markCompiledFigures(row, () => ({
      slug: "acme",
      vendor: "Acme",
      freeTierEnded: false,
      endedBy: null,
      since: [{ date: "2026-09-03", summary: "Storage cut to 100 MB" }],
    }), markup);
    assert.match(marked, /CHANGED SEP 3/);
    assert.match(marked, /href="\/vendor\/acme#changes"/);
    assert.doesNotMatch(marked, /line-through/);
  });

  it("leaves a row alone when nothing has been recorded since it was compiled", () => {
    const marked = markCompiledFigures(row, () => ({
      slug: "acme", vendor: "Acme", freeTierEnded: false, endedBy: null, since: [],
    }), markup);
    assert.strictEqual(marked, row);
  });

  it("strikes the figures in a row whose free tier the change log says has ended", () => {
    const marked = markCompiledFigures(row, () => ({
      slug: "acme",
      vendor: "Acme",
      freeTierEnded: true,
      endedBy: { date: "2026-09-03", summary: "Free tier removed" },
      since: [{ date: "2026-09-03", summary: "Free tier removed" }],
    }), markup);
    assert.match(marked, />FREE REMOVED</);
    assert.match(marked, /line-through">500 MB<\/span>/);
  });

  it("does not strike a row that already declares the removal itself", () => {
    const declared = row.replace(
      '<td class="provider-col">Acme</td>',
      '<td class="provider-col">Acme<span class="removed-badge">FREE REMOVED</span></td>',
    );
    const marked = markCompiledFigures(declared, () => ({
      slug: "acme", vendor: "Acme", freeTierEnded: true, endedBy: null, since: [],
    }), markup);
    assert.match(marked, />FREE REMOVED</);
    assert.doesNotMatch(marked, /line-through">500 MB/);
  });

  it("replaces the stated free tier on a card whose vendor no longer offers one", () => {
    const card =
      '<div class="diff-card"><h3>Acme</h3>' +
      '<div class="diff-desc"><strong>Free tier:</strong> 50 units/month, unlimited users.</div></div>' +
      '<h2 id="changes">Pricing Change Timeline</h2>';
    const marked = markCompiledFigures(card, () => ({
      slug: "acme",
      vendor: "Acme",
      freeTierEnded: true,
      endedBy: { date: "2026-09-03", summary: "The free tier no longer exists." },
      since: [{ date: "2026-09-03", summary: "The free tier no longer exists." }],
    }), markup);
    assert.doesNotMatch(marked, /50 units\/month/);
    assert.match(marked, /<strong>Free tier:<\/strong> none\./);
    assert.match(marked, /The free tier no longer exists\./);
  });

  it("quotes the record that ended the free tier, not whichever record is newest", () => {
    const card =
      '<div class="diff-card"><h3>Acme</h3>' +
      '<div class="diff-desc"><strong>Free tier:</strong> 50 units/month.</div></div>' +
      '<h2 id="changes">Pricing Change Timeline</h2>';
    const marked = markCompiledFigures(card, () => ({
      slug: "acme",
      vendor: "Acme",
      freeTierEnded: true,
      endedBy: { date: "2026-03-23", summary: "Free tier replaced with a paid plan." },
      since: [
        { date: "2026-09-01", summary: "Seat pricing rearranged." },
        { date: "2026-03-23", summary: "Free tier replaced with a paid plan." },
      ],
    }), markup);
    assert.match(marked, /Free tier replaced with a paid plan\./);
    assert.doesNotMatch(marked, /Seat pricing rearranged/);
  });

  it("marks nothing below the timeline heading", () => {
    const below =
      '<h2 id="changes">Pricing Change Timeline</h2>' +
      '<table class="comp-table"><tr><td class="provider-col">Acme</td><td>500 MB</td></tr></table>';
    const marked = markCompiledFigures(below, () => ({
      slug: "acme", vendor: "Acme", freeTierEnded: true, endedBy: null, since: [],
    }), markup);
    assert.strictEqual(marked, below);
  });
});

describe("grading the severity of a pricing change", () => {
  it("gives each level its own colour", () => {
    const colors = CHANGE_IMPACT_LEVELS.map(changeImpactColor);
    assert.strictEqual(new Set(colors).size, CHANGE_IMPACT_LEVELS.length);
  });

  it("does not give a value outside the scale any level's colour", () => {
    const scale = new Set(CHANGE_IMPACT_LEVELS.map(changeImpactColor));
    for (const outside of ["negative", "", "HIGH", "critical"]) {
      assert.ok(!scale.has(changeImpactColor(outside)), `${outside} took a colour reserved for a grade`);
    }
    assert.ok(!scale.has(changeImpactColor(undefined)));
  });

  it("labels a value outside the scale as ungraded rather than printing it as one", () => {
    assert.strictEqual(changeImpactLabel("negative"), "UNGRADED");
    assert.strictEqual(changeImpactLabel(undefined), "UNGRADED");
    assert.strictEqual(changeImpactLabel("high"), "HIGH");
  });

  it("holds every stored record to the scale", () => {
    const outside = changes.filter(c => !isChangeImpactLevel(c.impact));
    assert.deepStrictEqual(outside.map(c => `${c.vendor}: ${c.impact}`), []);
    assert.ok(changes.length >= 500, `only ${changes.length} records read`);
  });
});

describe("the nine compiled comparison pages against the site's own verdicts", () => {
  before(async () => {
    proc = await startServer();
    verdicts = await fetchBadgeVerdicts(port);
  });

  after(() => { proc?.kill(); });

  it("reads a verdict for every vendor the site publishes a badge for", () => {
    assert.ok(verdicts.size >= 1500, `only ${verdicts.size} badge verdicts read`);
  });

  it("states no free tier for a vendor whose free tier the site says has ended", async () => {
    const stating: string[] = [];
    let ended = 0;
    for (const slug of SLUGS) {
      const html = staticHalfOf(await comparisonPage(slug));
      for (const slot of compiledFigureSlots(html)) {
        const vendorSlug = subjectSlug(slot);
        if (!vendorSlug || verdicts.get(vendorSlug) !== "ended") continue;
        ended++;
        if (!slot.markup.includes("FREE REMOVED")) stating.push(`${slug}: ${slot.label}`);
        if (slot.kind === "card" && FREE_TIER_FIGURE.test(cardBody(html, slot.markup))) {
          stating.push(`${slug}: ${slot.label} still prints a free tier figure`);
        }
      }
    }
    assert.deepStrictEqual(stating, []);
    assert.ok(ended >= 6, `only ${ended} ended subjects found across the nine pages`);
  });

  it("marks every figure whose vendor holds a record dated after the page was compiled", async () => {
    const unmarked: string[] = [];
    let marked = 0;
    for (const slug of SLUGS) {
      const html = staticHalfOf(await comparisonPage(slug));
      for (const slot of compiledFigureSlots(html)) {
        const vendorSlug = subjectSlug(slot);
        if (!vendorSlug) continue;
        const since = recordsSinceCompiled(changesForSlug(vendorSlug), COMPILED_ON[slug]!, TODAY);
        if (since.length === 0) continue;
        marked++;
        if (!/CHANGED [A-Z]{3} \d+|FREE REMOVED/.test(slot.markup)) unmarked.push(`${slug}: ${slot.label}`);
      }
    }
    assert.deepStrictEqual(unmarked, []);
    assert.ok(marked >= 60, `only ${marked} superseded figures found across the nine pages`);
  });

  it("links every marker to the record it rests on", async () => {
    let links = 0;
    for (const slug of SLUGS) {
      const html = staticHalfOf(await comparisonPage(slug));
      for (const m of html.matchAll(/<a href="\/vendor\/([a-z0-9-]+)#changes"[^>]*>(CHANGED [A-Z]{3} \d+|FREE REMOVED)</g)) {
        assert.ok(vendorSlugMap.has(m[1]!), `${slug} links /vendor/${m[1]} and no such vendor exists`);
        links++;
      }
    }
    assert.ok(links >= 60, `only ${links} markers carry a link`);
  });

  it("marks only a slot whose heading names the vendor and nothing longer", async () => {
    const overreaching: string[] = [];
    let named = 0;
    for (const slug of SLUGS) {
      const html = staticHalfOf(await comparisonPage(slug));
      for (const slot of compiledFigureSlots(html)) {
        if (!/CHANGED [A-Z]{3} \d+|FREE REMOVED/.test(slot.markup)) continue;
        named++;
        const vendorSlug = subjectSlug(slot)!;
        const vendor = vendorSlugMap.get(vendorSlug)!;
        const label = slot.label.toLowerCase();
        const name = vendor.toLowerCase();
        if (!label.startsWith(name) && !name.startsWith(label)) {
          overreaching.push(`${slug}: ${slot.label} marked as ${vendor}`);
        }
        if (slot.label.split(/\s+/).length > 4) {
          overreaching.push(`${slug}: ${slot.label} is a sentence, not a vendor`);
        }
      }
    }
    assert.deepStrictEqual(overreaching, []);
    assert.ok(named >= 60, `only ${named} marked slots read`);
  });

  it("selects the security timeline by vendor rather than by searching the summaries", async () => {
    const timeline = timelineHalf(await comparisonPage("security"));
    assert.doesNotMatch(timeline, /Prospect\.io/);
    assert.ok(timeline.includes("<tbody>"), "the security page renders no timeline");
  });

  it("prints no timeline row whose severity is outside the scale", async () => {
    let rows = 0;
    for (const slug of SLUGS) {
      const timeline = timelineHalf(await comparisonPage(slug));
      for (const m of timeline.matchAll(/<span style="color:(#[0-9a-f]{6});font-size:\.8rem;font-weight:600">([A-Z]+)</g)) {
        assert.ok(CHANGE_IMPACT_LEVELS.map(l => l.toUpperCase()).includes(m[2]!), `${slug} renders ${m[2]}`);
        assert.strictEqual(changeImpactColor(m[2]!.toLowerCase()), m[1], `${slug} colours ${m[2]} off the scale`);
        rows++;
      }
    }
    assert.ok(rows >= 90, `only ${rows} timeline rows read`);
  });

  it("counts the services its own tables name", async () => {
    const html = await comparisonPage("database");
    const byline = html.match(/&middot; (\d+) database services compared/);
    assert.ok(byline, "the database page prints no service count");
    const inTables = new Set<string>();
    for (const m of staticHalfOf(html).matchAll(/<td class="provider-col">([\s\S]*?)<\/td>/g)) {
      const name = m[1]!
        .replace(/<a href="\/vendor\/[a-z0-9-]+#changes"[\s\S]*?<\/a>/g, "")
        .replace(/<span[^>]*class="[^"]*-badge[^"]*"[^>]*>[\s\S]*?<\/span>/g, "")
        .replace(/<[^>]+>/g, "")
        .replace(/\s+/g, " ")
        .trim();
      if (name) inTables.add(name);
    }
    assert.strictEqual(parseInt(byline[1]!, 10), inTables.size);
    assert.deepStrictEqual(comparedServicesOn(html), [...inTables].sort());
    assert.ok(inTables.size >= 15, `only ${inTables.size} services named`);
  });

  it("quotes the risk index at the size the risk index publishes", async () => {
    const database = await comparisonPage("database");
    const index = await page("/free-tier-risk");
    const quoted = database.match(/we score (\d+) vendors/);
    const published = index.match(/This index scores (\d+) major developer tools/);
    assert.ok(quoted && published, "one of the two pages prints no count");
    assert.strictEqual(quoted[1], published[1]);
  });

  it("prices Upstash Vector, Weaviate and Appwrite at what their own pages state", async () => {
    const html = await comparisonPage("database");
    assert.match(html, /200M vectors &times; dimensions/);
    assert.match(html, /10K queries or updates a day/);
    assert.doesNotMatch(html, /10K vectors free/);
    assert.match(html, /Cloud: Free Forever/);
    assert.doesNotMatch(html, /Cloud: 14-day sandbox/);
    assert.match(html, /2 GB across 2 projects/);
    assert.match(html, /paused after 1 week of inactivity/);
  });

  it("no longer sells the Applitools free tier its own record retired", async () => {
    const html = await comparisonPage("testing");
    assert.doesNotMatch(html, /Free tier:<\/strong> 50 Test Units/);
    assert.match(html, /applitools-eyes#changes/);
  });
});
