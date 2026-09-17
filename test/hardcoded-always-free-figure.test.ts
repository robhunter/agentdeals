import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertPopulationFloor } from "./population-floor.ts";

const { statedQuantities, quantitiesNotIn } = await import("../dist/quoted-figures.js");

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(__dirname, "..");

const VENDOR = "Oracle Cloud";
const TIER = "Always Free";
const NAMES_THE_ALLOWANCE = /Ampere A1|OCPU|Arm VM/i;
const NAMES_THE_OFFER = /Oracle/i;
const NAMES_THE_TIER = /Always Free/i;

const PAGES_QUOTING_THE_ALLOWANCE = [
  "/hetzner-pricing-2026",
  "/google-developer-program-2026",
  "/hosting-alternatives",
];

const CHANGE_LOG_SURFACES = ["/pricing-changes", "/vendor/oracle-cloud"];

const ALTERNATIVES_TABLE_ROWS = 10;

function offers(): Array<{ vendor: string; tier: string; description: string }> {
  return JSON.parse(readFileSync(path.join(REPO, "data", "index.json"), "utf-8")).offers;
}

function changes(): Array<{ vendor: string; previous_state?: string; current_state?: string }> {
  return JSON.parse(readFileSync(path.join(REPO, "data", "deal_changes.json"), "utf-8")).changes;
}

function theRecord(): { vendor: string; tier: string; description: string } {
  const held = offers().find(offer => offer.vendor === VENDOR && offer.tier === TIER);
  assert.ok(held, `the catalogue holds no ${TIER} record for ${VENDOR}, so no page can quote one`);
  return held;
}

function statesWeHaveSuperseded(): string[] {
  return changes()
    .filter(change => change.vendor === VENDOR)
    .flatMap(change => [change.previous_state, change.current_state])
    .filter((state): state is string => typeof state === "string" && state !== "");
}

function whatWeHoldAbout(vendorName: string): string[] {
  const stored = offers().filter(offer => offer.vendor === vendorName).map(offer => offer.description);
  const recorded = changes()
    .filter(change => change.vendor === vendorName)
    .flatMap(change => [(change as { summary?: string }).summary, change.previous_state, change.current_state])
    .filter((text): text is string => typeof text === "string");
  return [...stored, ...recorded];
}

function unescapeServed(html: string): string {
  return html
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&mdash;/g, "—")
    .replace(/&ndash;/g, "–")
    .replace(/&#39;|&rsquo;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&");
}

const TEXT_NODE_BREAK = "\u0000";

function textFragments(html: string): string[] {
  return unescapeServed(
    html.replace(/<script[\s\S]*?<\/script>/g, TEXT_NODE_BREAK).replace(/<style[\s\S]*?<\/style>/g, TEXT_NODE_BREAK).replace(/<[^>]*>/g, TEXT_NODE_BREAK),
  )
    .split(TEXT_NODE_BREAK)
    .map(fragment => fragment.replace(/\s+/g, " ").trim())
    .filter(fragment => fragment !== "");
}

function sentencesStatingTheAllowance(html: string): string[] {
  return textFragments(html)
    .flatMap(fragment => fragment.split(/(?<=[.!?])\s+/))
    .map(sentence => sentence.trim())
    .filter(
      sentence =>
        (NAMES_THE_ALLOWANCE.test(sentence) || (NAMES_THE_OFFER.test(sentence) && NAMES_THE_TIER.test(sentence))) &&
        statedQuantities(sentence).length > 0,
    );
}

function startServer(): Promise<{ proc: ChildProcess; port: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn("node", [path.join(REPO, "dist", "serve.js")], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, PORT: "0", BASE_URL: "http://localhost", TZ: "UTC" },
    });
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error("Server startup timeout"));
    }, 120000);
    child.stderr!.on("data", (data: Buffer) => {
      const found = data.toString().match(/running on http:\/\/localhost:(\d+)/);
      if (found) {
        clearTimeout(timeout);
        resolve({ proc: child, port: parseInt(found[1]!, 10) });
      }
    });
    child.on("error", error => {
      clearTimeout(timeout);
      reject(error);
    });
  });
}

