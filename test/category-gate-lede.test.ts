import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const { gateFor, utcDate } = await import("../dist/ranking.js");

type Offer = import("../src/types.ts").Offer;
type Gate = { code: string; reason: string } | null;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(__dirname, "..");

const offers: Offer[] = JSON.parse(readFileSync(path.join(REPO, "data", "index.json"), "utf-8")).offers;
const TODAY = utcDate();

const ALL_GATED_ELIGIBILITY_LEDE = "none of them generally available — each requires an application or qualification.";
const RANKED_LIST_PHRASE = "not on our ranked list";

const CLAUSE_FORMS: Record<string, (n: number) => string> = {
  eligibility_restricted: (n) => (n === 1 ? "1 requires an application or qualification" : `${n} require an application or qualification`),
  not_a_free_offer: (n) => (n === 1 ? "1 is not a free offer" : `${n} are not free offers`),
  offer_expired: (n) => (n === 1 ? "1 has expired" : `${n} have expired`),
  offer_retired: (n) => (n === 1 ? "1 has ended" : `${n} have ended`),
  verification_lapsed: (n) => (n === 1 ? "1 has not been re-confirmed recently enough" : `${n} have not been re-confirmed recently enough`),
};

const CLAUSE_ORDER = ["eligibility_restricted", "not_a_free_offer", "offer_expired", "offer_retired", "verification_lapsed"];

function clausesFor(codes: string[]): string {
  const parts: string[] = [];
  for (const code of CLAUSE_ORDER) {
    const n = codes.filter((c) => c === code).length;
    if (n === 0) continue;
    const form = CLAUSE_FORMS[code];
    assert.ok(form, `no clause form for gate code ${code}`);
    parts.push(form(n));
  }
  return parts.join(", ");
}

function expectedLede(total: number, codes: string[]): string {
  const counted = `${total} verified free tiers and developer deals`;
  if (codes.length === 0) return `${counted}.`;
  if (codes.length >= total && codes.every((c) => c === "eligibility_restricted")) {
    return `${counted}, ${ALL_GATED_ELIGIBILITY_LEDE}`;
  }
  const clauses = clausesFor(codes);
  if (codes.length >= total && total > 1) return `${counted}. None of them are on our ranked list — ${clauses}.`;
  if (codes.length === 1) return `${counted}. One of them is not on our ranked list — ${clauses}.`;
  return `${counted}. ${codes.length} of them are not on our ranked list — ${clauses}.`;
}

