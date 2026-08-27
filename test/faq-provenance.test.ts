import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  CATALOGUE_TEXT_FIELDS, CHANGE_LOG_TEXT_FIELDS, compiledNotice, dateModifiedFor, parsePageReviews,
  perturbTextFields, type PageReviewRecord,
} from "../src/page-reviews.ts";
import {
  FAQ_BASELINE, answerWithProvenance, faqPageJsonLd, faqProvenanceClause, statesVendorFigure,
} from "../dist/faq-provenance.js";
import { NEVER_REVIEWED, registerWith, reviewFailedOn, type RegisterFixture } from "./page-review-fixture.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(__dirname, "..");
const TODAY = "2026-08-27";

const PROVENANCE = /Figures compiled (\d{4}-\d{2}-\d{2}), (?:not re-checked since|last checked (\d{4}-\d{2}-\d{2}))/;

function registeredPages(): PageReviewRecord[] {
  return parsePageReviews(readFileSync(path.join(REPO, "data", "page-reviews.json"), "utf-8")).pages;
}

function record(over: Partial<PageReviewRecord> = {}): PageReviewRecord {
  return {
    path: "/p", published: "2026-01-01", tier: "A", vendors_asserted: [], badge_subjects_unresolved: [],
    reviewed_at: null, reviewer: null, review_outcome: null, reads_index: false, reads_changes: false,
    data_source: "unsourced", data_source_reason: null, ...over,
  };
}

function startServer(env: NodeJS.ProcessEnv): Promise<{ proc: ChildProcess; port: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn("node", [path.join(REPO, "dist", "serve.js")], {
      cwd: REPO,
      stdio: ["ignore", "ignore", "pipe"],
      env: { ...process.env, PORT: "0", BASE_URL: "http://localhost:3000", ...env },
    });
    const timeout = setTimeout(() => { child.kill(); reject(new Error("Server startup timeout")); }, 30000);
    child.stderr!.on("data", (data: Buffer) => {
      const m = data.toString().match(/running on http:\/\/localhost:(\d+)/);
      if (m) { clearTimeout(timeout); resolve({ proc: child, port: parseInt(m[1], 10) }); }
    });
    child.on("error", (err) => { clearTimeout(timeout); reject(err); });
  });
}

interface Answer { path: string; question: string; text: string }

function faqAnswersIn(pagePath: string, html: string): Answer[] {
  const out: Answer[] = [];
  const blocks = html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g);
  for (const block of blocks) {
    let parsed: any;
    try { parsed = JSON.parse(block[1]); } catch { continue; }
    for (const entry of Array.isArray(parsed) ? parsed : [parsed]) {
      if (!entry || entry["@type"] !== "FAQPage" || !Array.isArray(entry.mainEntity)) continue;
      for (const q of entry.mainEntity) {
        const text = q?.acceptedAnswer?.text;
        if (typeof text === "string") out.push({ path: pagePath, question: q.name, text });
      }
    }
  }
  return out;
}

function jsonLdBlocks(html: string): any[] {
  const out: any[] = [];
  for (const block of html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)) {
    try { out.push(JSON.parse(block[1])); } catch { continue; }
  }
  return out;
}

