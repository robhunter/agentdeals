import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertPopulationFloor } from "./population-floor.ts";
import {
  FRESHNESS_TOKEN,
  FRESHNESS_VERB,
  freshnessClaimFor,
  monthOf,
  vendorSlugsLinkedFrom,
  verifiedSpanClaim,
  withFreshnessClaim,
} from "../dist/page-freshness.js";
import { loadOffers } from "../dist/data.js";
import { toSlug } from "../dist/slug.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let server: ChildProcess;
let base = "";

function startServer(): Promise<ChildProcess> {
  return new Promise((resolve, reject) => {
    const serverPath = path.join(__dirname, "..", "dist", "serve.js");
    const proc = spawn("node", [serverPath], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, PORT: "0", BASE_URL: "http://localhost" },
    });
    const timeout = setTimeout(() => {
      proc.kill();
      reject(new Error("Server startup timeout"));
    }, 30000);
    proc.stderr!.on("data", (data: Buffer) => {
      const match = data.toString().match(/running on http:\/\/localhost:(\d+)/);
      if (match) {
        base = `http://localhost:${match[1]}`;
        clearTimeout(timeout);
        resolve(proc);
      }
    });
    proc.on("error", err => {
      clearTimeout(timeout);
      reject(err);
    });
  });
}

const MONTHS =
  "January|February|March|April|May|June|July|August|September|October|November|December";

const SERVED_CLAIM = new RegExp(
  `(?:${FRESHNESS_VERB} (?:${MONTHS})(?: \\d{4})? to (?:${MONTHS}) \\d{4}` +
    `|${FRESHNESS_VERB} (?:${MONTHS}) \\d{4}` +
    `|Compiled \\d{4}-\\d{2}-\\d{2}[^.]*)\\.`,
);

const HARDCODED_CLAIM = new RegExp(
  `\\b(?:Updated|updated|Verified|verified|Compiled|compiled)` +
    `(?: against [^.<>"]{0,60})?(?: as of)? (?:${MONTHS}),? \\d{4}`,
  "g",
);

const PAGES_CARRYING_A_DERIVED_CLAIM_FLOOR = 20;

const datesBySlug = (() => {
  const dates = new Map<string, string[]>();
  for (const offer of loadOffers()) {
    if (!offer.verifiedDate) continue;
    const slug = toSlug(offer.vendor);
    const held = dates.get(slug);
    if (held) held.push(offer.verifiedDate);
    else dates.set(slug, [offer.verifiedDate]);
  }
  return dates;
})();

function verifiedDatesForSlug(slug: string): readonly string[] {
  return datesBySlug.get(slug) ?? [];
}

function metaDescriptionOf(html: string): string {
  return (html.match(/<meta name="description" content="([^"]*)"/i)?.[1] ?? "").replace(/&amp;/g, "&");
}

function ledeOf(html: string): string {
  return (html.match(/<p class="page-claim">([\s\S]*?)<\/p>/)?.[1] ?? "").replace(/&amp;/g, "&");
}

function structuredDescriptionsOf(html: string): string[] {
  return [...html.matchAll(/"description":"((?:[^"\\]|\\.)*)"/g)].map(m =>
    m[1]!.replace(/\\"/g, '"').replace(/\\\\/g, "\\"),
  );
}

async function fetchPage(pathname: string): Promise<string> {
  const response = await fetch(base + pathname, { redirect: "error" });
  assert.strictEqual(response.status, 200, `${pathname} did not return 200`);
  return response.text();
}

