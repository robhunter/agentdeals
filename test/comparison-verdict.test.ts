import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  moreStableSide,
  ratingIsWithheld,
  recordedChangesPhrase,
  stabilityFaqAnswer,
  stabilityVerdictClause,
  type ComparisonSide,
} from "../dist/comparison-verdict.js";
import { buildComparisonMap } from "../dist/comparison-pairs.js";
import { enrichOffers, loadDealChanges, loadOffers } from "../dist/data.js";
import { levelWithheldReason, type LevelWithheldReason } from "../dist/source-check.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(__dirname, "..");

const NAMES_A_WINNER = / has a more stable pricing history \((\d+) recorded changes? vs (\d+)\)\.$/;

function side(over: Partial<ComparisonSide> = {}): ComparisonSide {
  return {
    vendor: "Vendor A",
    recordedChanges: 0,
    rating: "stable",
    ratingWithheldBecause: null,
    unconfirmableSince: "",
    ...over,
  };
}

describe("comparison verdict — the stability clause is derived from the counts the page prints", () => {
  it("names no winner when both sides have the same recorded-change count", () => {
    const a = side({ vendor: "Alpha", recordedChanges: 0, rating: "stable" });
    const b = side({ vendor: "Beta", recordedChanges: 0, rating: "caution" });
    assert.strictEqual(stabilityVerdictClause(a, b), "");
    assert.strictEqual(moreStableSide(a, b), null);
  });

  it("names no winner when both sides have the same non-zero count", () => {
    const a = side({ vendor: "Alpha", recordedChanges: 3, rating: "stable" });
    const b = side({ vendor: "Beta", recordedChanges: 3, rating: "risky" });
    assert.strictEqual(stabilityVerdictClause(a, b), "");
  });

  it("names no winner when the better-rated side has more recorded changes", () => {
    const a = side({ vendor: "DigitalOcean", recordedChanges: 4, rating: "stable" });
    const b = side({ vendor: "Sentry", recordedChanges: 1, rating: "caution" });
    assert.strictEqual(stabilityVerdictClause(a, b), "");
    assert.strictEqual(stabilityVerdictClause(b, a), "");
  });

  it("names the better-rated side only when it also has fewer recorded changes, and states both counts", () => {
    const a = side({ vendor: "Cloudflare Pages", recordedChanges: 0, rating: "stable" });
    const b = side({ vendor: "Netlify", recordedChanges: 4, rating: "caution" });
    assert.strictEqual(
      stabilityVerdictClause(a, b),
      "Cloudflare Pages has a more stable pricing history (0 recorded changes vs 4).",
    );
    assert.strictEqual(stabilityVerdictClause(b, a), stabilityVerdictClause(a, b));
  });

  it("writes a single recorded change in the singular", () => {
    assert.strictEqual(recordedChangesPhrase(1), "1 recorded change");
    assert.strictEqual(recordedChangesPhrase(0), "0 recorded changes");
    assert.strictEqual(recordedChangesPhrase(4), "4 recorded changes");
    const clause = stabilityVerdictClause(
      side({ vendor: "Alpha", recordedChanges: 1, rating: "stable" }),
      side({ vendor: "Beta", recordedChanges: 5, rating: "risky" }),
    );
    assert.strictEqual(clause, "Alpha has a more stable pricing history (1 recorded change vs 5).");
  });

  it("names no winner between two sides carrying the same rating", () => {
    const a = side({ vendor: "Alpha", recordedChanges: 1, rating: "caution" });
    const b = side({ vendor: "Beta", recordedChanges: 4, rating: "caution" });
    assert.strictEqual(stabilityVerdictClause(a, b), "");
  });

  it("ranks neither of two sides we both rate stable", () => {
    const a = side({ vendor: "Alpha", recordedChanges: 0, rating: "stable" });
    const b = side({ vendor: "Beta", recordedChanges: 4, rating: "stable" });
    assert.strictEqual(stabilityVerdictClause(a, b), "");
    assert.strictEqual(moreStableSide(a, b), null);
  });
});