describe("#1086 a review that found defects does not advance the structured date", () => {
  it("advances the date when a review found nothing", () => {
    const passed = record({ published: "2026-04-03", reviewed_at: "2026-08-20", review_outcome: "pass" });
    assert.strictEqual(dateModifiedFor(passed, "2026-01-01", TODAY), "2026-08-20");
  });

  it("holds the date at publication when a review found defects", () => {
    const failed = record({ published: "2026-04-03", reviewed_at: "2026-08-20", review_outcome: "fail" });
    assert.strictEqual(dateModifiedFor(failed, "2026-01-01", TODAY), "2026-04-03");
  });

  it("advances the date for a review recorded with no outcome", () => {
    const older = record({ published: "2026-04-03", reviewed_at: "2026-08-20" });
    assert.strictEqual(dateModifiedFor(older, "2026-01-01", TODAY), "2026-08-20");
  });

  it("uses publication for a page nobody has reviewed, and the caller's date for a page off the register", () => {
    assert.strictEqual(dateModifiedFor(record({ published: "2026-04-03" }), "2026-01-01", TODAY), "2026-04-03");
    assert.strictEqual(dateModifiedFor(null, "2026-01-01", TODAY), "2026-01-01");
  });

  it("ignores a review dated after today, in both directions", () => {
    const ahead = record({ published: "2026-04-03", reviewed_at: "2026-12-01", review_outcome: "fail" });
    assert.strictEqual(dateModifiedFor(ahead, "2026-01-01", TODAY), "2026-04-03");
    const aheadPass = record({ published: "2026-04-03", reviewed_at: "2026-12-01", review_outcome: "pass" });
    assert.strictEqual(dateModifiedFor(aheadPass, "2026-01-01", TODAY), "2026-04-03");
  });
});

describe("#1086 the provenance clause an answer carries is derived, not typed", () => {
  it("names the compile date and the absence of a re-check when nobody has reviewed the page", () => {
    const clause = faqProvenanceClause(record({ published: "2026-04-13" }), TODAY);
    assert.strictEqual(clause, "Figures compiled 2026-04-13, not re-checked since.");
  });

  it("names the date of the last check once a review is on record", () => {
    const clause = faqProvenanceClause(record({ published: "2026-04-13", reviewed_at: "2026-08-20", review_outcome: "pass" }), TODAY);
    assert.strictEqual(clause, "Figures compiled 2026-04-13, last checked 2026-08-20.");
  });

  it("says corrections are outstanding when the review found defects", () => {
    const clause = faqProvenanceClause(record({ published: "2026-04-03", reviewed_at: "2026-08-27", review_outcome: "fail" }), TODAY);
    assert.strictEqual(clause, "Figures compiled 2026-04-03, last checked 2026-08-27; corrections outstanding.");
  });

  it("is the same notice the byline carries", () => {
    const page = record({ published: "2026-04-13", reviewed_at: "2026-08-20", review_outcome: "pass" });
    assert.ok(faqProvenanceClause(page, TODAY).startsWith(compiledNotice("2026-04-13", "2026-08-20")));
  });

  it("says nothing for a page that is not on the register", () => {
    assert.strictEqual(faqProvenanceClause(null, TODAY), "");
  });
});

describe("#1086 which answers state a vendor figure", () => {
  const stated = [
    "Vercel Pro starts at $20/month per team member.",
    "Neon's 0.5 GiB free storage is the tightest limit in the stack.",
    "The vendor's free Developer tier is 50 replays and 30-day retention.",
    "Upstash offers 10,000 Redis commands/day free.",
    "Gemini offers 1,500 free requests/day on the Flash model.",
    "An enhanced free tier with a 500 managed resource cap and 1 concurrent run.",
    "If you need the 1M token context window, Flash is still the best free option.",
    "It is 100% free during public preview.",
    "UptimeRobot checks on a 5-minute interval.",
    "Stripe charges 2.9% + 30¢ per transaction.",
  ];

  const notStated = [
    "Based on our comparison of 56 email services, Resend stands out for its free tier generosity.",
    "We currently index 54 developer services with x402 support across 10 categories.",
    "We weight four factors: pricing history (40%), financial signals (25%), competitive pressure (20%).",
    "The Assistants API will be fully shut down on August 26, 2026.",
    "Change the model parameter from dall-e-3 to gpt-image-1 in your images.generate call.",
    "OpenTofu is a community fork of Terraform under the Linux Foundation with an MPL 2.0 license.",
    "PostgreSQL-compatible databases offer the easiest migration path.",
  ];

  for (const text of stated) {
    it(`treats a figure as stated: ${text.slice(0, 52)}`, () => {
      assert.ok(statesVendorFigure(text), text);
    });
  }

  for (const text of notStated) {
    it(`treats no figure as stated: ${text.slice(0, 52)}`, () => {
      assert.ok(!statesVendorFigure(text), text);
    });
  }
});

