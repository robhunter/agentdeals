import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const dayBefore = (date: string) => new Date(Date.parse(`${date}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
const TODAY = new Date().toISOString().slice(0, 10);
const YESTERDAY = dayBefore(TODAY);
const MARKER = "Data correction - fixture row that no page listing pricing changes may print";
const RETRACTED_MARKER = "fixture-row-we-retracted";

type LoggedChange = { vendor: string; change_type: string; date: string; resolution?: unknown };

const liveLog = JSON.parse(readFileSync(path.join(REPO, "data", "deal_changes.json"), "utf8"));
const catalogue = JSON.parse(readFileSync(path.join(REPO, "data", "index.json"), "utf8"));
const everyVendor: string[] = [...new Set<string>(catalogue.offers.map((o: { vendor: string }) => o.vendor))];
const madeByTheVendor = (c: LoggedChange) => c.change_type !== "record_corrected" && !c.resolution;

const fixtureRow = {
  previous_state: "Our earlier entry",
  current_state: "Our corrected entry",
  impact: "high",
  category: "APIs",
  alternatives: [],
  recorded_date: YESTERDAY,
  date_source: "hand_written",
};

const retraction = (vendor: string) => ({
  summary: `${RETRACTED_MARKER} (${vendor})`,
  source_url: `https://example.com/${RETRACTED_MARKER}`,
  resolution: { state: "retracted", date: TODAY, detail: "Fixture." },
});

const ourCorrectionBesideEveryVendor = everyVendor.map(vendor => ({
  ...fixtureRow,
  vendor,
  change_type: "record_corrected",
  date: TODAY,
  summary: `${MARKER} (${vendor})`,
  source_url: "https://example.com/pricing",
}));

const aRetractedRemovalBesideEveryVendor = everyVendor.map(vendor => ({
  ...fixtureRow,
  vendor,
  change_type: "free_tier_removed",
  date: TODAY,
  ...retraction(vendor),
}));

const logWithARetractedCopyAheadOfEachVendorChange: LoggedChange[] = liveLog.changes.flatMap((c: LoggedChange) =>
  madeByTheVendor(c) ? [{ ...c, date: dayBefore(c.date), ...retraction(c.vendor) }, c] : [c],
);

const LOGS_THAT_LIST_EVERY_RECORD = new Set(["/changes", "/pricing-changes"]);
const listsAVendorsOwnHistory = (route: string) => route.startsWith("/vendor/");
const printsOneOfOurRows = (html: string) => html.includes(MARKER) || html.includes(RETRACTED_MARKER);

const scratch = mkdtempSync(path.join(tmpdir(), "vendor-made-pages-"));
const changesPath = path.join(scratch, "deal_changes.json");
writeFileSync(changesPath, JSON.stringify({
  ...liveLog,
  changes: [...logWithARetractedCopyAheadOfEachVendorChange, ...ourCorrectionBesideEveryVendor, ...aRetractedRemovalBesideEveryVendor],
}));

function serve(env: Record<string, string>): Promise<{ child: ChildProcess; port: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn("node", [path.join(REPO, "dist", "serve.js")], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, PORT: "0", BASE_URL: "http://localhost", TZ: "UTC", ...env },
    });
    const timeout = setTimeout(() => { child.kill(); reject(new Error("Server startup timeout")); }, 60000);
    child.stderr!.on("data", (data: Buffer) => {
      const m = data.toString().match(/running on http:\/\/localhost:(\d+)/);
      if (m) { clearTimeout(timeout); resolve({ child, port: parseInt(m[1], 10) }); }
    });
    child.on("error", (e) => { clearTimeout(timeout); reject(e); });
  });
}

let server: ChildProcess;
let port = 0;
let serverWithoutOurRows: ChildProcess;
let portWithoutOurRows = 0;

before(async () => {
  [{ child: server, port }, { child: serverWithoutOurRows, port: portWithoutOurRows }] = await Promise.all([
    serve({ AGENTDEALS_CHANGES_PATH: changesPath }),
    serve({}),
  ]);
});

after(() => {
  server?.kill();
  serverWithoutOurRows?.kill();
  rmSync(scratch, { recursive: true, force: true });
});

