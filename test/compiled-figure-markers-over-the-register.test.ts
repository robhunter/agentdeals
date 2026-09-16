import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertCoversPopulation, assertPopulationFloor, pagesOnTheReviewRegister } from "./population-floor.ts";
import {
  factsOutdatedBy, newestChangeBySlug, parsePageReviews, reviewStatus, utcToday, type PageReviewRecord,
} from "../src/page-reviews.ts";

const { toSlug } = await import("../dist/vendor-slug.js");
const { vendorSlugForSubject, vendorSubjectsOnCompiledPage } = await import("../dist/compiled-figures.js");

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(__dirname, "..");

const TODAY = utcToday();

function registeredPages(): PageReviewRecord[] {
  return parsePageReviews(readFileSync(path.join(REPO, "data", "page-reviews.json"), "utf-8")).pages;
}

function newestChangeForSlug(): (slug: string) => string | null {
  const changes = JSON.parse(readFileSync(path.join(REPO, "data", "deal_changes.json"), "utf-8"))
    .changes as Array<{ vendor?: string; date?: string }>;
  const newest = newestChangeBySlug(changes, TODAY, toSlug);
  return slug => newest.get(slug) ?? null;
}

function startServer(): Promise<{ proc: ChildProcess; port: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn("node", [path.join(REPO, "dist", "serve.js")], {
      cwd: REPO,
      stdio: ["ignore", "ignore", "pipe"],
      env: { ...process.env, PORT: "0", BASE_URL: "http://localhost" },
    });
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("server startup timeout")); }, 60000);
    child.stderr!.on("data", (buffer: Buffer) => {
      const found = buffer.toString().match(/running on http:\/\/localhost:(\d+)/);
      if (found) { clearTimeout(timer); resolve({ proc: child, port: parseInt(found[1], 10) }); }
    });
    child.on("error", err => { clearTimeout(timer); reject(err); });
  });
}

function recordMarkerSlugs(html: string): Set<string> {
  const marker = /<a href="\/(?:vendor\/([a-z0-9-]+)#changes|changes#vendor-([a-z0-9-]+))"[^>]*>(?:CHANGED [A-Z]{3} \d+|FREE REMOVED)<\/a>/g;
  const found = new Set<string>();
  for (const hit of html.matchAll(marker)) found.add(hit[1] ?? hit[2]!);
  return found;
}

function subjectsTheResolverReaches(html: string): Set<string> {
  const reached = new Set<string>();
  for (const subject of vendorSubjectsOnCompiledPage(html)) {
    const slug = vendorSlugForSubject(subject);
    if (slug) reached.add(slug);
  }
  return reached;
}

interface PageSweep {
  path: string;
  reachableStale: string[];
  unmarked: string[];
}

describe("marking a compiled figure the change log has moved past", () => {
  let server: { proc: ChildProcess; port: number };
  let swept: PageSweep[] = [];

  before(async () => {
    server = await startServer();
    const changeDateFor = newestChangeForSlug();
    for (const page of registeredPages()) {
      const response = await fetch(`http://localhost:${server.port}${page.path}`, { redirect: "manual" });
      assert.strictEqual(response.status, 200, `${page.path} is on the review register and did not serve`);
      const html = await response.text();
      const reached = subjectsTheResolverReaches(html);
      const marked = recordMarkerSlugs(html);
      const reachableStale = factsOutdatedBy(reviewStatus(page, TODAY), changeDateFor)
        .map(fact => fact.slug)
        .filter(slug => reached.has(slug));
      swept.push({
        path: page.path,
        reachableStale,
        unmarked: reachableStale.filter(slug => !marked.has(slug)),
      });
    }
  });

  after(() => server?.proc.kill("SIGKILL"));

  it("sweeps every page the review register holds", () => {
    assertCoversPopulation(swept.length, pagesOnTheReviewRegister(), "registered pages rendered and read for markers");
  });

  it("reads enough resolved subjects for the property to bite", () => {
    const subjects = swept.reduce((n, page) => n + page.reachableStale.length, 0);
    assertPopulationFloor(subjects, 50, "registered subjects the resolver reaches whose record post-dates the page");
  });

  it("marks every subject a page names whose record post-dates the figures it publishes", () => {
    const missing = swept.filter(page => page.unmarked.length > 0);
    assert.deepStrictEqual(
      missing.map(page => `${page.path}: ${page.unmarked.join(", ")}`),
      [],
      "a registered page names these vendors, holds a record newer than the figures it publishes, and renders no marker beside them",
    );
  });
});