async function sitemapPagePaths(): Promise<string[]> {
  const xml = await fetchPage("/sitemap-pages.xml");
  return [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map(m => new URL(m[1]!).pathname);
}

interface ServedPage {
  path: string;
  html: string;
}

async function fetchAll(paths: string[]): Promise<ServedPage[]> {
  const served: ServedPage[] = [];
  const queue = [...paths];
  const workers = Array.from({ length: 8 }, async () => {
    for (let next = queue.pop(); next !== undefined; next = queue.pop()) {
      served.push({ path: next, html: await fetchPage(next) });
    }
  });
  await Promise.all(workers);
  return served;
}

interface StoredReview {
  path: string;
  published: string;
  reviewed_at: string | null;
  reads_index: boolean;
}

const storedReviews = new Map<string, StoredReview>(
  (
    JSON.parse(
      fs.readFileSync(path.join(__dirname, "..", "data", "page-reviews.json"), "utf-8"),
    ) as { pages: StoredReview[] }
  ).pages.map(page => [page.path, page]),
);

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

function namedMonth(isoDate: string): string {
  return `${MONTH_NAMES[Number(isoDate.slice(5, 7)) - 1]} ${isoDate.slice(0, 4)}`;
}

function claimTheDataSupports(pagePath: string, html: string, today: string): string {
  const review = storedReviews.get(pagePath);
  if (review && !review.reads_index) {
    const checked = review.reviewed_at !== null && review.reviewed_at <= today ? review.reviewed_at : null;
    return checked === null
      ? `Compiled ${review.published}, not re-checked since.`
      : `Compiled ${review.published}, last checked ${checked}.`;
  }
  const dates = [...html.matchAll(/href="\/vendor\/([a-z0-9][a-z0-9-]*)"/g)]
    .flatMap(link => [...verifiedDatesForSlug(link[1]!)])
    .sort();
  if (dates.length === 0) return "";
  const oldest = namedMonth(dates[0]!);
  const newest = namedMonth(dates[dates.length - 1]!);
  if (oldest === newest) return `${FRESHNESS_VERB} ${oldest}.`;
  const sameYear = dates[0]!.slice(0, 4) === dates[dates.length - 1]!.slice(0, 4);
  return `${FRESHNESS_VERB} ${sameYear ? oldest.split(" ")[0] : oldest} to ${newest}.`;
}

const REVIEW_OF_A_HAND_COMPILED_PAGE = {
  path: "/x",
  published: "2026-04-09",
  tier: "A",
  vendors_asserted: [],
  vendors_tabulated: [],
  badge_subjects_unresolved: [],
  reviewed_at: null,
  reviewer: null,
  review_outcome: null,
  review_note: null,
  reads_index: false,
  reads_changes: false,
  data_source: "unsourced",
  data_source_reason: null,
};

describe("A freshness date derived from the records a page lists", () => {
  it("reads a month and a year out of a stored date", () => {
    assert.strictEqual(monthOf("2026-09-05"), "September 2026");
    assert.strictEqual(monthOf("2025-12-31"), "December 2025");
    assert.strictEqual(monthOf("not-a-date"), "");
    assert.strictEqual(monthOf("2026-13-01"), "");
    assert.strictEqual(monthOf("20260905"), "");
    assert.strictEqual(monthOf("2026-09"), "");
  });

  it("claims nothing when it holds no dated record", () => {
    assert.strictEqual(verifiedSpanClaim([]), "");
    assert.strictEqual(verifiedSpanClaim(["", "unknown"]), "");
  });

  it("names one month when every record it holds was read in that month", () => {
    assert.strictEqual(verifiedSpanClaim(["2026-08-04"]), "Verified August 2026.");
    assert.strictEqual(
      verifiedSpanClaim(["2026-08-28", "2026-08-04", "2026-08-15"]),
      "Verified August 2026.",
    );
  });

  it("names the span its records cover, oldest first", () => {
    assert.strictEqual(
      verifiedSpanClaim(["2026-09-05", "2026-07-01", "2026-08-14"]),
      "Verified July to September 2026.",
    );
  });

  it("repeats the year only when the span crosses one", () => {
    assert.strictEqual(
      verifiedSpanClaim(["2026-03-02", "2025-12-19"]),
      "Verified December 2025 to March 2026.",
    );
  });

  it("spans the records it can date and ignores the rest", () => {
    assert.strictEqual(
      verifiedSpanClaim(["2026-07-01", "", "2026-09-05", "soon"]),
      "Verified July to September 2026.",
    );
  });

  it("carries no character that would change meaning inside an attribute", () => {
    for (const claim of [verifiedSpanClaim(["2026-07-01", "2026-09-05"]), verifiedSpanClaim(["2026-08-04"])]) {
      assert.ok(!/[<>&"']/.test(claim), `${claim} would have to be escaped`);
    }
  });

  it("collects the vendor records a page links to, once each", () => {
    const html =
      '<a href="/vendor/groq">Groq</a><a href="/alternative-to/groq">x</a>' +
      '<a href="/vendor/cerebras">C</a><a href="/vendor/groq#changes">again</a>';
    assert.deepStrictEqual(vendorSlugsLinkedFrom(html), ["cerebras", "groq"]);
  });

  it("puts one derived claim everywhere the page declares it", () => {
    const html = `<meta content="a ${FRESHNESS_TOKEN}"><p>b ${FRESHNESS_TOKEN}</p>`;
    assert.strictEqual(
      withFreshnessClaim(html, () => "Verified August 2026."),
      '<meta content="a Verified August 2026."><p>b Verified August 2026.</p>',
    );
  });

  it("leaves no placeholder behind when it can derive nothing", () => {
    const html = `<meta content="a sentence. ${FRESHNESS_TOKEN}">`;
    assert.strictEqual(withFreshnessClaim(html, () => ""), '<meta content="a sentence.">');
  });

  it("dates a page from its own review when that page does not read the catalogue", () => {
    const html = '<a href="/vendor/groq">Groq</a>';
    assert.strictEqual(
      freshnessClaimFor("/x", html, () => ["2026-09-05"], "2026-09-09", () => REVIEW_OF_A_HAND_COMPILED_PAGE as never),
      "Compiled 2026-04-09, not re-checked since.",
    );
  });

  it("dates a page from its listed records when that page reads the catalogue", () => {
    const html = '<a href="/vendor/groq">Groq</a>';
    assert.strictEqual(
      freshnessClaimFor(
        "/x",
        html,
        () => ["2026-09-05"],
        "2026-09-09",
        () => ({ ...REVIEW_OF_A_HAND_COMPILED_PAGE, reads_index: true }) as never,
      ),
      "Verified September 2026.",
    );
  });
});

describe("Freshness dates as served", () => {
  let served: ServedPage[] = [];

  before(async () => {
    server = await startServer();
    served = await fetchAll(await sitemapPagePaths());
  });

  after(() => {
    server?.kill();
  });

  it("resolves every freshness placeholder it declares", () => {
    const unresolved = served.filter(page => page.html.includes(FRESHNESS_TOKEN)).map(page => page.path).sort();
    assert.deepStrictEqual(unresolved, []);
  });

  it("publishes only a date the records behind the page support", () => {
    const today = new Date().toISOString().slice(0, 10);
    const wrong: string[] = [];
    for (const page of served) {
      const claimed = SERVED_CLAIM.exec(metaDescriptionOf(page.html));
      if (!claimed) continue;
      const supported = claimTheDataSupports(page.path, page.html, today);
      if (claimed[0] !== supported) {
        wrong.push(`${page.path}: says ${claimed[0]}, its records say ${supported || "nothing"}`);
      }
    }
    assert.deepStrictEqual(wrong.sort(), []);
  });

  it("says the same thing to a reader, a snippet and a structured-data extractor", () => {
    const disagreeing: string[] = [];
    for (const page of served) {
      const claimed = SERVED_CLAIM.exec(metaDescriptionOf(page.html));
      if (!claimed) continue;
      if (!ledeOf(page.html).includes(claimed[0])) {
        disagreeing.push(`${page.path}: the visible opening omits ${claimed[0]}`);
      }
      if (!structuredDescriptionsOf(page.html).some(text => text.includes(claimed[0]))) {
        disagreeing.push(`${page.path}: no structured description carries ${claimed[0]}`);
      }
    }
    assert.deepStrictEqual(disagreeing.sort(), []);
  });

  it("dates a body of pages, not a handful", () => {
    const dated = served.filter(page => SERVED_CLAIM.test(metaDescriptionOf(page.html)));
    assertPopulationFloor(
      dated.length,
      PAGES_CARRYING_A_DERIVED_CLAIM_FLOOR,
      "pages publishing a derived freshness date",
    );
  });

  it("dates the free LLM API comparison from the providers it lists", () => {
    const html = served.find(page => page.path === "/free-llm-apis")?.html;
    assert.ok(html, "/free-llm-apis is not in the page sitemap");
    const meta = metaDescriptionOf(html);
    const claimed = SERVED_CLAIM.exec(meta);
    assert.ok(claimed, `/free-llm-apis publishes no freshness date: ${meta}`);
    assert.strictEqual(
      claimed[0],
      claimTheDataSupports("/free-llm-apis", html, new Date().toISOString().slice(0, 10)),
    );

    const listed = vendorSlugsLinkedFrom(html).flatMap(slug => [...verifiedDatesForSlug(slug)]).sort();
    assert.ok(listed.length > 0, "/free-llm-apis links to no dated record");
    assert.ok(
      listed[listed.length - 1]! >= "2026-09-01",
      `/free-llm-apis lists nothing read this month: newest is ${listed[listed.length - 1]}`,
    );
    assert.ok(!/March 2026/.test(meta), `/free-llm-apis still dates itself to March: ${meta}`);
  });
});

describe("Freshness dates in the source", () => {
  it("hardcodes no month a page could publish as its own freshness", () => {
    const source = fs.readFileSync(path.join(__dirname, "..", "src", "serve.ts"), "utf-8");
    const hardcoded = [...source.matchAll(HARDCODED_CLAIM)].map(found => {
      const line = source.slice(0, found.index).split("\n").length;
      return `src/serve.ts:${line}: ${found[0]}`;
    });
    assert.deepStrictEqual(hardcoded, []);
  });
});
