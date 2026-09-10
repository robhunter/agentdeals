import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertCoversPopulation, assertPopulationFloor, vendorsInTheCatalogue } from "./population-floor.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let serverPort = 0;
let serverProc: ChildProcess | null = null;

function startServer(): Promise<ChildProcess> {
  return new Promise((resolve, reject) => {
    const serverPath = path.join(__dirname, "..", "dist", "serve.js");
    const proc = spawn("node", [serverPath], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, PORT: "0", BASE_URL: "http://localhost" },
    });
    const timeout = setTimeout(() => { proc.kill(); reject(new Error("Server startup timeout")); }, 10000);
    proc.stderr!.on("data", (data: Buffer) => {
      const match = data.toString().match(/running on http:\/\/localhost:(\d+)/);
      if (match) {
        serverPort = parseInt(match[1], 10);
        clearTimeout(timeout);
        resolve(proc);
      }
    });
    proc.on("error", (err) => { clearTimeout(timeout); reject(err); });
  });
}

const PROMISE_MARKERS = [
  "marketplace-solicitation",
  "60% commission",
  "Submit a referral code",
  "Submit your referral code",
  "Know a referral or partner program",
  "Earn Revenue",
  "earn revenue when agents use it",
  "earn revenue share when your codes convert",
  "Get paid when your codes convert",
  "Register on the Marketplace",
  "Revenue Splits",
  "Accepting Submissions",
  'href="/marketplace"',
];

async function allSitemapPaths(): Promise<string[]> {
  const indexRes = await fetch(`http://localhost:${serverPort}/sitemap.xml`);
  assert.strictEqual(indexRes.status, 200);
  const children = [...(await indexRes.text()).matchAll(/<loc>([^<]+)<\/loc>/g)].map(m => m[1]);
  assert.ok(children.length >= 4, `sitemap index listed ${children.length} sitemaps`);

  const paths = new Set<string>(["/"]);
  for (const child of children) {
    const childPath = new URL(child, "http://localhost").pathname;
    const res = await fetch(`http://localhost:${serverPort}${childPath}`);
    assert.strictEqual(res.status, 200, `${childPath} answered ${res.status}`);
    for (const m of (await res.text()).matchAll(/<loc>([^<]+)<\/loc>/g)) {
      paths.add(new URL(m[1], "http://localhost").pathname);
    }
  }
  return [...paths];
}

describe("no published page offers revenue for a submitted referral code", () => {
  before(async () => { serverProc = await startServer(); });
  after(() => { serverProc?.kill(); });

  it("every route in the sitemap is clean", async () => {
    const paths = await allSitemapPaths();
    assertCoversPopulation(paths.length, vendorsInTheCatalogue(), "routes in the sitemap the sweep read");

    const offenders: string[] = [];
    for (const p of paths) {
      const res = await fetch(`http://localhost:${serverPort}${p}`);
      if (res.status !== 200) {
        offenders.push(`${p}: answered ${res.status}`);
        continue;
      }
      const html = await res.text();
      const found = PROMISE_MARKERS.filter(marker => html.includes(marker));
      if (found.length > 0) offenders.push(`${p}: ${found.join(", ")}`);
    }
    assert.deepStrictEqual(offenders.slice(0, 20), [], `${offenders.length} routes of ${paths.length}`);
  });

  it("each marker is one the sweep would actually flag", () => {
    for (const marker of PROMISE_MARKERS) {
      assert.ok(marker.length > 0);
      const page = `<html><body><p>lorem ${marker} ipsum</p></body></html>`;
      assert.deepStrictEqual(PROMISE_MARKERS.filter(m => page.includes(m)), [marker]);
    }
  });

  it("the referral code listing cites a page that answers", async () => {
    const res = await fetch(`http://localhost:${serverPort}/api/referral-codes?category=cloud-hosting&source=agent`);
    assert.strictEqual(res.status, 200);
    const body = await res.json() as { codes: unknown[]; _provenance: { url: string } };
    assert.deepStrictEqual(body.codes, [], "this filter is meant to select nothing, so the listing falls back to its own page");
    const cited = new URL(body._provenance.url).pathname;
    assert.notStrictEqual(cited, "/marketplace", "the listing cites a retired page");
    const citedRes = await fetch(`http://localhost:${serverPort}${cited}`, { redirect: "manual" });
    assert.strictEqual(citedRes.status, 200, `${cited} answered ${citedRes.status}`);
  });

  it("the referral endpoints are still documented, without linking a retired page", async () => {
    const res = await fetch(`http://localhost:${serverPort}/developers`);
    assert.strictEqual(res.status, 200);
    const html = await res.text();
    const start = html.indexOf('id="referral-codes"');
    assert.ok(start > 0, "the referral endpoints are still documented");
    const section = html.slice(start, html.indexOf("<h2", start + 1));
    assert.ok(section.includes("/api/referral-codes"), "the endpoint table is still there");
    assert.ok(!section.includes("/marketplace"), "the documentation still links a retired page");
  });
});