describe("comparison verdict — a withheld rating is stated, never resolved", () => {
  const withheld = (vendor: string, because: LevelWithheldReason, since = "", recordedChanges = 0) =>
    side({ vendor, recordedChanges, rating: null, ratingWithheldBecause: because, unconfirmableSince: since });

  it("treats a withheld rating as withheld, not as a rank", () => {
    assert.strictEqual(ratingIsWithheld(withheld("Duolingo", "unreadable")), true);
    assert.strictEqual(ratingIsWithheld(side({ rating: "risky" })), false);
  });

  it("names no winner when a side's rating is withheld, even where that side has fewer changes", () => {
    const evernote = withheld("Evernote", "link_unreachable", " since 2026-04-23");
    const notion = side({ vendor: "Notion", recordedChanges: 1, rating: "stable" });
    const clause = stabilityVerdictClause(evernote, notion);
    assert.match(clause, /^Evernote's pricing page has not resolved for us since 2026-04-23\./);
    assert.doesNotMatch(clause, NAMES_A_WINNER);
    assert.strictEqual(moreStableSide(evernote, notion), null);
  });

  it("names no winner when the side with the withheld rating carries the higher count", () => {
    const rated = side({ vendor: "Alpha", recordedChanges: 0, rating: "stable" });
    const unrated = withheld("Beta", "states_no_terms", "", 3);
    assert.strictEqual(moreStableSide(rated, unrated), null);
    assert.strictEqual(moreStableSide(unrated, rated), null);
    assert.doesNotMatch(stabilityVerdictClause(rated, unrated), NAMES_A_WINNER);
  });

  it("says which page it could not read and that it is not comparing", () => {
    const clause = stabilityVerdictClause(
      side({ vendor: "Cloudflare Workers", recordedChanges: 0, rating: "stable" }),
      withheld("Duolingo", "unreadable"),
    );
    assert.strictEqual(
      clause,
      "We could not read the page we cite for Duolingo. We are not comparing the two pricing histories.",
    );
  });

  it("states a reason for each side when both ratings are withheld", () => {
    const clause = stabilityVerdictClause(
      withheld("Cline", "states_no_terms"),
      withheld("Aider", "does_not_name_vendor"),
    );
    assert.match(clause, /The page we cite for Cline states no terms we can read\./);
    assert.match(clause, /The page we cite for Aider does not name it\./);
    assert.match(clause, /We are not comparing the two pricing histories\.$/);
  });

  it("still declines to compare when no reason for the withholding is available", () => {
    const clause = stabilityVerdictClause(
      side({ vendor: "Alpha", recordedChanges: 4, rating: "stable" }),
      side({ vendor: "Beta", recordedChanges: 0, rating: null, ratingWithheldBecause: null }),
    );
    assert.match(clause, /We are not publishing a stability rating for Beta\./);
    assert.doesNotMatch(clause, NAMES_A_WINNER);
  });
});

describe("comparison verdict — the prose and the structured data carry the same claim", () => {
  it("ends the structured answer with the clause the prose prints", () => {
    const a = side({ vendor: "Bugsnag", recordedChanges: 0, rating: "stable" });
    const b = side({ vendor: "Sentry", recordedChanges: 1, rating: "caution" });
    const clause = stabilityVerdictClause(a, b);
    assert.ok(clause.length > 0);
    assert.ok(stabilityFaqAnswer(a, b).endsWith(clause));
  });

  it("carries no claim in the structured answer when the prose drops the clause", () => {
    const a = side({ vendor: "DigitalOcean", recordedChanges: 4, rating: "stable" });
    const b = side({ vendor: "Sentry", recordedChanges: 1, rating: "caution" });
    assert.strictEqual(stabilityVerdictClause(a, b), "");
    const answer = stabilityFaqAnswer(a, b);
    assert.doesNotMatch(answer, NAMES_A_WINNER);
    assert.strictEqual(
      answer,
      "DigitalOcean has 4 recorded changes and is rated stable. Sentry has 1 recorded change and is rated caution.",
    );
  });

  it("publishes no rating for a side whose rating is withheld", () => {
    const answer = stabilityFaqAnswer(
      side({ vendor: "Cloudflare Workers", recordedChanges: 0, rating: "stable" }),
      side({ vendor: "Duolingo", recordedChanges: 0, rating: null, ratingWithheldBecause: "unreadable" }),
    );
    assert.match(answer, /Duolingo has 0 recorded changes\./);
    assert.doesNotMatch(answer, /Duolingo[^.]*is rated/);
  });
});

const offers = loadOffers();
const changes = loadDealChanges();
const enriched = new Map<string, ReturnType<typeof enrichOffers>[number]>();
for (const e of enrichOffers(offers)) if (!enriched.has(e.vendor)) enriched.set(e.vendor, e);

function countFor(vendor: string): number {
  return changes.filter(c => c.vendor.toLowerCase() === vendor.toLowerCase()).length;
}

function sideFor(vendor: string): ComparisonSide | null {
  const e = enriched.get(vendor);
  if (!e) return null;
  return {
    vendor,
    recordedChanges: countFor(vendor),
    rating: (e.risk_cause || e.risk_level === "stable" ? e.risk_level : null) as ComparisonSide["rating"],
    ratingWithheldBecause: levelWithheldReason(e, e.link_unreachable),
    unconfirmableSince: e.link_unreachable?.last_reachable ? ` since ${e.link_unreachable.last_reachable}` : "",
  };
}

function sidesFor(pair: [string, string]): [ComparisonSide, ComparisonSide] | null {
  const a = sideFor(pair[0]);
  const b = sideFor(pair[1]);
  return a && b ? [a, b] : null;
}

describe("comparison verdict — census over every linked comparison", () => {
  it("asserts no stability winner that the recorded-change counts do not support", () => {
    const unsupported: string[] = [];
    let named = 0;
    for (const [slug, [va, vb]] of buildComparisonMap()) {
      const a = sideFor(va);
      const b = sideFor(vb);
      assert.ok(a && b, `${slug}: both vendors resolve to an offer`);
      const clause = stabilityVerdictClause(a, b);
      const match = clause.match(NAMES_A_WINNER);
      if (!match) continue;
      named++;
      const claim = (s: ComparisonSide) => `${s.vendor} has a more stable pricing history (`;
      const winner = clause.startsWith(claim(a)) ? a : clause.startsWith(claim(b)) ? b : null;
      if (!winner) {
        unsupported.push(`${slug}: winner is not one of the two vendors — ${clause}`);
        continue;
      }
      const loser = winner === a ? b : a;
      if (winner.recordedChanges >= loser.recordedChanges) {
        unsupported.push(`${slug}: ${winner.vendor} has ${winner.recordedChanges} recorded, ${loser.vendor} has ${loser.recordedChanges}`);
      }
      if (Number(match[1]) !== winner.recordedChanges || Number(match[2]) !== loser.recordedChanges) {
        unsupported.push(`${slug}: clause states ${match[1]} vs ${match[2]}, records hold ${winner.recordedChanges} vs ${loser.recordedChanges}`);
      }
      if (ratingIsWithheld(winner) || ratingIsWithheld(loser)) {
        unsupported.push(`${slug}: named a winner while a rating is withheld`);
      }
    }
    assert.deepStrictEqual(unsupported, []);
    assert.ok(named > 0, "at least one comparison still names a supported winner");
  });

  it("declines to compare on every pair with a withheld rating", () => {
    const resolved: string[] = [];
    for (const [slug, [va, vb]] of buildComparisonMap()) {
      const a = sideFor(va);
      const b = sideFor(vb);
      if (!a || !b) continue;
      if (!ratingIsWithheld(a) && !ratingIsWithheld(b)) continue;
      const clause = stabilityVerdictClause(a, b);
      if (!/We are not comparing the two pricing histories\.$/.test(clause)) resolved.push(`${slug}: ${clause}`);
    }
    assert.deepStrictEqual(resolved, []);
  });
});

describe("comparison verdict — as rendered", () => {
  let proc: ChildProcess | null = null;
  let port = 0;

  before(async () => {
    const started = await new Promise<{ child: ChildProcess; port: number }>((resolve, reject) => {
      const child = spawn("node", [path.join(REPO, "dist", "serve.js")], {
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env, PORT: "0", BASE_URL: "http://localhost" },
      });
      const timeout = setTimeout(() => { child.kill(); reject(new Error("Server startup timeout")); }, 30000);
      child.stderr!.on("data", (data: Buffer) => {
        const m = data.toString().match(/running on http:\/\/localhost:(\d+)/);
        if (m) { clearTimeout(timeout); resolve({ child, port: parseInt(m[1], 10) }); }
      });
      child.on("error", (err) => { clearTimeout(timeout); reject(err); });
    });
    proc = started.child;
    port = started.port;
  });

  after(() => { proc?.kill(); });

  const get = async (route: string) => {
    const res = await fetch(`http://localhost:${port}${route}`, {
      headers: { "user-agent": "agentdeals-internal/1.0 (comparison-verdict-test)" },
    });
    assert.strictEqual(res.status, 200, `${route} responded ${res.status}`);
    return res.text();
  };

  const escaped = (s: string) =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

  const firstSlugWhere = (predicate: (sides: [ComparisonSide, ComparisonSide]) => boolean) => {
    for (const [slug, pair] of buildComparisonMap()) {
      const sides = sidesFor(pair);
      if (sides && predicate(sides)) return { slug, sides };
    }
    return null;
  };

  const renderedVerdict = (html: string) => {
    const m = html.match(/<div class="verdict-section">\s*<h2>Verdict<\/h2>\s*<p>([\s\S]*?)<\/p>/);
    assert.ok(m, "the page renders a verdict paragraph");
    return m[1];
  };

  const renderedStabilityAnswer = (html: string, sides: [ComparisonSide, ComparisonSide]) => {
    const blocks = [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)]
      .map(m => JSON.parse(m[1]) as Record<string, unknown>);
    const faq = blocks.find(b => b["@type"] === "FAQPage") as
      { mainEntity: Array<{ name: string; acceptedAnswer: { text: string } }> } | undefined;
    assert.ok(faq, "the page emits FAQ structured data");
    const question = faq.mainEntity.find(q => q.name === `Is ${sides[0].vendor} or ${sides[1].vendor} more stable?`);
    assert.ok(question, "the structured data answers which of the two is more stable");
    return question.acceptedAnswer.text;
  };

  const assertRendersItsClause = async (slug: string, sides: [ComparisonSide, ComparisonSide]) => {
    const html = await get(`/compare/${slug}`);
    const clause = stabilityVerdictClause(sides[0], sides[1]);
    const verdict = renderedVerdict(html);
    const answer = renderedStabilityAnswer(html, sides);
    if (clause) {
      assert.ok(verdict.includes(escaped(clause)), `${slug} verdict does not render "${clause}"`);
      assert.ok(answer.includes(clause), `${slug} structured data does not carry "${clause}"`);
    } else {
      assert.doesNotMatch(verdict, /has a more stable pricing history/, `${slug} verdict names a winner the rule does not`);
      assert.doesNotMatch(answer, /has a more stable pricing history/, `${slug} structured data names a winner the rule does not`);
    }
    return html;
  };

  it("renders on every linked comparison exactly the clause its own counts support", async () => {
    const wrong: string[] = [];
    for (const [slug, pair] of buildComparisonMap()) {
      const sides = sidesFor(pair);
      if (!sides) continue;
      const html = await get(`/compare/${slug}`);
      const clause = stabilityVerdictClause(sides[0], sides[1]);
      const verdict = renderedVerdict(html);
      const answer = renderedStabilityAnswer(html, sides);
      if (clause && !verdict.includes(escaped(clause))) wrong.push(`${slug}: the verdict does not render "${clause}"`);
      if (clause && !answer.includes(clause)) wrong.push(`${slug}: the structured data does not carry "${clause}"`);
      if (!clause && /has a more stable pricing history/.test(verdict)) wrong.push(`${slug}: the verdict names a winner the counts do not support`);
      if (!clause && /has a more stable pricing history/.test(answer)) wrong.push(`${slug}: the structured data names a winner the counts do not support`);
      for (const s of sides) {
        if (s.recordedChanges > 5 && !html.includes(`Showing the 5 most recent of ${s.recordedChanges} recorded changes for ${escaped(s.vendor)}.`)) {
          wrong.push(`${slug}: lists 5 of ${s.recordedChanges} for ${s.vendor} without saying so`);
        }
      }
    }
    assert.deepStrictEqual(wrong, []);
  });

  it("no longer calls the vendor with more recorded changes the more stable of the two", async () => {
    const pair = buildComparisonMap().get("digitalocean-vs-sentry");
    assert.ok(pair, "digitalocean-vs-sentry is a linked comparison");
    const sides = sidesFor(pair)!;
    const html = await assertRendersItsClause("digitalocean-vs-sentry", sides);
    const worse = sides[0].recordedChanges > sides[1].recordedChanges ? sides[0] : sides[1];
    assert.ok(!html.includes(`${worse.vendor} has a more stable pricing history`), `${worse.vendor} has the higher count`);
  });

  it("says why it is not comparing when a rating is withheld", async () => {
    const found = firstSlugWhere(([a, b]) => ratingIsWithheld(a) || ratingIsWithheld(b));
    assert.ok(found, "at least one linked comparison has a withheld rating");
    const html = await assertRendersItsClause(found.slug, found.sides);
    assert.match(html, /We are not comparing the two pricing histories/);
    assert.doesNotMatch(html, /We are not publishing a stability rating for/);
  });

  it("keeps a supported claim and prints the counts behind it", async () => {
    const found = firstSlugWhere(sides => NAMES_A_WINNER.test(stabilityVerdictClause(sides[0], sides[1])));
    assert.ok(found, "at least one linked comparison still names a supported winner");
    const html = await assertRendersItsClause(found.slug, found.sides);
    assert.match(html, /has a more stable pricing history \(\d+ recorded changes? vs \d+\)/);
  });

  it("states how many recorded changes a truncated list is drawn from", async () => {
    const found = firstSlugWhere(([a, b]) => a.recordedChanges > 5 || b.recordedChanges > 5);
    assert.ok(found, "at least one linked comparison lists more changes than it can show");
    const html = await get(`/compare/${found.slug}`);
    for (const s of found.sides) {
      if (s.recordedChanges > 5) {
        assert.ok(
          html.includes(`Showing the 5 most recent of ${s.recordedChanges} recorded changes for ${escaped(s.vendor)}.`),
          `${found.slug} does not say how many changes ${s.vendor} has`,
        );
      }
    }
  });
});
