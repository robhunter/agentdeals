import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const { endedPreviewItem, previewedPeriodLabel } = await import("../dist/page-freshness.js");
const { utcToday } = await import("../dist/page-reviews.js");

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(__dirname, "..");
const TODAY = utcToday();

interface RegisterPage {
  path: string;
  published: string;
}

const register: { pages: RegisterPage[] } = JSON.parse(readFileSync(path.join(REPO, "data", "page-reviews.json"), "utf-8"));

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const MONTH = MONTHS.join("|");
const FUTURE_TENSE_BEFORE_A_DATE = new RegExp(
  `(^|[^"“])\\b(What['’]s Changing|Effective|Starting|Takes effect|Scheduled for) (?:on )?(${MONTH})(?:[–-](${MONTH}))?(?: (\\d{1,2}))?(?:,? (\\d{4}))?`,
  "g",
);
const ENDED_ON = /which ended (\d{4}-\d{2}-\d{2})/;

interface Construction {
  text: string;
  date: string;
}

const pad = (n: number) => String(n).padStart(2, "0");

function constructionsIn(text: string, publishedYear: number): Construction[] {
  return [...text.matchAll(FUTURE_TENSE_BEFORE_A_DATE)].map(m => {
    const month = MONTHS.indexOf(m[4] ?? m[3]);
    const year = m[6] ? Number(m[6]) : publishedYear;
    const day = m[5] ? Number(m[5]) : new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
    return { text: m[0].slice(m[1].length), date: `${year}-${pad(month + 1)}-${pad(day)}` };
  });
}

const decode = (s: string) =>
  s.replace(/&#39;|&rsquo;|&#x27;/g, "'")
    .replace(/&ldquo;/g, "“").replace(/&rdquo;/g, "”").replace(/&quot;/g, '"')
    .replace(/&ndash;/g, "–").replace(/&mdash;/g, "—").replace(/&middot;/g, "·").replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

const plain = (html: string) => decode(html.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();

interface Page {
  status: number;
  texts: string[];
  byline: string;
}

function readPage(status: number, html: string): Page {
  const title = html.match(/<title>([^<]*)<\/title>/)?.[1] ?? "";
  const meta = html.match(/<meta name="description" content="([^"]*)"/)?.[1] ?? "";
  const body = html.replace(/<head>[\s\S]*?<\/head>/, " ").replace(/<script[\s\S]*?<\/script>/g, " ").replace(/<style[\s\S]*?<\/style>/g, " ");
  const byline = html.match(/<p class="pub-date">([\s\S]*?)<\/p>/)?.[1] ?? "";
  return { status, texts: [plain(title), plain(meta), plain(body)], byline: plain(byline) };
}

let proc: ChildProcess | null = null;
let port = 0;
const pages = new Map<string, Page>();

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
    child.on("error", e => { clearTimeout(timeout); reject(e); });
  });
}

const staleConstructions = (p: RegisterPage): Construction[] =>
  pages.get(p.path)!.texts
    .flatMap(t => constructionsIn(t, Number(p.published.slice(0, 4))))
    .filter(c => c.date < TODAY);

describe("a register page that previews a dated period says when the period has ended", () => {
  before(async () => {
    proc = await startServer();
    for (const p of register.pages) {
      const res = await fetch(`http://localhost:${port}${p.path}`, { redirect: "manual" });
      pages.set(p.path, readPage(res.status, await res.text()));
    }
  });

  after(() => proc?.kill());

  it("adds the ended period after the compilation date on the Q2 2026 preview", () => {
    assert.match(
      pages.get("/q2-pricing-preview-2026")!.byline,
      /· Figures compiled 2026-03-25[^·]* · Previews April–June 2026, which ended 2026-06-30$/,
    );
  });

  it("finds the Q2 2026 preview's title among the constructions it checks", () => {
    const found = staleConstructions({ path: "/q2-pricing-preview-2026", published: "2026-03-25" }).map(c => c.text);
    assert.ok(found.includes("What's Changing April–June"), JSON.stringify(found));
  });

  it("renders no future-tense construction against a date now past unless its byline says the period ended", () => {
    const undisclosed: string[] = [];
    for (const p of register.pages) {
      const ended = pages.get(p.path)!.byline.match(ENDED_ON)?.[1] ?? null;
      for (const c of staleConstructions(p)) {
        if (ended === null || ended < c.date) undisclosed.push(`${p.path}: ${c.text} (${c.date})`);
      }
    }
    assert.deepStrictEqual([...new Set(undisclosed)], []);
  });
});

describe("the detector reads a construction's date as the page states it", () => {
  it("dates a day, a month and a range of months, in the page's year unless the text names one", () => {
    assert.deepStrictEqual(constructionsIn("What's Changing April 1. Takes effect June 30, 2027.", 2026), [
      { text: "What's Changing April 1", date: "2026-04-01" },
      { text: "Takes effect June 30, 2027", date: "2027-06-30" },
    ]);
    assert.deepStrictEqual(constructionsIn("Q2 Preview — What’s Changing April–June", 2026), [{ text: "What’s Changing April–June", date: "2026-06-30" }]);
    assert.deepStrictEqual(constructionsIn("Scheduled for February", 2028), [{ text: "Scheduled for February", date: "2028-02-29" }]);
  });

  it("leaves a vendor's quoted words and a lower-case change label alone", () => {
    assert.deepStrictEqual(constructionsIn(`The changelog states "Starting September 1, 2026, sign-ups reopen".`, 2026), []);
    assert.deepStrictEqual(constructionsIn("odrive free tier discontinued effective March 31, 2026.", 2026), []);
  });
});

describe("the ended-period item", () => {
  const q2 = { from: "2026-04-01", to: "2026-06-30" };

  it("is empty until the day after the period's last day", () => {
    assert.strictEqual(endedPreviewItem(q2, "2026-06-30"), "");
    assert.strictEqual(endedPreviewItem(q2, "2026-07-01"), "Previews April–June 2026, which ended 2026-06-30");
  });

  it("names one month, a range within a year, and a range across years", () => {
    assert.strictEqual(previewedPeriodLabel({ from: "2026-04-01", to: "2026-04-30" }), "April 2026");
    assert.strictEqual(previewedPeriodLabel(q2), "April–June 2026");
    assert.strictEqual(previewedPeriodLabel({ from: "2026-12-01", to: "2027-02-28" }), "December 2026–February 2027");
  });
});