describe("#1086 the clause is appended only where a figure is stated", () => {
  const clause = "Figures compiled 2026-04-13, not re-checked since.";

  it("appends to an answer that states a figure", () => {
    const out = answerWithProvenance("Vercel Pro starts at $20/month.", clause);
    assert.strictEqual(out, `Vercel Pro starts at $20/month. ${clause}`);
  });

  it("leaves an answer that states none alone", () => {
    const out = answerWithProvenance("PostgreSQL offers the easiest migration path.", clause);
    assert.strictEqual(out, "PostgreSQL offers the easiest migration path.");
  });

  it("appends nothing when the page is off the register", () => {
    assert.strictEqual(answerWithProvenance("Vercel Pro starts at $20/month.", ""), "Vercel Pro starts at $20/month.");
  });

  it("carries no markup into the structured copy", () => {
    const out = answerWithProvenance('Check our <a href="/stability">Stability Dashboard</a> for 5 GB details.', clause);
    assert.ok(!out.includes("<"), out);
    assert.ok(out.includes("Stability Dashboard"), out);
  });

  it("builds a question for every item it is given", () => {
    const ld: any = faqPageJsonLd("/not-a-registered-page", [{ q: "A?", a: "B." }, { q: "C?", a: "D." }]);
    assert.strictEqual(ld["@type"], "FAQPage");
    assert.deepStrictEqual(ld.mainEntity.map((e: any) => e.name), ["A?", "C?"]);
    assert.deepStrictEqual(ld.mainEntity.map((e: any) => e.acceptedAnswer.text), ["B.", "D."]);
  });
});

