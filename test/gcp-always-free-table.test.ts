import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const { FIGURE_SOURCE_CLASS } = await import("../dist/source-citation.js");
const { SOURCE_MARKER_IN_A_CELL } = await import("../dist/page-reviews.js");

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");

const PAGE = "/gcp-free-tier-2026";
const CITED_ON_THE_VENDOR_PRICING_PAGE = ["Cloud Scheduler", "Cloud Translation API"];
const SERVICES_THE_HERO_NAMES = ["Cloud Run", "BigQuery"];
const STATED_BY_NEITHER_SOURCE: Array<{ row: string; phrase: RegExp }> = [
  { row: "BigQuery", phrase: /ML model creation/i },
  { row: "Application Integration", phrase: /active connectors/i },
  { row: "Firebase Auth", phrase: /phone auth/i },
  { row: "Firebase Remote Config", phrase: /unlimited/i },
];

let server: ChildProcess;
let html = "";

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

function text(fragment: string): string {
  return fragment
    .replace(/<[^>]+>/g, " ")
    .replace(/&nearr;/g, "")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

type Row = { name: string; limits: string; sources: string[]; resolvesToARecord: boolean };

const CITATION = new RegExp(`<a href="([^"]+)"[^>]*class="${FIGURE_SOURCE_CLASS}"`, "g");

function alwaysFreeRows(): Row[] {
  const section = html.slice(html.indexOf('id="always-free"'));
  const table = section.slice(0, section.indexOf("</table>"));
  const body = table.slice(table.indexOf("</thead>") >= 0 ? table.indexOf("</thead>") : 0);
  return [...body.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)]
    .map(([, row]) => [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map(([, cell]) => cell))
    .filter((cells) => cells.length >= 2)
    .map(([name, limits]) => ({
      name: text(name.replace(new RegExp(SOURCE_MARKER_IN_A_CELL.source, "g"), "")),
      resolvesToARecord: new RegExp(SOURCE_MARKER_IN_A_CELL.source).test(name),
      limits: text(limits),
      sources: [...limits.matchAll(CITATION)].map(([, href]) => href),
    }));
}

function rowNamed(name: string): Row {
  const row = alwaysFreeRows().find((r) => r.name === name);
  assert.ok(row, `the Always Free table on ${PAGE} has no ${name} row`);
  return row;
}

describe(`${PAGE} publishes Google's Always Free quotas (#1623)`, () => {
  before(async () => {
    const started = await startServer();
    server = started.proc;
    const res = await fetch(`${started.base}${PAGE}`);
    assert.strictEqual(res.status, 200);
    html = await res.text();
  });

  after(() => {
    server?.kill();
  });

  it("reads a populated table", () => {
    assert.ok(alwaysFreeRows().length >= 20, `only ${alwaysFreeRows().length} rows were read from the Always Free table`);
  });

  it("states Cloud Build's quota per month, and the callout repeats the table's figure", () => {
    const { limits } = rowNamed("Cloud Build");
    const quota = limits.match(/^[\d,]+ build-minutes\/month/);
    assert.ok(quota, `the Cloud Build row states no monthly build-minute quota: ${limits}`);
    assert.doesNotMatch(limits, /\/day/);
    const callout = text(html.slice(html.indexOf("Add Cloud Build") - 400, html.indexOf("Add Cloud Build") + 200));
    assert.ok(callout.includes(`Add Cloud Build (${quota[0]})`), `the callout does not repeat ${quota[0]}: ${callout}`);
  });

  it("calls no metered service free", () => {
    const calledFree = alwaysFreeRows().filter((r) => /\bfree\)|tier free|steps free/i.test(r.limits));
    assert.deepStrictEqual(calledFree.map((r) => `${r.name}: ${r.limits}`), []);
    assert.ok(!alwaysFreeRows().some((r) => /Cloud Armor/.test(r.name)), "Cloud Armor Standard is billed per policy and per request");
  });

  it("cites the vendor's pricing page on the rows kept on a citation", () => {
    for (const name of CITED_ON_THE_VENDOR_PRICING_PAGE) {
      const { sources } = rowNamed(name);
      assert.ok(
        sources.some((href) => /^https:\/\/cloud\.google\.com\/[a-z-]+\/pricing$/.test(href)),
        `${name} carries no link to a cloud.google.com pricing page: ${JSON.stringify(sources)}`,
      );
    }
  });

  it("cites the page stating the quota on every Always Free row (#1623 AC-5)", () => {
    const rows = alwaysFreeRows();
    const cited = rows.filter((r) => r.sources.some((href) => href.startsWith("https://")));
    const uncited = rows.filter((r) => !cited.includes(r) && !r.resolvesToARecord);
    assert.deepStrictEqual(uncited.map((r) => r.name), []);
    assert.ok(cited.length >= 20, `only ${cited.length} rows carry a source of their own`);
    assert.ok(rows.some((r) => r.resolvesToARecord), "no row resolves to a catalogue record, so that path goes untested");
  });

  it("names each product as Google's free-tier list names it", () => {
    rowNamed("Cloud Run functions");
    assert.ok(!alwaysFreeRows().some((r) => r.name === "Cloud Functions"), "Google lists the product as Cloud Run functions");
  });

  it("drops each clause that neither Google's list nor the product's own pricing page states", () => {
    const rows = alwaysFreeRows();
    const read = STATED_BY_NEITHER_SOURCE.filter(({ row }) => rows.some((r) => r.name === row));
    assert.ok(read.length >= 3, `only ${read.length} of the rows this guard names are in the table`);
    const kept = STATED_BY_NEITHER_SOURCE.flatMap(({ row, phrase }) =>
      rows.filter((r) => r.name === row && phrase.test(r.limits)).map((r) => `${r.name}: ${r.limits}`),
    );
    assert.deepStrictEqual(kept, []);
  });

  it("counts the other services in the introduction from the table", () => {
    const stated = html.match(new RegExp(`${SERVICES_THE_HERO_NAMES[1]} \\([^)]*\\), and (\\d+) other services`));
    assert.ok(stated, "the introduction no longer counts the other Always Free services");
    for (const named of SERVICES_THE_HERO_NAMES) rowNamed(named);
    assert.strictEqual(Number(stated[1]), alwaysFreeRows().length - SERVICES_THE_HERO_NAMES.length);
  });
});
