import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertPopulationFloor } from "./population-floor.ts";

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const STABILITY_CLASSES = ["stable", "improving", "watch", "volatile"];
const FAVOURABLE_CLASSES = ["stable", "improving"];

interface StabilityColumn {
  route: string;
  side: "a" | "b";
  vendor: string;
  badges: string[];
  row: string;
}

const decoded = (text: string) =>
  text
    .replace(/&mdash;/g, "—")
    .replace(/&middot;/g, "·")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");

const readable = (markup: string) => decoded(markup.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();

function stabilityColumnsOf(route: string, page: string): StabilityColumn[] {
  const grid = page.slice(page.indexOf('<div class="compare-grid">'), page.indexOf("<h2>Key Differences</h2>"));
  return grid.split('<div class="vendor-col">').slice(1).map((column, at) => {
    const heading = column.match(/<h3>([\s\S]*?)<\/h3>/)?.[1] ?? "";
    const row = column.match(/<span class="detail-label">Stability<\/span><span class="detail-value">([\s\S]*?)<\/span><\/div>/)?.[1];
    return {
      route,
      side: at === 0 ? "a" : "b",
      vendor: decoded(heading.match(/<a href="\/vendor\/[a-z0-9-]+">([^<]+)<\/a>/)?.[1] ?? ""),
      badges: [...heading.matchAll(/<span style="[^"]*border:1px solid[^"]*">([^<]*)<\/span>/g)].map((badge) => badge[1]!),
      row: row === undefined ? "(no Stability row)" : readable(row),
    };
  });
}

function startServer(env: Record<string, string>): Promise<{ server: ChildProcess; base: string }> {
  return new Promise((resolve, reject) => {
    const server = spawn("node", [path.join(REPO, "dist", "serve.js")], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, PORT: "0", BASE_URL: "http://localhost", TZ: "UTC", ...env },
    });
    const timeout = setTimeout(() => {
      server.kill();
      reject(new Error("Server startup timeout"));
    }, 60000);
    server.stderr!.on("data", (data: Buffer) => {
      const match = data.toString().match(/running on http:\/\/localhost:(\d+)/);
      if (match) {
        clearTimeout(timeout);
        resolve({ server, base: `http://localhost:${match[1]}` });
      }
    });
    server.on("error", (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });
}

async function readVsColumns(base: string): Promise<StabilityColumn[]> {
  const sitemap = await (await fetch(`${base}/sitemap-comparisons.xml`)).text();
  const routes = [...sitemap.matchAll(/<loc>http:\/\/localhost(\/[a-z0-9-]+-vs-[a-z0-9-]+)<\/loc>/g)].map(([, route]) => route!);
  const columns: StabilityColumn[] = [];
  for (const route of routes) {
    const page = await (await fetch(`${base}${route}`)).text();
    if (page.includes('<div class="compare-grid">')) columns.push(...stabilityColumnsOf(route, page));
  }
  return columns;
}

async function publishedStabilities(base: string, columns: StabilityColumn[]): Promise<Map<string, string | null>> {
  const published = new Map<string, string | null>();
  for (const vendor of new Set(columns.map((column) => column.vendor))) {
    const details = await (await fetch(`${base}/api/details/${encodeURIComponent(vendor)}`)).json();
    assert.ok(details.offer, `/api/details has no listing for ${vendor}`);
    published.set(vendor, details.offer.stability ?? null);
  }
  return published;
}

function misprinted(columns: StabilityColumn[], published: Map<string, string | null>): string[] {
  return columns.flatMap((column) => {
    const stability = published.get(column.vendor) ?? null;
    const describe = `${column.route} ${column.vendor}: badges ${JSON.stringify(column.badges)}, row ${JSON.stringify(column.row)}, published ${JSON.stringify(stability)}`;
    if (stability !== null) {
      return column.badges.length === 1 && column.badges[0] === stability && column.row === stability ? [] : [describe];
    }
    const statesAClass = STABILITY_CLASSES.some((word) => new RegExp(`\\b${word}\\b`, "i").test(column.row));
    const durabilityWording = column.row === "—" || column.row.startsWith("not published");
    return column.badges.length === 0 && !statesAClass && durabilityWording ? [] : [describe];
  });
}

const PLANTED_CHECK = { checked: "2026-10-01", outcome: "unreadable", detail: "the page could not be read" };

describe("a vs page prints a stability class for a vendor only when the class is published", () => {
  let live: { server: ChildProcess; base: string };
  let planted: { server: ChildProcess; base: string };
  let liveColumns: StabilityColumn[] = [];
  let livePublished = new Map<string, string | null>();
  let plantedColumns: StabilityColumn[] = [];
  let plantedPublished = new Map<string, string | null>();
  const plantedVendors: string[] = [];
  const scratch = mkdtempSync(path.join(tmpdir(), "vs-page-withheld-stability-"));

  before(async () => {
    live = await startServer({});
    liveColumns = await readVsColumns(live.base);
    livePublished = await publishedStabilities(live.base, liveColumns);

    for (const side of ["a", "b"] as const) {
      const favourable = liveColumns.find((column) =>
        column.side === side && FAVOURABLE_CLASSES.includes(livePublished.get(column.vendor) ?? "") && !plantedVendors.includes(column.vendor));
      if (favourable) plantedVendors.push(favourable.vendor);
    }
    const catalogue = JSON.parse(readFileSync(path.join(REPO, "data", "index.json"), "utf-8"));
    for (const vendor of plantedVendors) {
      const listing = catalogue.offers.find((offer: { vendor: string }) => offer.vendor.toLowerCase() === vendor.toLowerCase());
      listing.source_check = PLANTED_CHECK;
    }
    const scratchIndex = path.join(scratch, "index.json");
    writeFileSync(scratchIndex, JSON.stringify(catalogue));
    planted = await startServer({ AGENTDEALS_INDEX_PATH: scratchIndex });
    plantedColumns = await readVsColumns(planted.base);
    plantedPublished = await publishedStabilities(planted.base, plantedColumns);
  });

  after(() => {
    live?.server.kill();
    planted?.server.kill();
    rmSync(scratch, { recursive: true, force: true });
  });

  it("reads two vendor columns, each with a Stability row, on every vs page", () => {
    const routes = new Set(liveColumns.map((column) => column.route));
    assertPopulationFloor(routes.size, 10, "vs pages carrying a vendor grid");
    const malformed = [...routes].filter((route) => {
      const columns = liveColumns.filter((column) => column.route === route);
      return columns.length !== 2 || columns.some((column) => column.vendor === "" || column.row === "(no Stability row)");
    });
    assert.deepStrictEqual(malformed, []);
  });

  it("prints the published class in the heading badge and the Stability row, and neither for a withheld class", () => {
    assert.deepStrictEqual(misprinted(liveColumns, livePublished), []);
    const publishing = liveColumns.filter((column) => livePublished.get(column.vendor) !== null);
    assertPopulationFloor(publishing.length, 10, "vs page columns whose vendor's stability class is published");
  });

  it("drops the badge and the class from a column once its vendor's favourable class is withheld", () => {
    assert.strictEqual(plantedVendors.length, 2, `found ${plantedVendors.length} vs page vendors with a favourable published class to withhold, one per side`);
    for (const vendor of plantedVendors) {
      assert.strictEqual(plantedPublished.get(vendor), null, `${vendor}'s class is still published with an unreadable source check`);
    }
    const sides = new Set(plantedColumns.filter((column) => plantedVendors.includes(column.vendor)).map((column) => column.side));
    assert.deepStrictEqual([...sides].sort(), ["a", "b"]);
    assert.deepStrictEqual(misprinted(plantedColumns, plantedPublished), []);
  });

  it("says in the row why a withheld class is not published", () => {
    const withheldRows = plantedColumns.filter((column) => plantedVendors.includes(column.vendor)).map((column) => column.row);
    const unexplained = withheldRows.filter((row) => !/^not published \S/.test(row));
    assert.deepStrictEqual(unexplained, []);
  });
});