let server: { proc: ChildProcess; port: number };
let base = "";

async function fetchPage(route: string): Promise<string> {
  const res = await fetch(`${base}${route}`, { redirect: "manual" });
  assert.strictEqual(res.status, 200, `${route} answered ${res.status}`);
  return res.text();
}

async function sitemapRoutes(): Promise<string[]> {
  const index = await fetchPage("/sitemap.xml");
  const sitemaps = [...index.matchAll(/<loc>([^<]+)<\/loc>/g)].map(found => found[1]!);
  const routes: string[] = [];
  for (const sitemap of sitemaps) {
    const body = await fetchPage(new URL(sitemap).pathname);
    for (const found of body.matchAll(/<loc>([^<]+)<\/loc>/g)) routes.push(new URL(found[1]!).pathname);
  }
  return [...new Set(routes)];
}

async function readAll(routes: string[], concurrency = 8): Promise<Map<string, string>> {
  const read = new Map<string, string>();
  let next = 0;
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      while (next < routes.length) {
        const route = routes[next++]!;
        const res = await fetch(`${base}${route}`, { redirect: "manual" });
        if (res.status === 200) read.set(route, await res.text());
      }
    }),
  );
  return read;
}

describe("#1734 — a page states the Always Free allowance by quoting the record", () => {
  before(async () => {
    server = await startServer();
    base = `http://localhost:${server.port}`;
  });

  it("holds the allowance in the catalogue, where a page can quote it", () => {
    const quantities = statedQuantities(theRecord().description);
    assert.ok(
      quantities.length > 0,
      `the ${VENDOR} ${TIER} record states no quantity, so a page quoting it would state nothing`,
    );
  });

  it("states on every page that names the allowance only what the record carries", async () => {
    const routes = (await sitemapRoutes()).filter(route => !route.startsWith("/vendor/"));
    assertPopulationFloor(routes.length, 700, "pages outside /vendor/ read for this offer's allowance");

    const held = statedQuantities(theRecord().description);
    const superseded = statesWeHaveSuperseded().map(state => statedQuantities(state));

    const unaccounted: string[] = [];
    const quotingTheRecord = new Set<string>();
    const quotingASupersededState = new Set<string>();

    for (const [route, html] of await readAll(routes)) {
      for (const sentence of sentencesStatingTheAllowance(html)) {
        const stated = statedQuantities(sentence);
        if (stated.every(quantity => held.includes(quantity))) {
          quotingTheRecord.add(route);
          continue;
        }
        if (superseded.some(state => stated.every(quantity => state.includes(quantity)))) {
          quotingASupersededState.add(route);
          continue;
        }
        unaccounted.push(`${route}: ${sentence}`);
      }
    }

    assert.deepStrictEqual(
      unaccounted,
      [],
      `a page states an allowance for this offer that neither the record nor any state we superseded carries:\n${unaccounted.join("\n")}`,
    );
    for (const route of PAGES_QUOTING_THE_ALLOWANCE) {
      assert.ok(quotingTheRecord.has(route), `${route} states no allowance for this offer at all`);
    }
    assert.ok(
      quotingASupersededState.has("/pricing-changes"),
      "the change log stopped stating the allowance the record replaced",
    );
  });

  it("keeps the allowance the record replaced wherever we publish what changed", async () => {
    const superseded = statesWeHaveSuperseded().map(state => statedQuantities(state));
    assert.ok(superseded.length > 0, "we hold no superseded state for this offer, so nothing pins the change log");

    for (const route of CHANGE_LOG_SURFACES) {
      const sentences = sentencesStatingTheAllowance(await fetchPage(route));
      const historical = sentences.filter(sentence => {
        const stated = statedQuantities(sentence);
        return superseded.some(state => stated.every(quantity => state.includes(quantity)) && stated.length > 0);
      });
      assert.ok(
        historical.length > 0,
        `${route} no longer states what this offer's allowance was before we corrected it`,
      );
    }
  });
});

