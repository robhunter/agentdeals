import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  CHANGE_KIND_NOUN,
  DEMOTING_KINDS_PHRASE,
  narrowingSentence,
  publishedVendorLevel,
  vendorVerdictSentence,
  vendorVerdictWord,
  type VendorVerdictInput,
} from "../dist/vendor-verdict.js";
import { CHANGE_DIRECTION, enrichOffers, loadDealChanges, loadOffers, vendorRiskAssessment, classifyStability } from "../dist/data.js";
import { vendorSlugMap } from "../dist/vendor-slug.js";
import { levelWithheldReason } from "../dist/source-check.js";
import type { DealChange, RiskCause } from "../dist/types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(__dirname, "..");

const STABILITY_SCALE_WORDS = /\b(volatile|improving)\b|on our watch list/i;
const OTHER_SCALE_ON_A_SURFACE_THAT_EMBEDS_SUMMARIES = /\bvolatile\b|on our watch list/i;
const COUNT_AS_EVIDENCE = /\b\d+ pricing changes? recorded/;
const CLAIMS_A_NARROWING = /(?:One recorded [^.]*|(?<!None of the )\d+ recorded changes) narrowed the terms/;

function change(over: Partial<DealChange> = {}): DealChange {
  return {
    vendor: "Vendor A",
    date: "2026-03-01",
    date_source: "vendor_page",
    change_type: "limits_reduced",
    summary: "Free tier storage cut from 10 GB to 1 GB",
    impact: "medium",
    category: "Databases",
    ...over,
  } as DealChange;
}

function causeOf(c: DealChange): RiskCause {
  return { date: c.date, date_source: c.date_source, change_type: c.change_type, summary: c.summary };
}

function input(over: Partial<VendorVerdictInput> = {}): VendorVerdictInput {
  return { level: "stable", cause: null, changes: [], levelWithheld: null, unconfirmableSince: "", ...over };
}

describe("vendor verdict — one rating word, and it carries its cause", () => {
  it("states the level and the kind of record that earned it, never a count", () => {
    const c = change({ change_type: "limits_reduced", date: "2026-03-01" });
    const sentence = vendorVerdictSentence(input({ level: "caution", cause: causeOf(c), changes: [c] }));
    assert.strictEqual(sentence, "We rate it caution — one recorded limit reduction, on 2026-03-01.");
    assert.doesNotMatch(sentence, COUNT_AS_EVIDENCE);
  });

  it("names a free tier removal as the cause of a risky rating", () => {
    const c = change({ change_type: "free_tier_removed", date: "2026-04-13" });
    const sentence = vendorVerdictSentence(input({ level: "risky", cause: causeOf(c), changes: [c] }));
    assert.strictEqual(sentence, "We rate it risky — one recorded free tier removal, on 2026-04-13.");
  });

  it("dates a cause we found ourselves as discovered, not as the day it took effect", () => {
    const c = change({ change_type: "limits_reduced", date: "2026-08-28", date_source: "discovered" });
    const sentence = vendorVerdictSentence(input({ level: "caution", cause: causeOf(c), changes: [c] }));
    assert.strictEqual(sentence, "We rate it caution — one recorded limit reduction, discovered 2026-08-28.");
  });

  it("falls back to stable when a level arrives with no record to show for it", () => {
    assert.strictEqual(publishedVendorLevel("caution", null), "stable");
    assert.strictEqual(publishedVendorLevel("risky", null), "stable");
    assert.strictEqual(publishedVendorLevel(null, null), "stable");
    const c = change();
    assert.strictEqual(publishedVendorLevel("caution", causeOf(c)), "caution");
  });

  it("withholds the rating entirely when we cannot read the page we cite", () => {
    const withheld = input({ level: "stable", levelWithheld: "states_no_terms", changes: [change()] });
    assert.strictEqual(vendorVerdictWord(withheld), null);
    assert.strictEqual(
      vendorVerdictSentence(withheld),
      "The page we cite for this offer states no terms we can read, so we cannot confirm these terms today.",
    );
  });

  it("says a link has not resolved, with the date it last did", () => {
    const withheld = input({ levelWithheld: "link_unreachable", unconfirmableSince: " since 2026-05-02" });
    assert.strictEqual(
      vendorVerdictSentence(withheld),
      "Its pricing page has not resolved for us since 2026-05-02, so we cannot confirm these terms today.",
    );
  });
});

