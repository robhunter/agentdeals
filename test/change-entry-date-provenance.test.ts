import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { assertPopulationFloor } from "./population-floor.ts";
import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  changeEntryDateLabel,
  DISCOVERED_DATE_PREFIX,
  EFFECTIVE_DATE_PREFIX,
  UNDATED_TILE_LABEL,
  UNKNOWN_EFFECTIVE_DATE_MARKER,
} from "../dist/change-dates.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(__dirname, "..");

const TODAY = new Date().toISOString().slice(0, 10);
const dayOffset = (days: number) =>
  new Date(Date.parse(TODAY) + days * 86400000).toISOString().slice(0, 10);

const SUBJECT = "Xata";
const CONTROL = "Hyperping";
const CONTROL_DATE = dayOffset(-10);
const SUMMARY = "Free storage allowance cut from 15 GB to 5 GB.";
const FIELD_SLACK = 20;

function change(vendor: string, date: string, dateSource: string, summary: string) {
  return {
    vendor,
    change_type: "limits_reduced",
    date,
    date_source: dateSource,
    summary,
    previous_state: "15 GB storage",
    current_state: "5 GB storage",
    impact: "high",
    source_url: `https://example.com/${vendor.toLowerCase()}/pricing`,
    category: "Databases",
    alternatives: [],
    recorded_date: TODAY,
    ...(dateSource === "discovered" ? { detected_by: "reverify-ai" } : {}),
  };
}

function visibleText(body: string): string {
  return body
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&mdash;/g, "—")
    .replace(/&ndash;/g, "–")
    .replace(/&nbsp;/g, " ")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ");
}

function isDateField(text: string, date: string): boolean {
  const remainder = text
    .replace(date, "")
    .replace(UNKNOWN_EFFECTIVE_DATE_MARKER, "")
    .replace(EFFECTIVE_DATE_PREFIX, "")
    .replace(DISCOVERED_DATE_PREFIX, "")
    .replace(/[·\u2014\u2013-]/g, "")
    .trim();
  return remainder.length <= FIELD_SLACK;
}

function dateFields(body: string, date: string): string[] {
  const found: string[] = [];
  const withoutScripts = body.replace(/<script[\s\S]*?<\/script>/gi, " ");
  for (const node of withoutScripts.matchAll(/>([^<>]*)</g)) {
    const text = node[1].trim();
    if (!text.includes(date)) continue;
    if (!isDateField(text, date)) continue;
    found.push(text);
  }
  return found;
}

const BROWSER_ASSEMBLED = ["/compare-tool", "/stack-check"];

const EXEMPT: Array<{ name: string; allows: (field: string) => boolean }> = [
  {
    name: "the risk chip beside a vendor's name, which rates the vendor rather than listing the change",
    allows: (field) => /^(?:discovered )?\d{4}-\d{2}-\d{2} [a-z ]+$/.test(field),
  },
];

function startServer(changesPath: string): Promise<{ proc: ChildProcess; port: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn("node", [path.join(REPO, "dist", "serve.js")], {
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        PORT: "0",
        BASE_URL: "http://localhost:3000",
        AGENTDEALS_CHANGES_PATH: changesPath,
      },
    });
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error("Server startup timeout"));
    }, 30000);
    child.stderr!.on("data", (data: Buffer) => {
      const m = data.toString().match(/running on http:\/\/localhost:(\d+)/);
      if (m) {
        clearTimeout(timeout);
        resolve({ proc: child, port: parseInt(m[1], 10) });
      }
    });
    child.on("error", (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });
}

