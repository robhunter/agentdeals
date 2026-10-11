import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

const decoded = (html: string) =>
  html.replace(/&quot;/g, "\"").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

const lapseLineOf = (html: string) => {
  const line = html.match(/<p class="verdict-lapse-line"[^>]*>([\s\S]*?)<\/p>/);
  return line ? decoded(line[1]!) : null;
};

interface VendorColumn {
  slug: string;
  lapseLine: string | null;
  lapseLineFollowsHeading: boolean;
}

function vendorColumnsOf(page: string): VendorColumn[] {
  const grid = page.slice(page.indexOf('<div class="compare-grid">'), page.indexOf("<h2>Key Differences</h2>"));
  return grid.split('<div class="vendor-col">').slice(1).map((column) => ({
    slug: column.match(/<h3><a href="\/vendor\/([a-z0-9-]+)">/)?.[1] ?? "",
    lapseLine: lapseLineOf(column),
    lapseLineFollowsHeading: /<\/h3>\s*<p class="verdict-lapse-line"/.test(column),
  }));
}

describe("a vs page tells the reader when a vendor's badge lapses, in the words the vendor's own page uses", () => {
  let server: ChildProcess;
  const columns = new Map<string, VendorColumn[]>();
  const vendorPageLines = new Map<string, string | null>();

  before(async () => {
    server = spawn("node", [path.join(REPO, "dist", "serve.js")], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, PORT: "0", BASE_URL: "http://localhost", TZ: "UTC" },
    });
    const base = await new Promise<string>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Server startup timeout")), 30000);
      server.stderr!.on("data", (data: Buffer) => {
        const match = data.toString().match(/running on http:\/\/localhost:(\d+)/);
        if (match) {
          clearTimeout(timeout);
          resolve(`http://localhost:${match[1]}`);
        }
      });
      server.on("error", (err) => {
        clearTimeout(timeout);
        reject(err);
      });
    });
    const sitemap = await (await fetch(`${base}/sitemap-comparisons.xml`)).text();
    const vsPaths = [...sitemap.matchAll(/<loc>http:\/\/localhost(\/[a-z0-9-]+-vs-[a-z0-9-]+)<\/loc>/g)].map(([, route]) => route!);
    for (const route of vsPaths) {
      const page = await (await fetch(`${base}${route}`)).text();
      if (!page.includes('<div class="compare-grid">')) continue;
      columns.set(route, vendorColumnsOf(page));
    }
    for (const slug of new Set([...columns.values()].flat().map((column) => column.slug))) {
      vendorPageLines.set(slug, lapseLineOf(await (await fetch(`${base}/vendor/${slug}`)).text()));
    }
  });

  after(() => {
    server?.kill();
  });

  it("reads every vs page's two vendor columns", () => {
    assert.ok(columns.size >= 10, `only ${columns.size} vs pages carry a vendor grid`);
    const malformed = [...columns].filter(([, vendors]) => vendors.length !== 2 || vendors.some((vendor) => vendor.slug === ""));
    assert.deepStrictEqual(malformed.map(([route]) => route), []);
  });

  it("prints under each vendor's heading the lapse sentence its vendor page prints, and none where that page prints none", () => {
    const differing = [...columns].flatMap(([route, vendors]) =>
      vendors
        .filter((vendor) => vendor.lapseLine !== vendorPageLines.get(vendor.slug))
        .map((vendor) => `${route} ${vendor.slug}: vs page ${JSON.stringify(vendor.lapseLine)}, vendor page ${JSON.stringify(vendorPageLines.get(vendor.slug))}`));
    assert.deepStrictEqual(differing, []);
    const stating = [...columns.values()].flat().filter((vendor) => vendor.lapseLine !== null);
    assert.ok(stating.length > 0, "no vendor on a vs page carries a badge resting on a record, so this test compared only absences");
  });

  it("puts the sentence directly under the vendor heading whose badge it explains", () => {
    const misplaced = [...columns].flatMap(([route, vendors]) =>
      vendors.filter((vendor) => vendor.lapseLine !== null && !vendor.lapseLineFollowsHeading).map((vendor) => `${route} ${vendor.slug}`));
    assert.deepStrictEqual(misplaced, []);
  });
});