describe("vendor verdict — a stable rating reports direction, not volume", () => {
  it("says zero changes are recorded when we hold none", () => {
    assert.strictEqual(vendorVerdictSentence(input()), "It's stable — zero pricing changes recorded.");
    assert.strictEqual(narrowingSentence([]), "");
  });

  it("says the one record it holds did not narrow the terms", () => {
    const c = change({ change_type: "limits_increased" });
    const sentence = vendorVerdictSentence(input({ changes: [c] }));
    assert.ok(sentence.includes(`we hold no ${DEMOTING_KINDS_PHRASE} for this vendor`));
    assert.ok(sentence.endsWith("The one change we have recorded did not narrow the terms."));
  });

  it("counts only the records that pointed down, not every record", () => {
    const changes = [
      change({ change_type: "limits_increased", date: "2026-01-01" }),
      change({ change_type: "limits_increased", date: "2025-01-22" }),
      change({ change_type: "restriction", date: "2026-03-21" }),
      change({ change_type: "restriction", date: "2026-08-28" }),
    ];
    const sentence = vendorVerdictSentence(input({ changes }));
    assert.ok(sentence.endsWith("2 recorded changes narrowed the terms, the most recent on 2026-08-28."));
    assert.doesNotMatch(sentence, /4 recorded changes narrowed/);
    assert.doesNotMatch(sentence, COUNT_AS_EVIDENCE);
  });

  it("names the single record that narrowed the terms", () => {
    const changes = [
      change({ change_type: "limits_increased", date: "2026-01-01" }),
      change({ change_type: "restriction", date: "2026-03-01" }),
    ];
    const sentence = vendorVerdictSentence(input({ changes }));
    assert.ok(sentence.endsWith("One recorded restriction narrowed the terms, on 2026-03-01."));
  });

  it("reports that none narrowed the terms when every record points the other way", () => {
    const changes = [
      change({ change_type: "limits_increased", date: "2026-01-01" }),
      change({ change_type: "new_free_tier", date: "2026-02-01" }),
      change({ change_type: "rebranded", date: "2026-03-01" }),
    ];
    assert.strictEqual(narrowingSentence(changes), "None of the 3 recorded changes narrowed the terms.");
  });

  it("says what a record that repairs our own entry is, rather than counting it as a change", () => {
    const changes = [change({ change_type: "record_corrected", date: "2026-03-22" })];
    assert.strictEqual(
      narrowingSentence(changes),
      "The one record we hold corrects our own earlier entry rather than reporting a change the vendor made.",
    );
    assert.doesNotMatch(narrowingSentence(changes), /narrowed the terms/);
    assert.doesNotMatch(vendorVerdictSentence(input({ changes })), /zero pricing changes recorded/);
  });

  it("says so for every repair when we hold nothing else", () => {
    const changes = [
      change({ change_type: "record_corrected", date: "2026-03-22" }),
      change({ change_type: "record_corrected", date: "2026-03-21" }),
    ];
    assert.strictEqual(
      narrowingSentence(changes),
      "All 2 records we hold correct our own earlier entries rather than reporting changes the vendor made.",
    );
  });

  it("leaves a repair out of both sides of the narrowing count", () => {
    const changes = [
      change({ change_type: "limits_increased", date: "2026-01-01" }),
      change({ change_type: "limits_increased", date: "2025-01-22" }),
      change({ change_type: "record_corrected", date: "2026-03-21" }),
      change({ change_type: "restriction", date: "2026-08-28" }),
    ];
    assert.strictEqual(
      narrowingSentence(changes),
      "One recorded restriction narrowed the terms, on 2026-08-28.",
    );
    assert.doesNotMatch(narrowingSentence(changes), /2 recorded changes narrowed/);
    const noNarrowing = changes.filter(c => c.change_type !== "restriction");
    assert.strictEqual(narrowingSentence(noNarrowing), "None of the 2 recorded changes narrowed the terms.");
  });

  it("never reaches for the second scale's vocabulary", () => {
    for (const changes of [[], [change()], [change({ change_type: "limits_increased" })], [change({ change_type: "product_deprecated" })]]) {
      assert.doesNotMatch(vendorVerdictSentence(input({ changes })), STABILITY_SCALE_WORDS);
    }
  });
});

describe("vendor verdict — the prose table covers the data", () => {
  it("names every change type present in the change log", () => {
    const missing = [...new Set(loadDealChanges().map(c => c.change_type))]
      .filter(t => !(t in CHANGE_KIND_NOUN));
    assert.deepStrictEqual(missing, [], `change types with no reader-facing noun: ${missing.join(", ")}`);
  });
});

interface VendorRow {
  slug: string;
  vendor: string;
  expected: "stable" | "caution" | "risky";
  withheld: ReturnType<typeof levelWithheldReason>;
  badgeRendered: boolean;
  sentence: string;
  changes: DealChange[];
}