describe("#1086 every structured answer that states a vendor figure carries the page's provenance", () => {
  const pages = registeredPages();
  let tmp: string;
  let real: { proc: ChildProcess; port: number };
  let perturbed: { proc: ChildProcess; port: number };
  const answers: Answer[] = [];
  const perturbedAnswers = new Map<string, Answer[]>();
  const bodies = new Map<string, string>();

  before(async () => {
    tmp = mkdtempSync(path.join(tmpdir(), "faq-provenance-"));
    const index = JSON.parse(readFileSync(path.join(REPO, "data", "index.json"), "utf-8"));
    const touchedIndex = perturbTextFields(index.offers, CATALOGUE_TEXT_FIELDS);
    for (const offer of index.offers) offer.vendor = `Perturbed ${offer.vendor}`;
    writeFileSync(path.join(tmp, "index.json"), JSON.stringify(index));
    const changes = JSON.parse(readFileSync(path.join(REPO, "data", "deal_changes.json"), "utf-8"));
    const touchedChanges = perturbTextFields(changes.changes, CHANGE_LOG_TEXT_FIELDS);
    writeFileSync(path.join(tmp, "deal_changes.json"), JSON.stringify(changes));
    assert.ok(touchedIndex > 1000, `perturbed only ${touchedIndex} catalogue fields, so the comparison below proves nothing`);
    assert.ok(touchedChanges > 100, `perturbed only ${touchedChanges} change-log fields, so the comparison below proves nothing`);

    [real, perturbed] = await Promise.all([
      startServer({}),
      startServer({
        AGENTDEALS_INDEX_PATH: path.join(tmp, "index.json"),
        AGENTDEALS_CHANGES_PATH: path.join(tmp, "deal_changes.json"),
      }),
    ]);
    for (const page of pages) {
      const [a, b] = await Promise.all([
        fetch(`http://localhost:${real.port}${page.path}`).then((r) => r.text()),
        fetch(`http://localhost:${perturbed.port}${page.path}`).then((r) => r.text()),
      ]);
      bodies.set(page.path, a);
      answers.push(...faqAnswersIn(page.path, a));
      perturbedAnswers.set(page.path, faqAnswersIn(page.path, b));
    }
  });

  after(() => {
    real?.proc.kill();
    perturbed?.proc.kill();
    if (tmp) rmSync(tmp, { recursive: true, force: true });
  });

  it("finds structured answers on the register to check", () => {
    assert.strictEqual(answers.length, FAQ_BASELINE.answers);
    const withFaq = new Set(answers.map((a) => a.path));
    assert.ok(withFaq.size > 30, `only ${withFaq.size} registered pages emit a structured FAQ`);
  });

  it("leaves no answer stating a figure without one", () => {
    const bare = answers.filter((a) => statesVendorFigure(a.text) && !PROVENANCE.test(a.text));
    assert.deepStrictEqual(bare.map((a) => `${a.path} :: ${a.question}`), []);
  });

  it("holds the number of answers stating a figure, so a new one has to be looked at", () => {
    const stating = answers.filter((a) => statesVendorFigure(a.text));
    assert.strictEqual(stating.length, FAQ_BASELINE.stating_a_figure);
  });

  it("holds the number of answers naming a number the rule does not read as a figure", () => {
    const unread = answers.filter((a) => !statesVendorFigure(a.text) && /\d/.test(a.text));
    assert.strictEqual(unread.length, FAQ_BASELINE.a_digit_but_no_figure);
  });

  it("takes the dates in every clause from the register rather than from the answer", () => {
    const wrong: string[] = [];
    for (const answer of answers) {
      const found = PROVENANCE.exec(answer.text);
      if (!found) continue;
      const page = pages.find((p) => p.path === answer.path)!;
      const expected = faqProvenanceClause(page, TODAY);
      if (!answer.text.endsWith(expected)) wrong.push(`${answer.path} :: ${found[0]} vs ${expected}`);
    }
    assert.deepStrictEqual(wrong, []);
  });

  it("says corrections are outstanding on no page whose review is clean", () => {
    const failing = new Set(pages.filter((p) => p.review_outcome === "fail").map((p) => p.path));
    const saying = [...new Set(answers.filter((a) => /corrections outstanding/.test(a.text)).map((a) => a.path))];
    assert.deepStrictEqual(saying.filter((p) => !failing.has(p)), []);
  });

  it("holds the structured date of a page whose review found defects at its publication date", () => {
    for (const page of pages.filter((p) => p.review_outcome === "fail")) {
      const article = jsonLdBlocks(bodies.get(page.path)!).find((b) => b?.dateModified);
      assert.ok(article, `${page.path} publishes no structured date`);
      assert.strictEqual(article.dateModified, page.published, page.path);
      assert.ok(
        bodies.get(page.path)!.includes("corrections outstanding"),
        `${page.path} holds its structured date back without telling a reader why`
      );
    }
  });

  it("only dates an answer whose figures the catalogue cannot move", () => {
    const moved: string[] = [];
    let frozen = 0;
    for (const page of pages) {
      const before = answers.filter((a) => a.path === page.path);
      const after = perturbedAnswers.get(page.path) ?? [];
      for (let i = 0; i < before.length; i++) {
        if (!PROVENANCE.test(before[i].text)) continue;
        if (!after[i] || after[i].text !== before[i].text) moved.push(`${page.path} :: ${before[i].question}`);
        else frozen += 1;
      }
    }
    assert.deepStrictEqual(moved, []);
    assert.strictEqual(frozen, FAQ_BASELINE.stating_a_figure);
  });

  it("leaves the answers the catalogue does move without a compile date", () => {
    const derived: string[] = [];
    for (const page of pages) {
      const before = answers.filter((a) => a.path === page.path);
      const after = perturbedAnswers.get(page.path) ?? [];
      for (let i = 0; i < before.length; i++) {
        if (after[i] && after[i].text !== before[i].text) derived.push(`${page.path} :: ${before[i].question}`);
      }
    }
    assert.ok(derived.length > 5, `only ${derived.length} answers responded to the catalogue, so the rule above is nearly vacuous`);
  });

  it("makes no claim about the stability of a vendor's pricing history", () => {
    const claims = answers.filter((a) => /stable pricing histor|rated "stable"|have stable pricing|fully stable pricing/.test(a.text));
    assert.deepStrictEqual(claims.map((a) => `${a.path} :: ${a.question}`), []);
  });
});

