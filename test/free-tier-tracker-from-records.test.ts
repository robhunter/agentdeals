import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { A_DATED_SECTION_MARKER } from "../dist/change-dates.js";
import { trackedChanges } from "../dist/change-census.js";
import { quarterOf } from "../dist/free-tier-cuts.js";
import { getGuideBySlug } from "../dist/guides.js";
import {
  CHANGE_TIMELINE_PATH,
  CUTS_THIS_YEAR_ANCHOR,
  CUTS_THIS_YEAR_HEADING,
  CUTS_THIS_YEAR_SUMMARY_CLASS,
  FREE_TIER_TRACKER_HEADING,
  FREE_TIER_TRACKER_META_DESCRIPTION,
  FREE_TIER_TRACKER_TITLE,
  NO_KNOWN_EFFECTIVE_DATE_LEFT_OUT,
} from "../dist/free-tier-tracker.js";

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

const DAY_MS = 86_400_000;
const dayFromToday = (days: number): string => new Date(Date.now() + days * DAY_MS).toISOString().slice(0, 10);

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

function lastDayTheYearsListCovers(): string {
  const end = dayFromToday(0) < "2026-12-31" ? dayFromToday(0) : "2026-12-31";
  return `${MONTHS[Number(end.slice(5, 7)) - 1]} ${Number(end.slice(8, 10))}`;
}

function cut(vendor: string, date: string, summary: string, extra: Record<string, unknown> = {}) {
  return {
    vendor,
    change_type: "free_tier_removed",
    date,
    date_source: "vendor_page",
    recorded_date: date,
    summary,
    previous_state: "A free plan.",
    current_state: "No free plan.",
    impact: "high",
    category: "Developer Tools",
    alternatives: [],
    source_url: `https://example.com/notices/${summary.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/-+$/, "")}`,
    ...extra,
  };
}

const SEPTEMBER = cut("Basecamp", "2026-09-20", "September fixture removal.");
const AUGUST_LIMIT = cut("Pipedream", "2026-08-14", "August fixture limit cut.", { change_type: "limits_reduced" });
const BRACKETED = cut("Neon", "2026-08-28", "Bracketed fixture removal.", {
  date_source: "discovered",
  recorded_date: "2026-08-28",
  archive_check: {
    checked: "2026-09-02",
    outcome: "vendor_changed",
    brackets: [{ last_old: "2026-05-10", first_new: "2026-05-13" }],
  },
});
const MAY = cut("Postman", "2026-05-05", "May fixture removal.");
const FEBRUARY = cut("LocalStack", "2026-02-02", "February fixture removal.");

const DISCOVERED = cut("Basecamp", "2026-07-07", "Fixture dated the day we recorded it.", { date_source: "discovered", recorded_date: "2026-07-07" });
const BRACKET_OPENS_LAST_YEAR = cut("Pipedream", "2026-03-12", "Fixture whose bracket opens last year.", {
  date_source: "discovered",
  recorded_date: "2026-03-12",
  archive_check: { checked: "2026-04-01", outcome: "vendor_changed", brackets: [{ last_old: "2025-12-20", first_new: "2026-03-12" }] },
});
const RETRACTED = cut("Postman", "2026-06-06", "Fixture withdrawn as our error.", {
  resolution: { state: "retracted", date: "2026-07-01", detail: "Withdrawn: the vendor changed nothing." },
});
const MEDIUM = cut("LocalStack", "2026-04-04", "Medium-impact fixture.", { impact: "medium" });
const LAST_YEAR = cut("Neon", "2025-11-11", "Fixture from last year.");
const NOT_YET = cut("Basecamp", dayFromToday(1), "Fixture whose date has not arrived.");

const LISTED = [SEPTEMBER, AUGUST_LIMIT, BRACKETED, MAY, FEBRUARY];
const LEFT_OUT = [DISCOVERED, BRACKET_OPENS_LAST_YEAR, RETRACTED, MEDIUM, LAST_YEAR, NOT_YET];

interface Section {
  heading: string;
  summaries: string[];
  dates: string[];
}