describe("the label an entry carries beside its date", () => {
  it("says an event date is the date the terms took effect", () => {
    assert.strictEqual(
      changeEntryDateLabel({ date: TODAY, date_source: "vendor_page" } as never),
      `${EFFECTIVE_DATE_PREFIX} ${TODAY}`
    );
    assert.strictEqual(
      changeEntryDateLabel({ date: TODAY, date_source: "hand_written" } as never),
      `${EFFECTIVE_DATE_PREFIX} ${TODAY}`
    );
  });

  it("says a discovery date is not one, in the entry rather than above it", () => {
    const label = changeEntryDateLabel({ date: TODAY, date_source: "discovered" } as never);
    assert.ok(label.startsWith(`${DISCOVERED_DATE_PREFIX} ${TODAY}`), label);
    assert.ok(label.includes(UNKNOWN_EFFECTIVE_DATE_MARKER), label);
  });

  it("stays short enough to repeat on every entry", () => {
    const label = changeEntryDateLabel({ date: TODAY, date_source: "discovered" } as never);
    assert.ok(label.length <= 60, `${label.length} characters: ${label}`);
  });
});

const NOT_A_CHANGE_RECORD: Array<{ expr: string; why: string }> = [
  { expr: "escHtmlServer(tie.date)", why: "the UTC day the ranking permutation is seeded on" },
  { expr: "escHtmlServer(p.date)", why: "the day a press mention was published" },
  { expr: "escHtmlServer(e.date)", why: "a hand-written editorial timeline, which carries no record" },
  { expr: "date: r.date", why: "the day an analytics rollup covers" },
];

