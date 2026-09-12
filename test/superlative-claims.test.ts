import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { assertCoversPopulation, assertPopulationFloor, pagesOnTheReviewRegister } from "./population-floor.ts";
import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  contradictorySuperlatives,
  gradeSuperlatives,
  miscountedCards,
  navigatedSections,
  pageTables,
  parseQuantity,
  resolveColumn,
  statCards,
  superlativeClaims,
  unresolvedStatCardSubjects,
} from "../src/superlative-claims.ts";
import { assertedVendorSlugs, isNonVendorSubject } from "../dist/vendor-slug.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(__dirname, "..");
const REGISTRY = JSON.parse(readFileSync(path.join(REPO, "data", "page-reviews.json"), "utf-8"));

const RESOLVER = { slugsFor: assertedVendorSlugs, isNonVendor: isNonVendorSubject };

let serverPort = 0;
let proc: ChildProcess | null = null;
const rendered = new Map<string, string>();

function start(): Promise<{ child: ChildProcess; port: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn("node", [path.join(REPO, "dist", "serve.js")], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, PORT: "0", BASE_URL: "http://localhost" },
    });
    const timeout = setTimeout(() => { child.kill(); reject(new Error("Server startup timeout")); }, 30000);
    child.stderr!.on("data", (data: Buffer) => {
      const m = data.toString().match(/running on http:\/\/localhost:(\d+)/);
      if (m) { clearTimeout(timeout); resolve({ child, port: parseInt(m[1], 10) }); }
    });
    child.on("error", err => { clearTimeout(timeout); reject(err); });
  });
}

async function get(routePath: string): Promise<string> {
  const res = await fetch(`http://localhost:${serverPort}${routePath}`, {
    redirect: "manual",
    headers: { "user-agent": "agentdeals-internal/1.0 (superlative-claim-test)" },
  });
  assert.strictEqual(res.status, 200, `${routePath} returned ${res.status}`);
  return await res.text();
}

before(async () => {
  const started = await start();
  proc = started.child;
  serverPort = started.port;
  for (const page of REGISTRY.pages) rendered.set(page.path, await get(page.path));
});

after(() => { if (proc) proc.kill(); });

