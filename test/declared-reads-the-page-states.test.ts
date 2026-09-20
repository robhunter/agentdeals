import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DECLARED_FIGURE_READS, declaredFigureReadsFor } from "../src/page-reviews.ts";

const { staticHalfOf } = await import("../dist/compiled-figures.js");

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(__dirname, "..");

const SOURCE_CHECK_PAGE = "/monitoring-comparison-2026";
const ISO_DATE_AFTER_READ = /\bread\b[^.]{0,80}?(\d{4}-\d{2}-\d{2})/gi;

let port = 0;
let proc: ChildProcess | null = null;
const fetched = new Map<string, string>();

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
    child.on("error", (e) => { clearTimeout(timeout); reject(e); });
  });
}

async function page(pathname: string): Promise<string> {
  const cached = fetched.get(pathname);
  if (cached !== undefined) return cached;
  const response = await fetch(`http://localhost:${port}${pathname}`);
  assert.strictEqual(response.status, 200, `${pathname} answered ${response.status}`);
  const body = await response.text();
  fetched.set(pathname, body);
  return body;
}

function plainText(html: string): string {
  return html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
}

export function figureReadDatesStatedBy(html: string): string[] {
  const text = plainText(staticHalfOf(html));
  const dates = new Set<string>();
  for (const match of text.matchAll(ISO_DATE_AFTER_READ)) dates.add(match[1]!);
  return [...dates].sort();
}

function datesDeclaredFor(pagePath: string): string[] {
  return [...new Set(declaredFigureReadsFor(pagePath).map(read => read.read_on))].sort();
}

describe("a declared figure read is a date its own page states", () => {
  before(async () => { proc = await startServer(); });
  after(() => { proc?.kill(); });

  for (const read of DECLARED_FIGURE_READS) {
    it(`${read.path} states the read the registry declares for it`, async () => {
      const stated = figureReadDatesStatedBy(await page(read.path));
      assert.ok(
        stated.includes(read.read_on),
        `${read.path} declares a read on ${read.read_on} and states ${JSON.stringify(stated)}`,
      );
    });

    it(`${read.path} states no figure-read date the registry does not declare`, async () => {
      assert.deepStrictEqual(figureReadDatesStatedBy(await page(read.path)), datesDeclaredFor(read.path));
    });
  }

  it("reads the date out of the page rather than out of the registry", async () => {
    for (const read of DECLARED_FIGURE_READS) {
      const stated = figureReadDatesStatedBy(await page(read.path));
      assert.ok(!stated.includes("2020-01-01"), `${read.path} states a date it does not render`);
    }
  });

  it("finds no figure read on the page whose dates are source checks", async () => {
    const html = await page(SOURCE_CHECK_PAGE);
    assert.deepStrictEqual(declaredFigureReadsFor(SOURCE_CHECK_PAGE), []);
    assert.deepStrictEqual(figureReadDatesStatedBy(html), []);
  });

  it("finds the source-check dates below the timeline the static half cuts away", async () => {
    const html = await page(SOURCE_CHECK_PAGE);
    const whole = plainText(html).match(/We read that on \d{4}-\d{2}-\d{2}/g) ?? [];
    const staticHalf = plainText(staticHalfOf(html)).match(/We read that on \d{4}-\d{2}-\d{2}/g) ?? [];
    assert.ok(whole.length >= 20, `${SOURCE_CHECK_PAGE} renders ${whole.length} source-check clauses`);
    assert.deepStrictEqual(staticHalf, []);
  });
});
