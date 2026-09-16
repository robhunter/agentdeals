import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertCoversPopulation, pagesOnTheReviewRegister } from "./population-floor.ts";
import { parsePageReviews, type PageReviewRecord } from "../src/page-reviews.ts";
import { NEVER_REVIEWED, registerWith, reviewFailedOn, reviewPassedOn } from "./page-review-fixture.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(__dirname, "..");

const CHECK_DATE_NAMED = /(?:Figures compiled|Compiled) \d{4}-\d{2}-\d{2}, last checked (\d{4}-\d{2}-\d{2})/;
const NOT_RE_CHECKED = /(?:Figures compiled|Compiled) \d{4}-\d{2}-\d{2}, not re-checked since/;
const DATE_MODIFIED = /"dateModified"\s*:\s*"(\d{4}-\d{2}-\d{2})"/;

const A_PAGE_THAT_COMPILES_ITS_FIGURES = "/gemini-api-pricing-2026";

function registeredPages(): PageReviewRecord[] {
  return parsePageReviews(readFileSync(path.join(REPO, "data", "page-reviews.json"), "utf-8")).pages;
}

function startServer(env: NodeJS.ProcessEnv = {}): Promise<{ proc: ChildProcess; port: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn("node", [path.join(REPO, "dist", "serve.js")], {
      cwd: REPO,
      stdio: ["ignore", "ignore", "pipe"],
      env: { ...process.env, PORT: "0", BASE_URL: "http://localhost", ...env },
    });
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("server startup timeout")); }, 60000);
    child.stderr!.on("data", (buffer: Buffer) => {
      const found = buffer.toString().match(/running on http:\/\/localhost:(\d+)/);
      if (found) { clearTimeout(timer); resolve({ proc: child, port: parseInt(found[1], 10) }); }
    });
    child.on("error", (err) => { clearTimeout(timer); reject(err); });
  });
}

function readableBody(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/g, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/&middot;/g, " ")
    .replace(/&[a-z]+;/g, " ")
    .replace(/\s+/g, " ");
}

interface Stamps {
  checkDateNamed: string | null;
  saysNotReChecked: boolean;
  dateModified: string | null;
}

function stampsOn(html: string): Stamps {
  const named = readableBody(html).match(CHECK_DATE_NAMED);
  const modified = html.match(DATE_MODIFIED);
  return {
    checkDateNamed: named ? named[1]! : null,
    saysNotReChecked: NOT_RE_CHECKED.test(readableBody(html)),
    dateModified: modified ? modified[1]! : null,
  };
}

describe("a page names no check date that dateModified does not carry", () => {
  let proc: ChildProcess;
  let port: number;
  const read = new Map<string, Stamps>();

  before(async () => {
    ({ proc, port } = await startServer());
    for (const page of registeredPages()) {
      const res = await fetch(`http://localhost:${port}${page.path}`);
      assert.strictEqual(res.status, 200, `${page.path} answered ${res.status}`);
      read.set(page.path, stampsOn(await res.text()));
    }
  });
  after(() => { proc?.kill("SIGKILL"); });

  it("reads every page on the register", () => {
    assertCoversPopulation(read.size, pagesOnTheReviewRegister(), "registered pages read for a date stamp");
  });

  it("stamps a date a reader can compare against the one machines are given", () => {
    const carried: string[] = [];
    for (const [pagePath, stamps] of read) {
      if (stamps.checkDateNamed === null) continue;
      carried.push(pagePath);
      assert.strictEqual(
        stamps.checkDateNamed,
        stamps.dateModified,
        `${pagePath} tells a reader it was last checked ${stamps.checkDateNamed} and tells a machine ${stamps.dateModified}`,
      );
    }
    assert.deepStrictEqual(carried.filter(p => read.get(p)!.saysNotReChecked), [],
      "a page both names a check date and says it has not been re-checked");
  });

  it("holds every page whose last review did not clear it at the date it was published", () => {
    const register = new Map(registeredPages().map(p => [p.path, p]));
    const notCleared = [...read].filter(([pagePath]) => register.get(pagePath)!.review_outcome === "fail");

    assert.ok(notCleared.length > 0, "no page on the register records a review that found it wrong");
    for (const [pagePath, stamps] of notCleared) {
      assert.strictEqual(stamps.checkDateNamed, null,
        `${pagePath} offers ${stamps.checkDateNamed} as the date it was last checked, and that review found it wrong`);
      assert.strictEqual(stamps.dateModified, register.get(pagePath)!.published, pagePath);
    }
  });
});

describe("what a page stamps follows the outcome its review recorded", () => {
  const PUBLISHED = registeredPages().find(p => p.path === A_PAGE_THAT_COMPILES_ITS_FIGURES)!.published;
  const REVIEWED_ON = "2026-09-13";

  const underOutcome = async (outcome: Record<string, unknown>): Promise<Stamps & { body: string }> => {
    const fixture = registerWith(REPO, "byline-", { [A_PAGE_THAT_COMPILES_ITS_FIGURES]: outcome });
    const { proc, port } = await startServer({ AGENTDEALS_PAGE_REVIEWS_PATH: fixture.file });
    try {
      const html = await (await fetch(`http://localhost:${port}${A_PAGE_THAT_COMPILES_ITS_FIGURES}`)).text();
      return { ...stampsOn(html), body: readableBody(html) };
    } finally {
      proc.kill("SIGKILL");
      rmSync(fixture.dir, { recursive: true, force: true });
    }
  };

  it("names the review date on a page the review cleared", async () => {
    const stamps = await underOutcome(reviewPassedOn(REVIEWED_ON));

    assert.strictEqual(stamps.checkDateNamed, REVIEWED_ON);
    assert.strictEqual(stamps.dateModified, REVIEWED_ON);
    assert.strictEqual(stamps.saysNotReChecked, false);
  });

  it("names no check date on a page the same review found wrong, and still reports the review", async () => {
    const stamps = await underOutcome(reviewFailedOn(REVIEWED_ON));

    assert.strictEqual(stamps.checkDateNamed, null);
    assert.strictEqual(stamps.dateModified, PUBLISHED);
    assert.strictEqual(stamps.saysNotReChecked, false,
      "a page we read on the review date is telling readers it has not been re-checked since it was compiled");
    assert.match(stamps.body, new RegExp(`Reviewed ${REVIEWED_ON}, corrections outstanding`));
  });

  it("says it has not been re-checked on a page no review has read", async () => {
    const stamps = await underOutcome(NEVER_REVIEWED);

    assert.strictEqual(stamps.checkDateNamed, null);
    assert.strictEqual(stamps.saysNotReChecked, true);
    assert.strictEqual(stamps.dateModified, PUBLISHED);
  });

  it("moves the reader's date and the machine's date on the same review", async () => {
    const cleared = await underOutcome(reviewPassedOn(REVIEWED_ON));
    const notCleared = await underOutcome(reviewFailedOn(REVIEWED_ON));

    assert.notStrictEqual(cleared.dateModified, notCleared.dateModified);
    assert.notStrictEqual(cleared.checkDateNamed, notCleared.checkDateNamed);
    assert.strictEqual(cleared.checkDateNamed, cleared.dateModified);
    assert.strictEqual(notCleared.checkDateNamed, null);
  });
});
