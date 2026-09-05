import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { classifyTier } from "../dist/ranking.js";
import { toSlug } from "../dist/vendor-slug.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");

const offers = JSON.parse(readFileSync(path.join(root, "data", "index.json"), "utf-8")).offers as Array<Record<string, any>>;

const recordsBySlug = new Map<string, Array<Record<string, any>>>();
for (const offer of offers) {
  if (!offer.vendor) continue;
  const slug = toSlug(offer.vendor);
  if (!recordsBySlug.has(slug)) recordsBySlug.set(slug, []);
  recordsBySlug.get(slug)!.push(offer);
}

const tierClassesFor = (slug: string) =>
  (recordsBySlug.get(slug) ?? []).map((o) => classifyTier(o.tier ?? "").class);

let server: ChildProcess;
let base = "";

function startServer(): Promise<ChildProcess> {
  return new Promise((resolve, reject) => {
    const proc = spawn("node", [path.join(root, "dist", "serve.js")], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, PORT: "0", BASE_URL: "http://localhost", TZ: "UTC" },
    });
    const timeout = setTimeout(() => { proc.kill(); reject(new Error("Server startup timeout")); }, 20000);
    proc.stderr!.on("data", (data: Buffer) => {
      const match = data.toString().match(/running on http:\/\/localhost:(\d+)/);
      if (match) { base = `http://localhost:${match[1]}`; clearTimeout(timeout); resolve(proc); }
    });
    proc.on("error", (err) => { clearTimeout(timeout); reject(err); });
  });
}

type StackRow = { stack: string; vendor: string; slug: string; freeTier: string };

const rows: StackRow[] = [];
const stackPaths: string[] = [];
const estimatorVendors: Array<{ slug: string; name: string; free: string }> = [];

describe("a stack that totals $0 names no vendor our catalogue says is paid (#1183 row ten)", () => {
  before(async () => {
    server = await startServer();

    const index = await (await fetch(`${base}/stacks`)).text();
    for (const m of index.matchAll(/href="(\/stacks\/[a-z0-9-]+)"/g)) {
      if (!stackPaths.includes(m[1])) stackPaths.push(m[1]);
    }

    for (const stack of stackPaths) {
      const html = await (await fetch(`${base}${stack}`)).text();
      for (const m of html.matchAll(
        /<td class="vendor-name">(?:<a href="\/vendor\/([a-z0-9.-]+)">)?([^<]+)(?:<\/a>)?<span class="free-tier-info">([^<]*)<\/span>/g,
      )) {
        rows.push({ stack, vendor: m[2], slug: m[1] ?? toSlug(m[2]), freeTier: m[3] });
      }
    }

    const estimate = await (await fetch(`${base}/estimate`)).text();
    const embedded = estimate.match(/var EST_DATA = (\[[\s\S]*?\]);\n/);
    assert.ok(embedded, "the estimator no longer embeds its vendor table");
    for (const category of JSON.parse(embedded![1]) as Array<{ vendors: Array<{ slug: string; name: string; free: string }> }>) {
      estimatorVendors.push(...category.vendors);
    }
  });

  after(() => { server?.kill(); });

  it("reads every stack template, not the one the issue named", () => {
    assert.ok(stackPaths.length >= 5, `expected the whole stack index, got ${stackPaths.length}`);
    assert.ok(rows.length >= 30, `expected every service row, got ${rows.length}`);
  });

  it("puts no vendor in a stack whose own record classifies its tier as anything but free", () => {
    const paid = rows
      .filter((r) => {
        const classes = tierClassesFor(r.slug);
        return classes.length > 0 && !classes.includes("free");
      })
      .map((r) => `${r.stack} totals $0/mo on ${r.vendor}, whose record is ${tierClassesFor(r.slug).join("/")}`);
    assert.deepStrictEqual(paid.sort(), []);
  });

  it("states the free tier the vendor's own record states, or says there is none", () => {
    const silent = rows
      .filter((r) => !r.freeTier.trim())
      .map((r) => `${r.stack} states no free tier for ${r.vendor}`);
    assert.deepStrictEqual(silent, []);
  });

  it("links no service to a vendor page we do not publish", async () => {
    const dead: string[] = [];
    for (const row of rows) {
      if (!row.slug || !recordsBySlug.has(row.slug)) continue;
      const res = await fetch(`${base}/vendor/${row.slug}`);
      if (res.status !== 200) dead.push(`${row.stack} links ${row.vendor} to /vendor/${row.slug} (${res.status})`);
    }
    assert.deepStrictEqual(dead.sort(), []);
  });

  it("leaves a service we hold no record for unlinked rather than pointing at a 404", async () => {
    const unheld = rows.filter((r) => !recordsBySlug.has(r.slug));
    for (const row of unheld) {
      const html = await (await fetch(`${base}${row.stack}`)).text();
      assert.ok(
        !html.includes(`href="/vendor/${row.slug}"`),
        `${row.stack} links ${row.vendor} to a vendor page we do not publish`,
      );
    }
  });

  it("does not offer the cost estimator a free tier for a vendor whose record has none", () => {
    const wrong = estimatorVendors
      .filter((v) => {
        const classes = tierClassesFor(v.slug);
        if (classes.length === 0 || classes.includes("free")) return false;
        return !/^(?:None|No free tier)\b/i.test(v.free);
      })
      .map((v) => `the estimator offers ${v.name} a free tier of "${v.free}" on a ${tierClassesFor(v.slug).join("/")} record`);
    assert.deepStrictEqual(wrong.sort(), []);
  });
});