describe("#1073 a superlative is graded against the page it is printed on", () => {
  it("publishes no superlative a column of its own page refutes", () => {
    const offenders: string[] = [];
    for (const [route, html] of rendered) {
      for (const found of gradeSuperlatives(html).refuted) {
        offenders.push(
          `${route}: ${found.claim.kind} "${found.claim.label}" holds ${JSON.stringify(found.held)} in ` +
            `"${found.column.header}", where ${found.beatenBy} holds ${JSON.stringify(found.beatingCell)}`,
        );
      }
    }
    assert.deepStrictEqual(offenders, [], `superlatives their own page refutes:\n${offenders.join("\n")}`);
  });

  it("publishes no superlative quantity that no row on its page reaches", () => {
    const offenders: string[] = [];
    for (const [route, html] of rendered) {
      for (const found of gradeSuperlatives(html).unattained) {
        offenders.push(
          `${route}: "${found.claim.label}" states ${JSON.stringify(found.held)}, which no row of ` +
            `"${found.column.header}" attains`,
        );
      }
    }
    assert.deepStrictEqual(offenders, [], `superlative quantities no row supports:\n${offenders.join("\n")}`);
  });

  it("names one subject per column for any superlative it awards", () => {
    const offenders: string[] = [];
    for (const [route, html] of rendered) {
      for (const found of contradictorySuperlatives(html)) {
        offenders.push(
          `${route}: "${found.header}" is awarded to ${found.subjects.join(" and ")} by ${found.labels.join(", ")}`,
        );
      }
    }
    assert.deepStrictEqual(offenders, [], `one column, two winners:\n${offenders.join("\n")}`);
  });

  it("grades a ranking over a column and leaves editorial judgement ungraded", () => {
    const cicd = rendered.get("/cicd-free-tier-comparison-2026")!;
    const claims = superlativeClaims(cicd);
    const credits = claims.find(claim => claim.label === "MOST CREDITS");
    assert.ok(credits, "the credits badge is no longer on /cicd-free-tier-comparison-2026");
    const column = resolveColumn(credits!, pageTables(cicd));
    assert.ok(column, `"MOST CREDITS" resolves to no column`);
    const graded = gradeSuperlatives(cicd);
    const named = (found: { claim: { label: string } }) => found.claim.label;
    assert.ok(
      !graded.refuted.map(named).includes("MOST CREDITS") && !graded.ungraded.map(named).includes("MOST CREDITS"),
      `"MOST CREDITS" is not graded on the merits`,
    );
    for (const label of ["BEST OSS", "BEST ALL-IN-ONE", "BEST SELF-HOSTED"]) {
      assert.ok(claims.some(claim => claim.label === label), `${label} no longer publishes`);
      assert.ok(
        graded.ungraded.map(named).includes(label),
        `${label} is a ranking over a column, which it is not`,
      );
    }
  });

  it("reads every superlative on the register out of rendered HTML", () => {
    let cards = 0;
    let badges = 0;
    for (const html of rendered.values()) {
      cards += statCards(html).length;
      for (const claim of superlativeClaims(html)) {
        if (claim.kind === "badge") badges += 1;
      }
    }
    assertCoversPopulation(rendered.size, pagesOnTheReviewRegister(), "paths the sweep rendered");
    assertPopulationFloor(cards, 140, "stat cards the sweep reached");
    assertPopulationFloor(badges, 40, "superlative row badges the sweep reached");
  });

  it("cards a section count the page's own navigation agrees with", () => {
    const offenders: string[] = [];
    let joined = 0;
    for (const [route, html] of rendered) {
      joined += [...navigatedSections(html)].filter(([key]) =>
        statCards(html).some(card => card.label.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim() === key),
      ).length;
      for (const found of miscountedCards(html)) {
        offenders.push(
          `${route}: card "${found.label}" reads ${found.carded}, "${found.section.label}" lists ` +
            `${found.section.counted} ${found.section.noun}`,
        );
      }
    }
    assert.deepStrictEqual(offenders, [], `cards disagreeing with their own section:\n${offenders.join("\n")}`);
    assert.ok(joined > 0, "no stat card on the register joins to a section the page counts");
  });

  it("carries a subject and a dimension for every superlative it enumerates", () => {
    const empty: string[] = [];
    for (const [route, html] of rendered) {
      for (const claim of superlativeClaims(html)) {
        if (claim.kind === "badge" && !claim.subject) empty.push(`${route}: ${claim.label} names nobody`);
      }
    }
    assert.deepStrictEqual(empty, [], `superlatives whose subject could not be read:\n${empty.join("\n")}`);
  });

  it("declares in the registry every stat card subject we hold no record for", () => {
    const undeclared: string[] = [];
    for (const page of REGISTRY.pages) {
      const html = rendered.get(page.path);
      if (!html) continue;
      const declared = new Set<string>(page.stat_card_subjects_unresolved ?? []);
      for (const subject of unresolvedStatCardSubjects(html, RESOLVER)) {
        if (!declared.has(subject)) undeclared.push(`${page.path}: "${subject}"`);
      }
    }
    assert.deepStrictEqual(undeclared, [], `stat card subjects naming nothing we hold:\n${undeclared.join("\n")}`);
  });

  it("declares nothing the pages no longer render, and nothing that resolves", () => {
    const stale: string[] = [];
    for (const page of REGISTRY.pages) {
      const html = rendered.get(page.path);
      if (!html) continue;
      const rendersUnresolved = new Set(unresolvedStatCardSubjects(html, RESOLVER));
      for (const subject of page.stat_card_subjects_unresolved ?? []) {
        if (!rendersUnresolved.has(subject)) stale.push(`${page.path}: "${subject}" is declared and not rendered`);
        if (assertedVendorSlugs(subject).length > 0) stale.push(`${page.path}: "${subject}" resolves to a record`);
      }
    }
    assert.deepStrictEqual(stale, [], `declarations the pages do not support:\n${stale.join("\n")}`);
  });

  it("publishes the unresolved stat card subjects through the review register", async () => {
    const body = JSON.parse(await get("/api/page-reviews"));
    const declared = [...new Set(REGISTRY.pages.flatMap((p: { stat_card_subjects_unresolved?: string[] }) => p.stat_card_subjects_unresolved ?? []))].sort();
    assert.deepStrictEqual(body.totals.unresolved_stat_card_subjects, declared);
    for (const page of body.pages) {
      assert.ok(Array.isArray(page.stat_card_subjects_unresolved), `${page.path} publishes no stat_card_subjects_unresolved`);
    }
  });
});

const REFUTED_BEFORE_THIS_ISSUE = [
  {
    page: "/serverless-free-tier-comparison-2026",
    markup: `<div class="stat-card"><div class="stat-number green">Lambda</div><div class="stat-label">Most Invocations Free</div></div>`,
    beaten: "Google Cloud Functions",
  },
  {
    page: "/email-comparison-2026",
    markup: `<div class="stat-card"><div class="stat-number green">62K</div><div class="stat-label">Highest Free Volume (SES from EC2)</div></div>`,
    beaten: "Buttondown",
  },
  {
    page: "/auth-comparison-2026",
    markup: `<div class="stat-card"><div class="stat-number green">1M</div><div class="stat-label">Highest Free (WorkOS)</div></div>`,
    beaten: "Keycloak",
  },
  {
    page: "/monitoring-comparison-2026",
    markup: `<div class="stat-card"><div class="stat-number green">500GB</div><div class="stat-label">Highest Free Ingest (Axiom)</div></div>`,
    beaten: "Prometheus",
  },
];