function textOf(html: string): string {
  return html
    .replace(/<[^>]*>/g, " ")
    .replace(/&#39;|&rsquo;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/&mdash;/g, "—")
    .replace(/\s+/g, " ")
    .trim();
}

function cutsSectionOf(page: string): string {
  const start = page.indexOf(`<h2 id="${CUTS_THIS_YEAR_ANCHOR}">`);
  assert.ok(start !== -1, "the page has no section for this year's cuts");
  return page.slice(start, page.indexOf("<h2", start + 4));
}

function quartersOf(section: string): Section[] {
  return section
    .split(/(?=<h3 )/)
    .slice(1)
    .map((piece) => {
      const body = piece.match(/<tbody>([\s\S]*?)<\/tbody>/)?.[1] ?? "";
      const rows = [...body.matchAll(/<tr>([\s\S]*?)<\/tr>/g)].map((m) => [...m[1]!.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((cell) => textOf(cell[1]!)));
      return {
        heading: textOf(piece.match(/<h3[^>]*>([\s\S]*?)<\/h3>/)?.[1] ?? ""),
        summaries: rows.map((cells) => (cells[3] ?? "").replace(/\s*Source\s*(?:&nearr;|↗)$/, "")),
        dates: rows.map((cells) => cells[2] ?? ""),
      };
    });
}

describe("/free-tier-tracker lists the year's free tier removals and cuts from the change records", () => {
  let dir = "";
  let proc: ChildProcess | null = null;
  let page = "";
  let quarters: Section[] = [];

  before(async () => {
    dir = mkdtempSync(path.join(tmpdir(), "free-tier-tracker-"));
    const changesPath = path.join(dir, "deal_changes.json");
    writeFileSync(changesPath, JSON.stringify({ changes: [...LISTED, ...LEFT_OUT] }));
    const child = spawn("node", [path.join(REPO, "dist", "serve.js")], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, PORT: "0", BASE_URL: "http://localhost", TZ: "UTC", AGENTDEALS_CHANGES_PATH: changesPath },
    });
    proc = child;
    const port = await new Promise<number>((resolve, reject) => {
      const timeout = setTimeout(() => { child.kill(); reject(new Error("Server startup timeout")); }, 60000);
      child.stderr!.on("data", (data: Buffer) => {
        const m = data.toString().match(/running on http:\/\/localhost:(\d+)/);
        if (m) { clearTimeout(timeout); resolve(parseInt(m[1], 10)); }
      });
      child.on("error", (err) => { clearTimeout(timeout); reject(err); });
    });
    page = await (await fetch(`http://localhost:${port}/free-tier-tracker`)).text();
    quarters = quartersOf(cutsSectionOf(page));
  });

  after(() => {
    proc?.kill();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("names every listed record once, in the quarter of its date, newest quarter and newest record first", () => {
    assert.deepStrictEqual(
      quarters.map((q) => [q.heading, q.summaries]),
      [
        ["Q3 2026", [SEPTEMBER.summary, BRACKETED.summary, AUGUST_LIMIT.summary]],
        ["Q2 2026", [MAY.summary]],
        ["Q1 2026", [FEBRUARY.summary]],
      ],
    );
  });

  it("dates a bracketed change by its bracket and every other change by its effective date", () => {
    const q3 = quarters.find((q) => q.heading === "Q3 2026")!;
    assert.deepStrictEqual(q3.dates, ["effective 2026-09-20", "effective between 2026-05-10 and 2026-05-13", "effective 2026-08-14"]);
  });

  it("leaves out undated, retracted, medium-impact, last year's and not-yet-arrived records", () => {
    const section = textOf(cutsSectionOf(page));
    for (const record of LEFT_OUT) {
      assert.ok(!section.includes(record.summary), `${record.summary} is listed`);
    }
  });

  it("states the calendar rule under its heading and points to where a change waits until its date", () => {
    const section = cutsSectionOf(page);
    const rule = section.match(/<p class="[^"]*dated-rule[^"]*">([\s\S]*?)<\/p>/)?.[1] ?? "";
    assert.ok(textOf(rule).startsWith(A_DATED_SECTION_MARKER), "the section states no calendar rule");
    assert.ok(rule.includes(`href="${CHANGE_TIMELINE_PATH}"`), "the calendar rule links nowhere");
    assert.ok(section.indexOf(rule) < section.indexOf("<h3"), "the calendar rule sits below a quarter, so it does not cover the whole list");
  });

  it("opens the list under its heading with the span it covers and how many of each kind of change its rows hold", () => {
    const section = cutsSectionOf(page);
    const summary = section.match(new RegExp(`<p class="[^"]*\\b${CUTS_THIS_YEAR_SUMMARY_CLASS}\\b[^"]*">([\\s\\S]*?)</p>`));
    assert.ok(summary, "the list opens with no summary");
    assert.strictEqual(
      textOf(summary[1]!),
      `This list holds high-impact changes from January 1 to ${lastDayTheYearsListCovers()}, 2026. It includes 4 free tier removals and 1 cut.`,
    );
    assert.ok(section.indexOf(summary[0]) < section.indexOf("dated-rule"), "the summary sits below the calendar rule, not under the heading");
  });

  it("says under the list that changes with no known effective date are not in it, and links the change timeline", () => {
    const section = cutsSectionOf(page);
    const closing = section.slice(section.lastIndexOf("</table>"));
    assert.ok(textOf(closing).includes(NO_KNOWN_EFFECTIVE_DATE_LEFT_OUT), "the list does not say what it leaves out");
    assert.ok(closing.includes(`href="${CHANGE_TIMELINE_PATH}"`), "the closing line does not link the change timeline");
  });

  it("titles, describes and heads the page as covering the year", () => {
    assert.ok(page.includes(`<title>${FREE_TIER_TRACKER_TITLE} — AgentDeals</title>`), "the title is not the year's");
    assert.ok(page.includes(`<meta name="description" content="${FREE_TIER_TRACKER_META_DESCRIPTION}">`), "the meta description is not the year's");
    assert.ok(page.includes(`<h1>${FREE_TIER_TRACKER_HEADING}</h1>`), "the heading is not the year's");
    assert.ok(page.includes(`href="#${CUTS_THIS_YEAR_ANCHOR}">${CUTS_THIS_YEAR_HEADING}</a>`), "the contents do not list the year's cuts");
  });
});

describe("/free-tier-tracker's hand-typed cards say when their figures were true", () => {
  let proc: ChildProcess | null = null;
  let page = "";
  let port = 0;

  before(async () => {
    const child = spawn("node", [path.join(REPO, "dist", "serve.js")], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, PORT: "0", BASE_URL: "http://localhost", TZ: "UTC" },
    });
    proc = child;
    port = await new Promise<number>((resolve, reject) => {
      const timeout = setTimeout(() => { child.kill(); reject(new Error("Server startup timeout")); }, 60000);
      child.stderr!.on("data", (data: Buffer) => {
        const m = data.toString().match(/running on http:\/\/localhost:(\d+)/);
        if (m) { clearTimeout(timeout); resolve(parseInt(m[1], 10)); }
      });
      child.on("error", (err) => { clearTimeout(timeout); reject(err); });
    });
    page = await (await fetch(`http://localhost:${port}/free-tier-tracker`)).text();
  });

  after(() => {
    proc?.kill();
  });

  it("is named for the year, not the first quarter, wherever another page links it by name", async () => {
    const linking = ["/guides", "/alternatives", "/state-of-free-tiers", "/pricing-changes", "/vendor/localstack", "/alternative-to/localstack", "/shutdowns"];
    const names: string[] = [];
    for (const route of linking) {
      const body = await (await fetch(`http://localhost:${port}${route}`)).text();
      for (const link of body.matchAll(/<a href="\/free-tier-tracker"[^>]*>([\s\S]*?)<\/a>/g)) names.push(`${route}: ${textOf(link[1]!)}`);
      for (const card of body.matchAll(/<h[23][^>]*>(Free Tier Tracker[^<]*)<\/h[23]>/g)) names.push(`${route}: ${textOf(card[1]!)}`);
    }
    assert.ok(names.length >= linking.length, `only ${names.length} links to the page were read`);
    assert.deepStrictEqual(names.filter((name) => /\bQ1\b/.test(name)), []);
    assert.ok(names.some((name) => name.endsWith(FREE_TIER_TRACKER_HEADING)), "no page names it by its heading");
  });

  const cards = (): { vendor: string; date: string; text: string; note: string; noteHtml: string }[] =>
    page
      .split(/(?=<div style="padding:1\.25rem;border:1px solid var\(--border\);border-left:3px solid)/)
      .slice(1)
      .map((piece) => {
        const noteHtml = piece.match(/<p class="figures-as-of"[^>]*>([\s\S]*?)<\/p>/)?.[1] ?? "";
        return {
          vendor: textOf(piece.match(/<a href="\/vendor\/[^"]+"[^>]*>([\s\S]*?)<\/a>/)?.[1] ?? ""),
          date: piece.match(/<span style="font-family:var\(--mono\);font-size:\.75rem;color:var\(--text-dim\)">(\d{4}-\d{2}-\d{2})<\/span>/)?.[1] ?? "",
          text: textOf(piece),
          note: textOf(noteHtml),
          noteHtml,
        };
      });

  it("dates each first-quarter card's figures by its change and links the vendor's listing for today's terms", () => {
    const firstQuarter = cards().filter((c) => c.date >= "2026-01-01" && c.date <= "2026-03-31" && c.vendor !== "Neon");
    assert.ok(firstQuarter.length >= 8, `only ${firstQuarter.length} first-quarter cards were read`);
    for (const c of firstQuarter) {
      assert.ok(c.note.startsWith(`Figures as of ${c.date}. Today's terms: our ${c.vendor} listing`), `${c.vendor}'s card reads "${c.note}"`);
      assert.match(c.noteHtml, /<a href="\/vendor\/[a-z0-9-]+">/, `${c.vendor}'s card links no listing`);
    }
  });

  it("tells a reader the Neon card's storage was January's and gives today's from the listing", () => {
    const neon = cards().find((c) => c.vendor === "Neon");
    assert.ok(neon, "the Neon card is gone");
    assert.strictEqual(neon.note, "These were January's figures; Neon's free plan now gives 1 GB of storage per project, 20 GB in total ( our Neon listing ).");
    assert.ok(neon.noteHtml.includes('<a href="/vendor/neon">'), "the Neon card does not link the listing");
  });

  it("gives Terragrunt Scale the free plan's 25 infrastructure units and no dated note", () => {
    const terragrunt = cards().find((c) => c.vendor === "Terragrunt Scale");
    assert.ok(terragrunt, "the Terragrunt Scale card is gone");
    assert.ok(terragrunt.text.includes("up to 25 infrastructure units"), "the Terragrunt Scale card does not give 25 infrastructure units");
    assert.ok(!terragrunt.text.includes("500+"), "the Terragrunt Scale card still gives 500+");
    assert.strictEqual(terragrunt.noteHtml, "", "the Terragrunt Scale card carries a dated note");
  });

  it("does not offer Terragrunt Scale's 25 units as still free to HCP Terraform users leaving a 500-resource tier", () => {
    const hcp = cards().find((c) => c.vendor === "HCP Terraform");
    assert.ok(hcp, "the HCP Terraform card is gone");
    const at = hcp.text.indexOf("Still free:");
    assert.ok(at !== -1, "the HCP Terraform card lists nothing as still free, so this reads nothing");
    assert.ok(!hcp.text.slice(at).includes("Terragrunt Scale"), "the HCP Terraform card lists Terragrunt Scale as still free");
  });

  it("does not place the expansions in a year or quarter that one of their cards is dated outside", () => {
    const start = page.indexOf('<h2 id="expanded">');
    assert.ok(start !== -1, "the page has no expansions section");
    const section = page.slice(start, page.indexOf("<h2", start + 4));
    const intro = textOf(section.match(/<p class="section-intro">([\s\S]*?)<\/p>/)?.[1] ?? "");
    assert.ok(intro.length > 0, "the expansions section has no intro, so this reads nothing");
    const dates = [...section.matchAll(/<span style="font-family:var\(--mono\);font-size:\.75rem;color:var\(--text-dim\)">(\d{4}-\d{2}-\d{2})<\/span>/g)].map((m) => m[1]!);
    assert.ok(dates.length >= 3, `only ${dates.length} expansion cards were read`);
    for (const claim of intro.matchAll(/\b(?:Q([1-4]) )?(20\d{2})\b/g)) {
      const outside = dates.filter((date) => date.slice(0, 4) !== claim[2] || (claim[1] !== undefined && quarterOf(date) !== Number(claim[1])));
      assert.deepStrictEqual(outside, [], `the intro says "${claim[0]}" above cards dated ${outside.join(", ")}`);
    }
  });

  const methodology = (): string => page.match(/<div id="methodology"[\s\S]*?<\/div>/)?.[0] ?? "";
  const trackedOnFile = () => trackedChanges(JSON.parse(readFileSync(path.join(REPO, "data", "deal_changes.json"), "utf8")).changes);

  it("names in its methodology every change type the records it counts carry, and no other", () => {
    const named = [...methodology().matchAll(/<em>([a-z_]+)<\/em>/g)].map((m) => m[1]!).sort();
    const carried = [...new Set(trackedOnFile().map((record: { change_type: string }) => record.change_type))].sort();
    assert.ok(carried.length >= 8, `the records carry only ${carried.length} change types`);
    assert.deepStrictEqual(named, carried);
  });

  it("counts the records its methodology describes, and how many of them the scheduled re-read wrote, from the change log", () => {
    const tracked = trackedOnFile();
    const scheduled = tracked.filter((record: { detected_by?: string }) => record.detected_by).length;
    assert.ok(scheduled > 0 && scheduled < tracked.length, "the log no longer mixes scheduled and hand-read records, so the split below proves nothing");
    const text = textOf(methodology());
    assert.ok(text.includes(`monitors ${tracked.length} pricing changes`), `the methodology does not count the ${tracked.length} records it describes`);
    assert.ok(
      text.includes(`${scheduled} of them were written by the scheduled re-read of the vendor's page; the other ${tracked.length - scheduled} were read by hand`),
      "the methodology does not split the records it counts by who wrote them",
    );
  });
});

describe("/free-tier-tracker's API Monetization Wave", () => {
  let proc: ChildProcess | null = null;
  let page = "";

  before(async () => {
    const child = spawn("node", [path.join(REPO, "dist", "serve.js")], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, PORT: "0", BASE_URL: "http://localhost", TZ: "UTC" },
    });
    proc = child;
    const port = await new Promise<number>((resolve, reject) => {
      const timeout = setTimeout(() => { child.kill(); reject(new Error("Server startup timeout")); }, 60000);
      child.stderr!.on("data", (data: Buffer) => {
        const m = data.toString().match(/running on http:\/\/localhost:(\d+)/);
        if (m) { clearTimeout(timeout); resolve(parseInt(m[1], 10)); }
      });
      child.on("error", (err) => { clearTimeout(timeout); reject(err); });
    });
    page = await (await fetch(`http://localhost:${port}/free-tier-tracker`)).text();
  });

  after(() => { if (proc) proc.kill(); });

  it("does not give Amazon SP-API, which never charged its announced fees, as an API adding billing", () => {
    const wave = page.match(/API Monetization Wave[\s\S]*?<p class="pattern-examples">([^<]*)<\/p>/)?.[1];
    assert.ok(wave, "the page has no API Monetization Wave examples");
    assert.ok(wave.startsWith("Examples: "), wave);
    assert.ok(!wave.includes("SP-API"), wave);
  });
});

describe("the guide list the MCP servers return names /free-tier-tracker for the year", () => {
  it("gives it the page's heading and meta description", () => {
    const guide = getGuideBySlug("free-tier-tracker");
    assert.ok(guide, "the guide list has no entry for the page");
    assert.strictEqual(guide.title, FREE_TIER_TRACKER_HEADING);
    assert.strictEqual(guide.description, FREE_TIER_TRACKER_META_DESCRIPTION);
  });
});