describe("#1086 recording a failed review changes what the structured copy of the page says", () => {
  const SUBJECT = "/llm-api-pricing";
  const REVIEWED_ON = "2026-08-27";
  let unreviewed: RegisterFixture;
  let failed: RegisterFixture;
  let before_: { proc: ChildProcess; port: number };
  let after_: { proc: ChildProcess; port: number };
  const rendered = new Map<string, string>();

  before(async () => {
    unreviewed = registerWith(REPO, "faq-unreviewed-", { [SUBJECT]: NEVER_REVIEWED });
    failed = registerWith(REPO, "faq-failed-review-", { [SUBJECT]: reviewFailedOn(REVIEWED_ON) });
    [before_, after_] = await Promise.all([
      startServer({ AGENTDEALS_PAGE_REVIEWS_PATH: unreviewed.file }),
      startServer({ AGENTDEALS_PAGE_REVIEWS_PATH: failed.file }),
    ]);
    rendered.set("before", await fetch(`http://localhost:${before_.port}${SUBJECT}`).then((r) => r.text()));
    rendered.set("after", await fetch(`http://localhost:${after_.port}${SUBJECT}`).then((r) => r.text()));
  });

  after(() => {
    before_?.proc.kill();
    after_?.proc.kill();
    for (const fixture of [unreviewed, failed]) {
      if (fixture) rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

  it("has answers that state a figure, so the fixture can show a difference", () => {
    const stating = faqAnswersIn(SUBJECT, rendered.get("before")!).filter((a) => statesVendorFigure(a.text));
    assert.ok(stating.length >= 4, `only ${stating.length} answers state a figure`);
  });

  it("says the figures were never re-checked while no review is on record", () => {
    for (const answer of faqAnswersIn(SUBJECT, rendered.get("before")!)) {
      if (!statesVendorFigure(answer.text)) continue;
      assert.ok(answer.text.endsWith("not re-checked since."), answer.question);
    }
  });

  it("says corrections are outstanding in every dated answer once the review records a failure", () => {
    const dated = faqAnswersIn(SUBJECT, rendered.get("after")!).filter((a) => PROVENANCE.test(a.text));
    assert.ok(dated.length >= 4, `only ${dated.length} answers carry a date`);
    for (const answer of dated) {
      assert.ok(answer.text.endsWith(`last checked ${REVIEWED_ON}; corrections outstanding.`), answer.question);
    }
  });

  it("leaves the structured date at publication rather than advancing it to the review", () => {
    const article = jsonLdBlocks(rendered.get("after")!).find((b) => b?.dateModified);
    assert.ok(article, `${SUBJECT} publishes no structured date`);
    const published = failed.row(SUBJECT).published;
    assert.match(published, /^\d{4}-\d{2}-\d{2}$/);
    assert.notStrictEqual(published, REVIEWED_ON);
    assert.strictEqual(article.dateModified, published);
    assert.strictEqual(article.datePublished, published);
  });
});

describe("#1086 the stability share is not offered as a production recommendation anywhere", () => {
  let server: { proc: ChildProcess; port: number };

  before(async () => { server = await startServer({}); });
  after(() => { server?.proc.kill(); });

  it("keeps it off the category pages that compute it", async () => {
    for (const route of ["/category/databases", "/category/monitoring", "/category/storage"]) {
      const html = await fetch(`http://localhost:${server.port}${route}`).then((r) => r.text());
      for (const answer of faqAnswersIn(route, html)) {
        assert.ok(
          !/stable pricing|rated "stable"|suitable for small production/.test(answer.text),
          `${route} :: ${answer.question}`
        );
      }
    }
  });

  it("still answers how many changes a category has recorded", async () => {
    const html = await fetch(`http://localhost:${server.port}/category/databases`).then((r) => r.text());
    const answers = faqAnswersIn("/category/databases", html);
    assert.ok(answers.length >= 3, `only ${answers.length} answers on the category page`);
    assert.ok(
      answers.some((a) => /pricing change/.test(a.text)),
      "the category page no longer says how many pricing changes it has recorded"
    );
  });
});