describe("#1073 the check goes red on the cards this issue was filed for", () => {
  it("refutes each withdrawn card against the page it was printed on", () => {
    for (const { page, markup, beaten } of REFUTED_BEFORE_THIS_ISSUE) {
      const html = rendered.get(page);
      assert.ok(html, `${page} is not in the register`);
      const graded = gradeSuperlatives(markup + html!);
      const refuted = graded.refuted.map(found => `${found.claim.label} < ${found.beatenBy}`);
      assert.ok(
        graded.refuted.some(found => found.beatenBy === beaten),
        `${page} no longer refutes its withdrawn card: ${JSON.stringify(refuted)}`,
      );
    }
  });

  it("refuses a startup credit figure no row of the page reaches", () => {
    const html = rendered.get("/cloud-free-tier-comparison-2026")!;
    const markup = `<div class="stat-card"><div class="stat-number">$550K+</div><div class="stat-label">Max Startup Credits</div></div>`;
    const graded = gradeSuperlatives(markup + html);
    assert.strictEqual(graded.unattained.length, 1, "the withdrawn startup credit card is no longer refused");
    assert.strictEqual(graded.unattained[0]!.column.header, "Max Credits");
  });

  it("refuses a count card that disagrees with the section its own nav counts", () => {
    const html = rendered.get("/free-tier-risk")!;
    const navigated = navigatedSections(html);
    const high = navigated.get("high risk")!;
    const changed = navigated.get("already changed")!;
    const withdrawn = html
      .replace(
        /<div class="stat-card"><div class="stat-number" style="color:#f85149">\d+<\/div><div class="stat-label">High Risk<\/div><\/div>/,
        `<div class="stat-card"><div class="stat-number" style="color:#f85149">${high.counted + 6}</div><div class="stat-label">High Risk</div></div>`,
      )
      .replace(
        /<div class="stat-card"><div class="stat-number" style="color:#8b949e">\d+<\/div><div class="stat-label">Already Changed<\/div><\/div>/,
        `<div class="stat-card"><div class="stat-number" style="color:#8b949e">${changed.counted - 6}</div><div class="stat-label">Already Changed</div></div>`,
      );
    assert.notStrictEqual(withdrawn, html, "the cards this guard reads are no longer on /free-tier-risk");
    assert.deepStrictEqual(
      miscountedCards(withdrawn).map(found => `${found.label} ${found.carded} vs ${found.section.counted}`),
      [`High Risk ${high.counted + 6} vs ${high.counted}`, `Already Changed ${changed.counted - 6} vs ${changed.counted}`],
    );
  });

  it("reports two winners when one column carries two superlatives", () => {
    const html = rendered.get("/serverless-free-tier-comparison-2026")!;
    const markup = `<td class="provider-col"><a href="/vendor/aws">AWS Lambda</a> <span class="winner-badge">MOST INVOCATIONS</span></td>`;
    const found = contradictorySuperlatives(html.replace(`<a href="/vendor/aws" style="color:var(--text)">AWS Lambda</a>`, markup));
    assert.strictEqual(found.length, 1, `expected one contradicted column, got ${JSON.stringify(found)}`);
    assert.strictEqual(found[0]!.header, "Free Invocations");
    assert.deepStrictEqual(found[0]!.subjects, ["AWS Lambda", "Google Cloud Functions"]);
  });
});

describe("#1073 a quantity is compared only against one it shares a denomination with", () => {
  it("reads the magnitude, the unit and the period a cell states", () => {
    assert.deepStrictEqual(parseQuantity("1M / month"), { amount: 1e6, unit: "count", monthly: true, unbounded: false });
    assert.deepStrictEqual(parseQuantity("500GB/mo ingest"), { amount: 500, unit: "bytes", monthly: true, unbounded: false });
    assert.deepStrictEqual(parseQuantity("Up to $200K"), { amount: 2e5, unit: "currency", monthly: false, unbounded: false });
    assert.deepStrictEqual(parseQuantity("400 compute min/mo"), { amount: 400, unit: "duration", monthly: true, unbounded: false });
  });

  it("reads a parenthesised conversion as the quantity the page means", () => {
    assert.strictEqual(parseQuantity("100K / day (~3M/mo)")!.amount, 3e6);
    assert.strictEqual(parseQuantity("100K / day (~3M/mo)")!.monthly, true);
    assert.strictEqual(parseQuantity("300/day (~9K/mo)")!.amount, 9000);
  });

  it("ranks an unbounded allowance above any finite one", () => {
    assert.strictEqual(parseQuantity("Unlimited (self-hosted)")!.unbounded, true);
    assert.strictEqual(parseQuantity("Unlimited")!.amount, Number.POSITIVE_INFINITY);
  });

  it("reads a rate stated over a span, and a span as the quantity it is", () => {
    assert.deepStrictEqual(parseQuantity("4,000/30 days"), { amount: 4000, unit: "count", monthly: true, unbounded: false });
    assert.deepStrictEqual(parseQuantity("30 days"), { amount: 30, unit: "count", monthly: false, unbounded: false });
    assert.strictEqual(parseQuantity("$66,000/yr")!.amount, 5500);
  });

  it("refuses a cell stating more than one quantity, or an allowance beside an unbounded one", () => {
    assert.strictEqual(parseQuantity("2,000 min/mo (private) Unlimited (public)"), null);
    assert.strictEqual(parseQuantity("None — $200 credits, 6 mo"), null);
    assert.strictEqual(parseQuantity("N/A"), null);
  });
});