function slugOf(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

interface CategoryCensus {
  name: string;
  slug: string;
  records: Offer[];
  gates: Gate[];
  codes: string[];
  total: number;
  gated: number;
}

const census: CategoryCensus[] = [...new Set(offers.map((o) => o.category))].sort().map((name) => {
  const records = offers.filter((o) => o.category === name);
  const gates: Gate[] = records.map((o) => gateFor(o, TODAY));
  return {
    name,
    slug: slugOf(name),
    records,
    gates,
    codes: gates.filter((g): g is NonNullable<Gate> => g !== null).map((g) => g.code),
    total: records.length,
    gated: gates.filter((g) => g !== null).length,
  };
});

let port = 0;
let proc: ChildProcess | null = null;

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

const fetched = new Map<string, string>();

async function page(pathname: string): Promise<string> {
  const cached = fetched.get(pathname);
  if (cached !== undefined) return cached;
  const body = await (await fetch(`http://localhost:${port}${pathname}`)).text();
  fetched.set(pathname, body);
  return body;
}

function textOf(fragment: string): string {
  return fragment.replace(/<[^>]+>/g, "").replace(/&mdash;/g, "—").replace(/&amp;/g, "&").trim();
}

function ledeOf(html: string): string {
  return textOf(html.match(/<p class="cat-meta">([\s\S]*?)<\/p>/)?.[1] ?? "");
}

function introOf(html: string): string {
  return textOf(html.match(/<div class="cat-intro">\s*<p>([\s\S]*?)<\/p>/)?.[1] ?? "");
}

function descriptionOf(html: string): string {
  return (html.match(/<meta name="description" content="([^"]*)"/)?.[1] ?? "").replace(/&amp;/g, "&");
}

function leaderNamedIn(intro: string): string | null {
  return intro.match(/services with free tiers\.\s+(.+?) leads with /)?.[1] ?? null;
}

function renderedFaqAnswer(html: string, question: string): string | undefined {
  for (const m of html.matchAll(/<summary class="faq-q">([\s\S]*?)<\/summary>\s*<div class="faq-a">([\s\S]*?)<\/div>/g)) {
    if (textOf(m[1]) === question) return m[2];
  }
  return undefined;
}

function bestServiceClaimIn(answer: string): string | null {
  return answer.match(/services include .+?\.\s(.+?) offers .+? on their .+? plan\./)?.[1] ?? null;
}

function disclosedCountIn(lede: string, total: number): number {
  if (lede.includes(ALL_GATED_ELIGIBILITY_LEDE)) return total;
  if (lede.includes(`None of them are ${RANKED_LIST_PHRASE}`)) return total;
  if (lede.includes(`One of them is ${RANKED_LIST_PHRASE}`)) return 1;
  const named = lede.match(/(\d[\d,]*) of them are not on our ranked list/);
  return named ? parseInt(named[1].replace(/,/g, ""), 10) : 0;
}

describe("a category page discloses every gated record, not eligibility alone", () => {
  before(async () => { proc = await startServer(); });
  after(() => { proc?.kill(); });

  it("holds the four populations the sentence forms are written for", () => {
    assert.ok(census.some((c) => c.gated === 0), "no category is free of gated records");
    assert.ok(census.some((c) => c.gated === 1), "no category holds exactly one gated record");
    assert.ok(census.some((c) => c.gated > 1 && c.gated < c.total), "no category is partly gated");
    assert.ok(census.some((c) => c.gated === c.total && c.total > 1), "no category is entirely gated");
    assert.ok(
      census.some((c) => new Set(c.codes).size > 1),
      "no category mixes gate codes, so the clause list is never exercised",
    );
    assert.ok(
      census.some((c) => c.gated > 0 && !c.codes.includes("eligibility_restricted")),
      "every gated category holds an eligibility record, so the widening is untested",
    );
  });

  it("states the sentence its own records compose", async () => {
    for (const c of census) {
      const lede = ledeOf(await page(`/category/${c.slug}`));
      const expected = expectedLede(c.total, c.codes);
      assert.ok(
        lede.startsWith(expected),
        `/category/${c.slug} (${c.gated} of ${c.total})\n  reads: ${lede}\n  should: ${expected}`,
      );
      assert.ok(!lede.includes("  "), `/category/${c.slug} lede holds a gap: ${lede}`);
      const rest = lede.slice(expected.length);
      assert.ok(
        rest === "" || /^ Data verified through \d{4}-\d{2}-\d{2}\.$/.test(rest),
        `/category/${c.slug} lede carries ${JSON.stringify(rest)} after the sentence`,
      );
    }
  });

  it("never names a number below the number of records the ranker gates", async () => {
    let disclosing = 0;
    for (const c of census) {
      const lede = ledeOf(await page(`/category/${c.slug}`));
      const disclosed = disclosedCountIn(lede, c.total);
      assert.ok(
        disclosed >= c.gated,
        `/category/${c.slug} names ${disclosed} of ${c.gated} gated records: ${lede}`,
      );
      if (c.gated > 0) {
        assert.strictEqual(disclosed, c.gated, `/category/${c.slug} names ${disclosed}, gate replay says ${c.gated}`);
        disclosing++;
      }
    }
    assert.strictEqual(disclosing, census.filter((c) => c.gated > 0).length);
    assert.ok(disclosing > 20, `only ${disclosing} categories disclose a gated count`);
  });

  it("keeps the eligibility wording on every category holding an eligibility record", async () => {
    let carrying = 0;
    for (const c of census) {
      const restricted = c.codes.filter((code) => code === "eligibility_restricted").length;
      const lede = ledeOf(await page(`/category/${c.slug}`));
      if (restricted === 0) {
        assert.ok(
          !lede.includes("application or qualification"),
          `/category/${c.slug} states a restriction no record holds: ${lede}`,
        );
        continue;
      }
      carrying++;
      const clause = restricted === c.total
        ? ALL_GATED_ELIGIBILITY_LEDE
        : CLAUSE_FORMS.eligibility_restricted(restricted);
      assert.ok(lede.includes(clause), `/category/${c.slug} drops the eligibility clause: ${lede}`);
    }
    assert.ok(carrying >= 13, `only ${carrying} categories carry the eligibility clause`);
  });

  it("leaves the entirely gated pages on the wording they already publish", async () => {
    const entirely = census.filter((c) => c.gated === c.total && c.total > 1);
    assert.ok(entirely.length > 0, "no category is entirely gated");
    for (const c of entirely) {
      const lede = ledeOf(await page(`/category/${c.slug}`));
      assert.ok(lede.includes(ALL_GATED_ELIGIBILITY_LEDE), `/category/${c.slug} lede is ${lede}`);
      assert.ok(
        !lede.startsWith(`${c.total} verified free tiers and developer deals.`),
        `/category/${c.slug} closes the count claim before qualifying it: ${lede}`,
      );
    }
  });

  it("carries the widened clause list into the search snippet", async () => {
    for (const c of census) {
      const description = descriptionOf(await page(`/category/${c.slug}`));
      if (c.gated === 0) {
        assert.ok(
          !/application or qualification|not a free offer|are not free offers|has expired|have expired|has ended|have ended/.test(description),
          `/category/${c.slug} description states a gate no record holds: ${description}`,
        );
        continue;
      }
      const clause = c.codes.length >= c.total && c.codes.every((code) => code === "eligibility_restricted")
        ? `All ${c.total} require an application or qualification.`
        : `${clausesFor(c.codes)}.`;
      assert.ok(description.includes(clause), `/category/${c.slug} description is ${description}`);
      assert.ok(
        description.indexOf(clause) < description.indexOf("Verified pricing for"),
        `/category/${c.slug} appends the clause after the vendor list, where a snippet truncates it`,
      );
    }
  });
});

describe("the record a category page puts forward is one the ranker lists", () => {
  before(async () => { proc = proc ?? await startServer(); });
  after(() => { proc?.kill(); });

  it("names no record the ranker gates", async () => {
    let named = 0;
    for (const c of census) {
      const leader = leaderNamedIn(introOf(await page(`/category/${c.slug}`)));
      if (leader === null) continue;
      named++;
      const held = c.records.filter((o) => o.vendor === leader);
      assert.ok(held.length > 0, `/category/${c.slug} names ${leader}, which holds no record in the category`);
      for (const record of held) {
        const gate = gateFor(record, TODAY);
        assert.strictEqual(
          gate,
          null,
          `/category/${c.slug} names ${leader} (${record.tier}) — ${gate?.code}: ${gate?.reason}`,
        );
      }
    }
    assert.ok(named > 50, `only ${named} categories put a record forward`);
  });

  it("omits the claim exactly where every record is gated", async () => {
    for (const c of census) {
      const leader = leaderNamedIn(introOf(await page(`/category/${c.slug}`)));
      if (c.gated === c.total) {
        assert.strictEqual(leader, null, `/category/${c.slug} names ${leader} with every record gated`);
      } else {
        assert.notStrictEqual(leader, null, `/category/${c.slug} names no record with ${c.total - c.gated} ungated`);
      }
    }
    assert.ok(census.some((c) => c.gated === c.total), "no category is entirely gated");
  });

  it("answers the best-service question with the same record", async () => {
    let claiming = 0;
    for (const c of census) {
      const html = await page(`/category/${c.slug}`);
      const answer = renderedFaqAnswer(html, `What is the best free ${c.name.toLowerCase()} service?`);
      assert.ok(answer, `/category/${c.slug} stopped answering the best-service question`);
      const claimed = bestServiceClaimIn(answer);
      const leader = leaderNamedIn(introOf(html));
      assert.strictEqual(claimed, leader, `/category/${c.slug} answers about ${claimed} and leads with ${leader}`);
      if (claimed === null) continue;
      claiming++;
      for (const record of c.records.filter((o) => o.vendor === claimed)) {
        const gate = gateFor(record, TODAY);
        assert.strictEqual(gate, null, `/category/${c.slug} answers with ${claimed} (${record.tier}) — ${gate?.code}`);
      }
    }
    assert.ok(claiming > 50, `only ${claiming} categories answer with a record`);
  });

  it("closes the answer cleanly on a category that has no record to put forward", async () => {
    const entirely = census.filter((c) => c.gated === c.total);
    assert.ok(entirely.length > 0, "no category is entirely gated");
    for (const c of entirely) {
      const html = await page(`/category/${c.slug}`);
      const answer = renderedFaqAnswer(html, `What is the best free ${c.name.toLowerCase()} service?`);
      assert.ok(answer, `/category/${c.slug} stopped answering the best-service question`);
      assert.ok(!answer.includes("  "), `/category/${c.slug} answer holds a gap where the claim was: ${answer}`);
      assert.ok(!/ offers .+? on their .+? plan\./.test(answer), `/category/${c.slug} answer is ${answer}`);
      assert.ok(!introOf(html).includes("  "), `/category/${c.slug} intro holds a gap where the claim was`);
    }
  });

  it("still puts a record forward on a category whose first record is gated", async () => {
    const displaced = census.filter((c) => c.gates[0] !== null && c.gated < c.total);
    assert.ok(displaced.length > 0, "no category leads with a gated record in the data");
    for (const c of displaced) {
      const leader = leaderNamedIn(introOf(await page(`/category/${c.slug}`)));
      assert.notStrictEqual(leader, null, `/category/${c.slug} drops the claim rather than moving it`);
      assert.notStrictEqual(leader, c.records[0].vendor, `/category/${c.slug} still names ${leader}`);
    }
  });
});