function vendorRows(): VendorRow[] {
  const offers = loadOffers();
  const changes = loadDealChanges();
  const rows: VendorRow[] = [];
  for (const [slug, vendor] of vendorSlugMap) {
    const primary = offers.find(o => o.vendor === vendor);
    if (!primary) continue;
    const enriched = enrichOffers([primary])[0];
    const vendorChanges = changes
      .filter(c => c.vendor.toLowerCase() === vendor.toLowerCase())
      .sort((a, b) => b.date.localeCompare(a.date));
    const withheld = levelWithheldReason(primary, enriched.link_unreachable);
    const expected = publishedVendorLevel(enriched.risk_level ?? null, enriched.risk_cause ?? null);
    const unconfirmableSince = enriched.link_unreachable?.last_reachable
      ? ` since ${enriched.link_unreachable.last_reachable}`
      : "";
    rows.push({
      slug,
      vendor,
      expected,
      withheld,
      badgeRendered: !(enriched.risk_level === null || (enriched.link_unreachable && expected === "stable")),
      sentence: vendorVerdictSentence({
        level: enriched.risk_level ?? null,
        cause: enriched.risk_cause ?? null,
        changes: vendorChanges,
        levelWithheld: withheld,
        unconfirmableSince,
      }),
      changes: vendorChanges,
    });
  }
  return rows;
}

describe("vendor verdict — corpus invariant, computed offline", () => {
  it("gives every vendor we hold records for one rating word and no second scale", () => {
    const wrong: string[] = [];
    for (const row of vendorRows()) {
      if (row.changes.length === 0) continue;
      if (STABILITY_SCALE_WORDS.test(row.sentence)) {
        wrong.push(`${row.slug}: verdict reaches for a second scale — ${row.sentence}`);
        continue;
      }
      if (!row.badgeRendered) {
        if (/\bWe rate it\b/.test(row.sentence)) wrong.push(`${row.slug}: rates a vendor whose badge is withheld`);
        continue;
      }
      const named = row.sentence.match(/We rate it (stable|caution|risky)\b/)?.[1]
        ?? (row.sentence.startsWith("It's stable") ? "stable" : null);
      if (named !== row.expected) {
        wrong.push(`${row.slug}: badge says ${row.expected}, verdict says ${named ?? "nothing"}`);
      }
      if (row.withheld && !/cannot confirm the terms above/.test(row.sentence)) {
        wrong.push(`${row.slug}: rates the vendor without saying we cannot confirm the terms we print`);
      }
    }
    assert.deepStrictEqual(wrong, [], `vendors whose two stability judgements disagree:\n${wrong.join("\n")}`);
  });

  it("covers vendors the two classifiers rate differently, so the invariant is not vacuous", () => {
    const changes = loadDealChanges();
    const byVendor = new Map<string, DealChange[]>();
    for (const c of changes) {
      const key = c.vendor.toLowerCase();
      if (!byVendor.has(key)) byVendor.set(key, []);
      byVendor.get(key)!.push(c);
    }
    const negativeStability = new Set(["watch", "volatile"]);
    const disagreeing = [...byVendor.entries()].filter(([, vc]) =>
      vendorRiskAssessment(vc).level === "stable" && negativeStability.has(classifyStability(vc)));
    assert.ok(
      disagreeing.length > 0,
      "the change log holds no vendor the risk scale and the stability enum rate differently",
    );
    const routed = vendorRows().filter(r => r.changes.length > 0
      && vendorRiskAssessment(r.changes).level === "stable"
      && negativeStability.has(classifyStability(r.changes)));
    assert.ok(routed.length > 0, "no rendered vendor route sits in that population");
  });
});