describe("#1734 — the alternatives table says where each row's figures come from", () => {
  let rows: string[][] = [];
  let sectionText = "";

  before(async () => {
    if (!server) {
      server = await startServer();
      base = `http://localhost:${server.port}`;
    }
    const html = await fetchPage("/hetzner-pricing-2026");
    const section = html.slice(html.indexOf('id="alternatives"'));
    const table = section.slice(0, section.indexOf("</table>"));
    sectionText = unescapeServed(section.slice(0, section.indexOf("<table")).replace(/<[^>]*>/g, " "))
      .replace(/\s+/g, " ")
      .trim();
    rows = [...table.matchAll(/<tr[\s\S]*?<\/tr>/g)]
      .map(row =>
        [...row[0].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map(cell =>
          unescapeServed(cell[1]!.replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim(),
        ),
      )
      .filter(cells => cells.length > 0);
  });

  after(() => server?.proc.kill());

  it("counts the hand-typed rows the way the table marks them", () => {
    const counted = sectionText.match(/(\d+) of the (\d+) rows are hand-typed/);
    assert.ok(counted, `the section no longer says how many of its rows are hand-typed: ${sectionText.slice(0, 200)}`);
    assert.strictEqual(
      Number(counted[2]),
      rows.length,
      "the section counts a different number of rows than the table renders",
    );
    assert.strictEqual(
      Number(counted[1]),
      rows.filter(cells => (cells[cells.length - 1] ?? "").startsWith("Hand-typed")).length,
      "the section counts a different number of hand-typed rows than the table marks",
    );
    assertPopulationFloor(rows.length, ALTERNATIVES_TABLE_ROWS - 3, "rows in the alternatives table");
  });

  it("leaves no row without a statement of where its figures come from", () => {
    const silent = rows.filter(cells => (cells[cells.length - 1] ?? "") === "").map(cells => cells[0]);
    assert.deepStrictEqual(silent, [], `rows stating no provenance: ${silent.join(", ")}`);
  });

  it("claims a record only for a row whose every figure appears in what we hold", () => {
    const overclaimed = rows
      .filter(cells => (cells[cells.length - 1] ?? "").startsWith("Our record"))
      .map(cells => ({ vendor: cells[0]!, missing: quantitiesNotIn(`${cells[1]} ${cells[2]}`, whatWeHoldAbout(cells[0]!)) }))
      .filter(row => row.missing.length > 0);
    assert.deepStrictEqual(
      overclaimed.map(row => `${row.vendor}: ${row.missing.join(", ")}`),
      [],
      "a row says its figures come from our record and states a quantity that record does not carry",
    );
  });

  it("calls a row hand-typed only where we cannot show the figure in what we hold", () => {
    const understated = rows
      .filter(cells => (cells[cells.length - 1] ?? "").startsWith("Hand-typed"))
      .filter(cells => {
        const held = whatWeHoldAbout(cells[0]!);
        return held.length > 0 && quantitiesNotIn(`${cells[1]} ${cells[2]}`, held).length === 0;
      })
      .map(cells => cells[0]);
    assert.deepStrictEqual(understated, [], `rows called hand-typed that our own records do carry: ${understated.join(", ")}`);
  });

  it("states the tier a reader is being sent to on the one row that costs nothing", () => {
    const free = rows.find(cells => /Free \(Always Free\)/.test(cells[2] ?? ""));
    assert.ok(free, "the alternatives table no longer offers a row that costs nothing");
    assert.deepStrictEqual(
      quantitiesNotIn(free[1]!, [theRecord().description]),
      [],
      "the row that costs nothing states an allowance our own record does not carry",
    );
  });
});