const locsIn = (xml: string) => [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map(([, loc]) => new URL(loc).pathname);
const routesIn = async (sitemap: string) => locsIn(await (await fetch(`http://localhost:${port}${sitemap}`)).text());

async function routesInEverySitemap(): Promise<string[]> {
  const routes = new Set<string>();
  for (const sitemap of await routesIn("/sitemap.xml")) {
    for (const route of await routesIn(sitemap)) routes.add(route);
  }
  return [...routes];
}

async function routesPrintingOurRows(routes: string[]): Promise<{ printing: string[]; read: number }> {
  const printing: string[] = [];
  let read = 0;
  const queue = [...routes];
  const reader = async () => {
    for (let route = queue.shift(); route !== undefined; route = queue.shift()) {
      const res = await fetch(`http://localhost:${port}${route}`);
      if (res.status !== 200) { await res.arrayBuffer(); continue; }
      read++;
      if (printsOneOfOurRows(await res.text())) printing.push(route);
    }
  };
  await Promise.all(Array.from({ length: 4 }, reader));
  return { printing: printing.sort(), read };
}

describe("a page that lists pricing changes lists only the changes the vendor made", () => {
  it("prints none of our own corrections or retractions outside the logs and the vendor's own history", async () => {
    assert.ok(everyVendor.length > 0, "the catalogue holds no vendor, so no correction can be placed beside one");
    assert.ok(liveLog.changes.some(madeByTheVendor), "the log holds no vendor change, so no retracted copy can be placed ahead of one");
    const sitemapRoutes = await routesInEverySitemap();
    for (const route of ["/deadlines", "/ai-free-tiers", "/railway-vs-render", "/datadog-alternatives"]) {
      assert.ok(sitemapRoutes.includes(route), `${route} is missing from the sitemaps this sweep reads`);
    }
    assert.ok(sitemapRoutes.some(r => r.startsWith("/compare/")), "no /compare/ page is in the sitemaps this sweep reads");
    const routes = sitemapRoutes.filter(r => !LOGS_THAT_LIST_EVERY_RECORD.has(r) && !listsAVendorsOwnHistory(r));
    const { printing, read } = await routesPrintingOurRows(routes);
    assert.ok(read > routes.length / 2, `only ${read} of ${routes.length} routes answered, so the sweep did not read the site`);
    assert.deepStrictEqual(printing, []);
  });

  it("prints none of them in the embeddable widgets", async () => {
    const vendorPages = (await routesIn("/sitemap-vendors.xml")).filter(listsAVendorsOwnHistory);
    const widgets = ["/embed/changes", ...vendorPages.map(r => r.replace(/^\/vendor\//, "/embed/vendor/"))];
    assert.ok(vendorPages.length > 0, "the vendor sitemap lists no vendor page, so no vendor widget was read");
    const { printing, read } = await routesPrintingOurRows(widgets);
    assert.ok(read > widgets.length / 2, `only ${read} of ${widgets.length} widgets answered`);
    assert.deepStrictEqual(printing, []);
  });

  it("counts the same changes for each vendor on the comparison and category pages whether or not the log holds our rows", async () => {
    const countsOfAVendorsChanges = (html: string) => [
      ...[...html.matchAll(/<span class="detail-label">Changes<\/span><span class="detail-value">(\d+) recorded</g)].map(m => m[1]),
      ...[...html.matchAll(/ has (\d+) recorded changes?\b/g)].map(m => m[1]),
      ...[...html.matchAll(/(\d+|no) pricing changes? recorded across/g)].map(m => m[1]),
    ];
    const routes = [
      ...(await routesIn("/sitemap-comparisons.xml")),
      ...(await routesIn("/sitemap-pages.xml")).filter(r => r.startsWith("/category/")),
    ];
    const moved: string[] = [];
    let counted = 0;
    for (const route of routes) {
      const [withOurRows, withoutOurRows] = await Promise.all([
        fetch(`http://localhost:${port}${route}`).then(r => r.text()),
        fetch(`http://localhost:${portWithoutOurRows}${route}`).then(r => r.text()),
      ]);
      const counts = countsOfAVendorsChanges(withoutOurRows);
      if (counts.length === 0) continue;
      counted++;
      if (countsOfAVendorsChanges(withOurRows).join() !== counts.join()) moved.push(route);
    }
    assert.ok(counted > routes.length / 2, `only ${counted} of ${routes.length} pages state a count of a vendor's changes`);
    assert.deepStrictEqual(moved, []);
  });

  it("keeps listing our corrections in the logs", async () => {
    for (const route of LOGS_THAT_LIST_EVERY_RECORD) {
      const html = await (await fetch(`http://localhost:${port}${route}`)).text();
      assert.ok(html.includes(MARKER), `${route} no longer lists our corrections`);
    }
  });

  it("keeps our corrections and retractions, labelled, in the vendor's own history", async () => {
    const [vendorPage] = (await routesIn("/sitemap-vendors.xml")).filter(listsAVendorsOwnHistory);
    assert.ok(vendorPage, "the vendor sitemap lists no vendor page");
    const html = await (await fetch(`http://localhost:${port}${vendorPage}`)).text();
    assert.ok(html.includes(MARKER), `${vendorPage} no longer lists our correction`);
    assert.ok(html.includes(RETRACTED_MARKER), `${vendorPage} no longer lists our retraction`);
  });
});