describe("vendor verdict — as rendered", () => {
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
      headers: { "user-agent": "agentdeals-internal/1.0 (vendor-verdict-test)" },
    });
    assert.strictEqual(res.status, 200, `${route} responded ${res.status}`);
    return res.text();
  };

  const badgeWord = (html: string): string | null => {
    const h1 = html.match(/<h1>[\s\S]*?<\/h1>/)?.[0] ?? "";
    return h1.match(/<span class="risk-badge"[^>]*>([a-z]+)<\/span>/)?.[1] ?? null;
  };

  const verdictParagraph = (html: string): string => {
    const m = html.match(/<div class="quick-verdict">\s*<p>([\s\S]*?)<\/p>/);
    assert.ok(m, "the page renders a verdict paragraph");
    return m[1];
  };

  const comparisonCell = (html: string): { rendered: boolean; word: string | null } => {
    const row = html.match(/<tr class="current-vendor-row">[\s\S]*?<\/tr>/)?.[0];
    if (!row) return { rendered: false, word: null };
    return {
      rendered: true,
      word: row.match(/<span class="stability-dot"[^>]*><\/span> <span[^>]*>([a-z]+)<\/span>/)?.[1] ?? null,
    };
  };

  const faqAnswers = (html: string, vendor: string): { reliable: string; production: string } => {
    const blocks = [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)]
      .map(m => JSON.parse(m[1]) as Record<string, unknown>);
    const faq = blocks.find(b => b["@type"] === "FAQPage") as
      { mainEntity: Array<{ name: string; acceptedAnswer: { text: string } }> } | undefined;
    assert.ok(faq, `${vendor} emits FAQ structured data`);
    const find = (name: string) => {
      const q = faq.mainEntity.find(e => e.name === name);
      assert.ok(q, `the structured data answers "${name}"`);
      return q.acceptedAnswer.text;
    };
    return {
      reliable: find(`Is ${vendor}'s free tier reliable?`),
      production: find(`Is ${vendor}'s free tier good for production?`),
    };
  };

  it("renders on every vendor route the one rating its own records support", async () => {
    const rows = vendorRows();
    const wrong: string[] = [];
    let index = 0;
    const worker = async () => {
      while (index < rows.length) {
        const row = rows[index++];
        const html = await get(`/vendor/${row.slug}`);
        const badge = badgeWord(html);
        const verdict = verdictParagraph(html);
        const cell = comparisonCell(html);

        if (row.badgeRendered && badge !== row.expected) {
          wrong.push(`${row.slug}: h1 badge is ${badge ?? "absent"}, expected ${row.expected}`);
        }
        if (!row.badgeRendered && badge !== null) {
          wrong.push(`${row.slug}: h1 badge renders ${badge} for a rating we are withholding`);
        }
        if (!verdict.includes(row.sentence)) {
          wrong.push(`${row.slug}: verdict does not render "${row.sentence}"`);
        }
        if (STABILITY_SCALE_WORDS.test(verdict)) {
          wrong.push(`${row.slug}: verdict reaches for a second scale — ${verdict}`);
        }
        if (COUNT_AS_EVIDENCE.test(verdict) && row.changes.length > 0) {
          wrong.push(`${row.slug}: verdict offers a count of changes as its evidence`);
        }
        if (cell.rendered && !row.withheld && cell.word !== row.expected) {
          wrong.push(`${row.slug}: comparison table says ${cell.word ?? "nothing"}, h1 badge says ${row.expected}`);
        }
      }
    };
    await Promise.all(Array.from({ length: 12 }, worker));
    assert.deepStrictEqual(wrong.slice(0, 20), [], `vendor routes rendering more than one judgement:\n${wrong.slice(0, 20).join("\n")}`);
  });

  it("answers both of its own stability questions with the same word", async () => {
    const rows = vendorRows().filter(r => r.changes.length > 0);
    const wrong: string[] = [];
    let index = 0;
    const worker = async () => {
      while (index < rows.length) {
        const row = rows[index++];
        const html = await get(`/vendor/${row.slug}`);
        const answers = faqAnswers(html, row.vendor);
        for (const [name, text] of Object.entries(answers)) {
          if (OTHER_SCALE_ON_A_SURFACE_THAT_EMBEDS_SUMMARIES.test(text)) {
            wrong.push(`${row.slug}: the "${name}" answer reaches for a second scale — ${text}`);
          }
        }
        if (!row.withheld && !answers.reliable.includes(row.expected)) {
          wrong.push(`${row.slug}: the reliability answer does not carry the ${row.expected} rating`);
        }
        if (!row.withheld && row.expected === "stable" && !answers.reliable.includes(narrowingSentence(row.changes))) {
          wrong.push(`${row.slug}: the reliability answer does not say what the records it holds did — ${answers.reliable}`);
        }
        const productionRating = answers.production.match(/we rate it (stable|caution|risky)\b/)?.[1];
        if (productionRating && productionRating !== row.expected) {
          wrong.push(`${row.slug}: the production answer says ${productionRating}, the badge says ${row.expected}`);
        }
      }
    };
    await Promise.all(Array.from({ length: 12 }, worker));
    assert.deepStrictEqual(wrong.slice(0, 20), [], `vendor routes whose FAQ contradicts their badge:\n${wrong.slice(0, 20).join("\n")}`);
  });

  it("names a narrowing only where a record of the vendor's own establishes one", async () => {
    const rows = vendorRows().filter(r => r.changes.length > 0);
    const wrong: string[] = [];
    let index = 0;
    const worker = async () => {
      while (index < rows.length) {
        const row = rows[index++];
        const html = await get(`/vendor/${row.slug}`);
        const verdict = verdictParagraph(html);
        const narrowing = row.changes.filter(c => CHANGE_DIRECTION[c.change_type] === "negative");
        if (CLAIMS_A_NARROWING.test(verdict) && narrowing.length === 0) {
          wrong.push(`${row.slug}: names a narrowing over ${row.changes.length} record(s), none of which point down`);
        }
        if (row.changes.every(c => c.change_type === "record_corrected")) {
          if (!/corrects? our own earlier entr/.test(verdict)) {
            wrong.push(`${row.slug}: holds only repairs to our own entries and does not say so — ${verdict}`);
          }
          if (CLAIMS_A_NARROWING.test(verdict) || /pricing changes? recorded/.test(verdict)) {
            wrong.push(`${row.slug}: renders a repair to our own entry as a change the vendor made — ${verdict}`);
          }
        }
      }
    };
    await Promise.all(Array.from({ length: 12 }, worker));
    assert.deepStrictEqual(wrong.slice(0, 20), [], `vendor routes claiming a narrowing they cannot show:\n${wrong.slice(0, 20).join("\n")}`);
  });

  it("counts one narrowing on the route that carried a repair as a second", async () => {
    const digitalocean = verdictParagraph(await get("/vendor/digitalocean"));
    assert.match(digitalocean, /One recorded restriction narrowed the terms/);
    assert.doesNotMatch(digitalocean, /2 recorded changes narrowed the terms/);

    const neo4j = verdictParagraph(await get("/vendor/neo4j-auradb"));
    assert.match(neo4j, /The one record we hold corrects our own earlier entry rather than reporting a change the vendor made\./);
    assert.doesNotMatch(neo4j, /narrowed the terms/);
  });

  it("resolves the four routes that rendered a green badge over a negative verdict", async () => {
    for (const slug of ["digitalocean", "google-gemini-api", "postman", "xata"]) {
      const row = vendorRows().find(r => r.slug === slug);
      assert.ok(row, `/vendor/${slug} is a rendered route`);
      const html = await get(`/vendor/${slug}`);
      assert.strictEqual(badgeWord(html), row.expected, `/vendor/${slug} badge`);
      assert.strictEqual(comparisonCell(html).word, row.expected, `/vendor/${slug} comparison cell`);
      const verdict = verdictParagraph(html);
      assert.doesNotMatch(verdict, STABILITY_SCALE_WORDS, `/vendor/${slug} verdict`);
      assert.ok(verdict.includes(row.sentence), `/vendor/${slug} verdict does not render "${row.sentence}"`);
      assert.match(row.sentence, /narrowed the terms/, `/vendor/${slug} still names the records that pointed down`);
    }
  });

  it("stops offering a product whose own shutdown date has passed", async () => {
    const html = await get("/vendor/hypertune");
    const pageMeta = html.match(/<p class="page-meta">([\s\S]*?)<\/p>/)?.[1] ?? "";
    assert.match(pageMeta, /Discontinued 2026-08-10/);
    assert.doesNotMatch(pageMeta, /Verified/, "the subhead still stamps a discontinued product as verified");

    const metaDesc = html.match(/<meta name="description" content="([^"]*)"/)?.[1] ?? "";
    assert.doesNotMatch(metaDesc, /Verified [A-Z][a-z]+ \d{4}/, "search results still stamp it as verified");

    const verdict = verdictParagraph(html);
    assert.match(verdict, /discontinued on 2026-08-10, so it is not a current option/);
    assert.doesNotMatch(verdict, /Best for [a-z ]*workloads/, "the verdict still recommends it for a workload");

    assert.ok(
      !/class="section growth-section"/.test(html),
      "the page still tells the reader when they will outgrow a free tier that has ended",
    );
    assert.match(html, /<div class="detail-label">Discontinued<\/div>\s*<div class="detail-value"[^>]*>2026-08-10<\/div>/);
  });

  it("leaves the verified stamp on a product being sunset with no date past", async () => {
    const html = await get("/vendor/lost-pixel-com");
    const pageMeta = html.match(/<p class="page-meta">([\s\S]*?)<\/p>/)?.[1] ?? "";
    assert.match(pageMeta, /Verified [A-Z][a-z]+ \d{4}/);
    assert.doesNotMatch(pageMeta, /Discontinued/);
    assert.strictEqual(badgeWord(html), "risky", "a product being sunset is still rated on the record we hold");
  });
});
