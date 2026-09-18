import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parsePageReviews, type PageReviewRecord } from "../src/page-reviews.ts";
import { assertCoversPopulation, assertPopulationFloor, pagesOnTheReviewRegister } from "./population-floor.ts";
import { registerWith } from "./page-review-fixture.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(__dirname, "..");
const SYNC = path.join(REPO, "scripts", "sync-page-reviews.js");

const REVIEW_FIELDS = ["reviewed_at", "reviewer", "review_outcome", "review_note"] as const;

function onRecord(): PageReviewRecord[] {
  return parsePageReviews(readFileSync(path.join(REPO, "data", "page-reviews.json"), "utf-8")).pages;
}

function rebuild(args: string[], env: NodeJS.ProcessEnv = {}): string {
  return execFileSync("node", [SYNC, ...args], {
    cwd: REPO,
    encoding: "utf-8",
    env: { ...process.env, ...env },
    maxBuffer: 32 * 1024 * 1024,
  });
}

describe("rebuilding the review register to a path of its own", () => {
  let dir = "";
  let written = new Map<string, PageReviewRecord>();

  before(() => {
    dir = mkdtempSync(path.join(tmpdir(), "register-rebuild-"));
    const out = path.join(dir, "page-reviews.json");
    rebuild(["--out", out]);
    written = new Map(parsePageReviews(readFileSync(out, "utf-8")).pages.map((p) => [p.path, p]));
  });

  after(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("writes a record for every page already on the register", () => {
    assertCoversPopulation(written.size, pagesOnTheReviewRegister(), "pages a rebuild to a scratch path wrote");
  });

  it("carries every review a reviewer asserted, which no measurement can restore", () => {
    const carried: string[] = [];
    const blanked: string[] = [];
    for (const page of onRecord()) {
      for (const field of REVIEW_FIELDS) {
        if (page[field] === null) continue;
        const after = written.get(page.path)?.[field] ?? null;
        (after === page[field] ? carried : blanked).push(`${page.path} ${field} was ${page[field]}, written as ${after}`);
      }
    }
    assert.deepStrictEqual(blanked, []);
    assertPopulationFloor(carried.length, 50, "review assertions the rebuild carried to a scratch path");
  });

  it("carries the editorial exemption that keeps a page out of the unsourced ratchet", () => {
    const exempt = (pages: PageReviewRecord[]) => pages.filter((p) => p.data_source === "editorial").map((p) => p.path).sort();
    const before = exempt(onRecord());
    assertPopulationFloor(before.length, 1, "pages exempted from the unsourced ratchet by hand");
    assert.deepStrictEqual(exempt([...written.values()]), before);
  });
});

describe("rebuilding the register from a job that read no page", () => {
  function rebuiltFrom(overrides: Record<string, Record<string, unknown>>) {
    const fixture = registerWith(REPO, "register-measured-only-", overrides);
    const out = path.join(fixture.dir, "written.json");
    const stdout = rebuild(["--measured-only", "--out", out], { AGENTDEALS_PAGE_REVIEWS_PATH: fixture.file });
    const written = new Map(parsePageReviews(readFileSync(out, "utf-8")).pages.map((p) => [p.path, p]));
    return { stdout, written, cleanup: () => rmSync(fixture.dir, { recursive: true, force: true }) };
  }

  it("writes the figure counts the render measured over the ones it carried", () => {
    const run = rebuiltFrom({ "/storage-comparison-2026": { table_figures: 9, table_figures_from_records: 4 } });
    try {
      const after = run.written.get("/storage-comparison-2026")!;
      const onTheRegister = onRecord().find((p) => p.path === "/storage-comparison-2026")!;
      assert.strictEqual(after.table_figures, onTheRegister.table_figures);
      assert.strictEqual(after.table_figures_from_records, onTheRegister.table_figures_from_records);
      assert.match(run.stdout, /~ \/storage-comparison-2026 table figures from our records 4\/9 -> \d+\/\d+/);
    } finally {
      run.cleanup();
    }
  });

  it("carries a tier and an asserted vendor the render disagrees with, and says it measured them", () => {
    const run = rebuiltFrom({ "/llm-api-pricing": { tier: "B", vendors_asserted: [] } });
    try {
      const after = run.written.get("/llm-api-pricing")!;
      assert.strictEqual(after.tier, "B");
      assert.deepStrictEqual(after.vendors_asserted, []);
      assert.match(run.stdout, /measured and not written/);
      assert.match(run.stdout, /~ \/llm-api-pricing tier B -> A/);
      assert.match(run.stdout, /~ \/llm-api-pricing vendors 0 -> \d+/);
    } finally {
      run.cleanup();
    }
  });

  it("leaves a whole page as it stands when the source it would be given moves the ratchet", () => {
    const run = rebuiltFrom({
      "/storage-comparison-2026": { data_source: "unsourced", table_figures: 9, table_figures_from_records: 4 },
    });
    try {
      const after = run.written.get("/storage-comparison-2026")!;
      assert.strictEqual(after.data_source, "unsourced");
      assert.strictEqual(after.table_figures, 9, "the figures were written on a page whose source the same run would not move");
      assert.match(run.stdout, /= \/storage-comparison-2026 stands as it is: the render says data_source catalogue against the unsourced on record, and that is the unsourced_tier_a ratchet moving/);
    } finally {
      run.cleanup();
    }
  });

  it("still carries every review a reviewer asserted", () => {
    const run = rebuiltFrom({ "/llm-api-pricing": { tier: "B" } });
    try {
      const blanked = onRecord().flatMap((page) =>
        REVIEW_FIELDS.filter((field) => page[field] !== null && (run.written.get(page.path)?.[field] ?? null) !== page[field])
          .map((field) => `${page.path} ${field}`));
      assert.deepStrictEqual(blanked, []);
    } finally {
      run.cleanup();
    }
  });
});

describe("dating a page from the history of the server", () => {
  it("says how many pages it is about to walk the history for", () => {
    const fixture = registerWith(REPO, "register-undated-", {
      "/agent-payments": { published: "" },
      "/agent-stack": { published: "" },
    });
    try {
      const out = rebuild(["--dry-run"], { AGENTDEALS_PAGE_REVIEWS_PATH: fixture.file });
      assert.match(out, /2 of \d+ pages carry no publication date/);
    } finally {
      rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

  it("says nothing when a single new page is being dated", () => {
    const fixture = registerWith(REPO, "register-undated-", { "/agent-payments": { published: "" } });
    try {
      const out = rebuild(["--dry-run"], { AGENTDEALS_PAGE_REVIEWS_PATH: fixture.file });
      assert.doesNotMatch(out, /carry no publication date/);
      assert.match(out, /\+ \/agent-payments \(published \d{4}-\d{2}-\d{2}/);
    } finally {
      rmSync(fixture.dir, { recursive: true, force: true });
    }
  });
});