describe("nothing renders a change date without saying which kind of date it is", () => {
  const source = readFileSync(path.join(REPO, "src", "serve.ts"), "utf8").split("\n");
  const LABELLED = /change(?:Entry)?DateLabel(?:For|Fn)?|changeEntryLongDateLabel|changeDateClause|feedEntryUpdated|toISOString/;
  const TEXT_NODE = />\s*(?:\$\{([^{}]*(?:\{[^{}]*\}[^{}]*)*)\}|'\s*\+\s*([^+]*?)\s*\+\s*')\s*</g;
  const REFORMATTED = /new Date\(([A-Za-z_$][\w$.]*\.date)\)\.toLocale\w*\(/g;
  const COPIED_RAW = /\bdate:\s*([A-Za-z_$][\w$.]*\.date)\b/g;

  const dateTextNodes = source.flatMap((line, i) =>
    [...line.matchAll(TEXT_NODE)]
      .map((m) => (m[1] ?? m[2] ?? "").trim())
      .filter((expr) => /\.date\b/.test(expr) && !LABELLED.test(expr))
      .map((expr) => ({ line: i + 1, expr }))
  );

  const reformatted = source.flatMap((line, i) =>
    LABELLED.test(line) ? [] : [...line.matchAll(REFORMATTED)].map((m) => ({ line: i + 1, expr: m[0] }))
  );

  const travelsWithProvenance = (i: number) =>
    source.slice(Math.max(0, i - 1), i + 3).some((l) => /dateClause|date_source/.test(l));

  const copiedRaw = source.flatMap((line, i) =>
    travelsWithProvenance(i) || LABELLED.test(line)
      ? []
      : [...line.matchAll(COPIED_RAW)].map((m) => ({ line: i + 1, expr: m[0] }))
  );

  const unlabelled = (line: string) =>
    [...line.matchAll(TEXT_NODE)]
      .map((m) => (m[1] ?? m[2] ?? "").trim())
      .filter((expr) => /\.date\b/.test(expr) && !LABELLED.test(expr));

  it("finds the date fields it is meant to be scanning", () => {
    const labelled = source.filter((line) => /change(?:Entry)?DateLabel\(/.test(line)).length;
    assertPopulationFloor(labelled, 20, "lines rendering a change date through a labelling helper");
  });

  it("reformats a change date only through a labelling helper", () => {
    const offenders = reformatted
      .filter(({ expr }) => !expr.includes("r.date"))
      .map(({ line, expr }) => `src/serve.ts:${line}: ${expr}`);
    assert.deepStrictEqual(offenders, []);
  });

  it("never copies a change date into another object without its provenance", () => {
    const offenders = copiedRaw
      .filter(({ expr }) => !NOT_A_CHANGE_RECORD.some((e) => e.expr === expr))
      .map(({ line, expr }) => `src/serve.ts:${line}: ${expr}`);
    assert.deepStrictEqual(offenders, []);
  });

  it("catches a change date put back into a text node unlabelled", () => {
    assert.deepStrictEqual(unlabelled('<span class="d">${c.date}</span>'), ["c.date"]);
    assert.deepStrictEqual(unlabelled("'<td>' + escHtmlServer(c.date) + '</td>'"), ["escHtmlServer(c.date)"]);
    assert.deepStrictEqual(unlabelled('<span class="d">${changeEntryDateLabel(c)}</span>'), []);
    assert.deepStrictEqual(unlabelled('<a href="#${toSlug(c.vendor)}-${c.date}">link</a>'), []);
  });

  it("catches a change date reformatted or handed to a browser unlabelled", () => {
    const fires = (re: RegExp, line: string) => (LABELLED.test(line) ? [] : [...line.matchAll(re)].map((m) => m[0]));
    assert.deepStrictEqual(fires(REFORMATTED, '  const s = new Date(c.date).toLocaleDateString("en-US", {});'), [
      "new Date(c.date).toLocaleDateString(",
    ]);
    assert.deepStrictEqual(fires(REFORMATTED, "  const s = changeEntryLongDateLabel(c);"), []);
    assert.deepStrictEqual(fires(COPIED_RAW, "    risk_cause: { date: cause.date, summary: cause.summary }"), [
      "date: cause.date",
    ]);
    assert.deepStrictEqual(fires(COPIED_RAW, "    risk_cause: { date: changeEntryDateLabel(cause) }"), []);
  });

  it("routes every date a change record carries through a labelling helper", () => {
    const offenders = dateTextNodes
      .filter(({ expr }) => !NOT_A_CHANGE_RECORD.some((e) => e.expr === expr))
      .map(({ line, expr }) => `src/serve.ts:${line}: ${expr}`);
    assert.deepStrictEqual(offenders, []);
  });

  it("keeps every declared non-record date in use", () => {
    const scanned = [...dateTextNodes, ...copiedRaw];
    const unused = NOT_A_CHANGE_RECORD.filter((e) => !scanned.some(({ expr }) => expr === e.expr));
    assert.deepStrictEqual(unused.map((e) => `${e.expr} — ${e.why}`), []);
  });
});

describe("an entry lifted out of its section still says what its date is", () => {
  let tmp: string;
  const servers: ChildProcess[] = [];
  let routes: string[] = [];
  let ENTRY_DATE = "";
  let discoveredPort = 0;
  const rendered = new Map<string, { discovered: string; dated: string }>();

  before(async () => {
    tmp = mkdtempSync(path.join(tmpdir(), "change-entry-provenance-"));
    const write = (name: string, changes: unknown[]) => {
      const p = path.join(tmp, name);
      writeFileSync(p, JSON.stringify({ changes }));
      return p;
    };
    const control = change(CONTROL, CONTROL_DATE, "vendor_page", "Monitor allowance cut.");
    ENTRY_DATE = dayOffset(-3);

    const discovered = await startServer(
      write("discovered.json", [control, change(SUBJECT, ENTRY_DATE, "discovered", SUMMARY)])
    );
    const dated = await startServer(
      write("dated.json", [control, change(SUBJECT, ENTRY_DATE, "vendor_page", SUMMARY)])
    );
    servers.push(discovered.proc, dated.proc);
    discoveredPort = discovered.port;

    const index = await (await fetch(`http://localhost:${discovered.port}/sitemap.xml`)).text();
    const locs: string[] = [];
    for (const m of index.matchAll(/<loc>([^<]+)<\/loc>/g)) {
      const childPath = new URL(m[1]).pathname;
      const xml = await (await fetch(`http://localhost:${discovered.port}${childPath}`)).text();
      for (const inner of xml.matchAll(/<loc>([^<]+)<\/loc>/g)) locs.push(new URL(inner[1]).pathname);
    }
    routes = [...new Set([...locs, ...BROWSER_ASSEMBLED, `/vendor/${SUBJECT.toLowerCase()}`])];

    const queue = [...routes];
    async function worker() {
      for (;;) {
        const route = queue.shift();
        if (!route) return;
        try {
          const [a, b] = await Promise.all([
            fetch(`http://localhost:${discovered.port}${route}`),
            fetch(`http://localhost:${dated.port}${route}`),
          ]);
          if (a.status !== 200 || b.status !== 200) continue;
          const bodies = { discovered: await a.text(), dated: await b.text() };
          if (bodies.discovered.includes(SUMMARY)) rendered.set(route, bodies);
        } catch {
          continue;
        }
      }
    }
    await Promise.all(Array.from({ length: 6 }, worker));
  });

  after(() => {
    for (const proc of servers) proc.kill();
    if (tmp) rmSync(tmp, { recursive: true, force: true });
  });

  it("reaches enough of the site for the sweep below to mean something", () => {
    assertPopulationFloor(routes.length, 1001, "routes enumerated from the sitemap");
    assert.ok(rendered.size > 8, `only ${rendered.size} routes rendered the entry at all`);
  });

  it("would fail if a date field printed the date without saying which date it is", () => {
    const seen = [...rendered].filter(([, b]) => dateFields(b.dated, ENTRY_DATE).length > 0);
    assertPopulationFloor(seen.length, 6, "routes putting the entry's date in a field of its own");
  });

  it("declares an effective date as one in every field that prints it", () => {
    const offenders: string[] = [];
    for (const [route, b] of rendered) {
      for (const field of dateFields(b.dated, ENTRY_DATE)) {
        if (field.includes(`${EFFECTIVE_DATE_PREFIX} ${ENTRY_DATE}`)) continue;
        if (EXEMPT.some((e) => e.allows(field))) continue;
        offenders.push(`${route}: ${field}`);
      }
    }
    assert.deepStrictEqual(offenders, []);
  });

  it("says the effective date is unknown in every field that prints a discovery date", () => {
    const offenders: string[] = [];
    for (const [route, b] of rendered) {
      for (const field of dateFields(b.discovered, ENTRY_DATE)) {
        if (
          field.includes(`${DISCOVERED_DATE_PREFIX} ${ENTRY_DATE}`) &&
          field.includes(UNKNOWN_EFFECTIVE_DATE_MARKER)
        ) {
          continue;
        }
        if (EXEMPT.some((e) => e.allows(field))) continue;
        offenders.push(`${route}: ${field}`);
      }
    }
    assert.deepStrictEqual(offenders, []);
  });

  it("keeps every declared exemption in use", () => {
    const fires = (e: (typeof EXEMPT)[number]) =>
      [...rendered.values()].some((b) =>
        [...dateFields(b.discovered, ENTRY_DATE), ...dateFields(b.dated, ENTRY_DATE)].some((f) => e.allows(f))
      );
    assert.deepStrictEqual(EXEMPT.filter((e) => !fires(e)).map((e) => e.name), []);
  });

  it("ships the same wording to the pages that assemble an entry in the browser", async () => {
    for (const route of BROWSER_ASSEMBLED) {
      const body = await (await fetch(`http://localhost:${discoveredPort}${route}`)).text();
      assert.ok(body.includes(UNKNOWN_EFFECTIVE_DATE_MARKER), `${route} ships no marker`);
      assert.ok(body.includes(EFFECTIVE_DATE_PREFIX), `${route} ships no event-date prefix`);
    }
  });

  it("agrees with itself and with the API on how many entries it cannot date", async () => {
    const tile = (body: string): number => {
      const m = body.match(
        new RegExp(`<div class="stat-value">(\\d+)</div>\\s*<div class="stat-label">${UNDATED_TILE_LABEL}</div>`)
      );
      assert.ok(m, "no undated tile");
      return parseInt(m![1], 10);
    };
    const get = async (route: string) =>
      await (await fetch(`http://localhost:${discoveredPort}${route}`)).text();
    const api = JSON.parse(await get("/api/changes?since=2000-01-01&limit=1000"));
    assert.strictEqual(api.date_provenance.discovered, 1);
    assert.strictEqual(tile(await get("/pricing-changes")), api.date_provenance.discovered);
    assert.strictEqual(tile(await get("/changes")), api.date_provenance.discovered);
  });
});
