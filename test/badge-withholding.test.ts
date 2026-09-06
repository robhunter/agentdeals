import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(__dirname, "..");

let serverPort = 0;
let proc: ChildProcess | null = null;

function startHttpServer(): Promise<{ child: ChildProcess; port: number }> {
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
    child.on("error", (err) => { clearTimeout(timeout); reject(err); });
  });
}

const get = async (p: string) => {
  const res = await fetch(`http://localhost:${serverPort}${p}`);
  return { status: res.status, text: await res.text() };
};

const WITHHELD_LABELS: Record<string, string> = {
  no_source: "unrated — no source",
  link_unreachable: "unrated — page unreachable",
  unreadable: "unrated — page unreadable",
  states_no_terms: "unrated — page states no terms",
  does_not_name_vendor: "unrated — page omits vendor",
  eligibility_restricted: "unrated — restricted offer",
  not_a_free_offer: "unrated — not a free offer",
  offer_expired: "unrated — offer expired",
  offer_retired: "unrated — offer ended",
  verification_lapsed: "unrated — not re-confirmed",
};

const WITHHELD_LABEL_SET = new Set(Object.values(WITHHELD_LABELS));

type Withholding = { reason: string; gate?: string };

interface Subject {
  slug: string;
  vendor: string;
  kind: "rating" | "ended" | "none";
  word?: string;
  because?: Withholding;
  reasonKey: string | null;
  verifiedDate: string;
  ageDays: number;
  levelWithheld: string | null;
}

let subjects: Subject[] = [];
let staleAfter = 0;

function badgeTitle(svg: string): string {
  return svg.match(/<title>([\s\S]*?)<\/title>/)?.[1] ?? "";
}

function badgeAriaLabel(svg: string): string {
  return svg.match(/<svg[^>]*aria-label="([^"]*)"/)?.[1] ?? "";
}

function badgeLabel(svg: string): string {
  const right = badgeTitle(svg).split(": ").slice(1).join(": ");
  return right.split(" · ")[0].trim();
}

function badgeColor(svg: string): string {
  const rects = [...svg.matchAll(/<rect[^>]*fill="(#[0-9a-fA-F]{6})"/g)].map(m => m[1]);
  return rects.find(c => c !== "#555") ?? "";
}

before(async () => {
  const { loadOffers, loadDealChanges, enrichOffers } = await import("../dist/data.js");
  const { vendorSlugMap } = await import("../dist/vendor-slug.js");
  const { levelWithheldReason } = await import("../dist/source-check.js");
  const { vendorBadge } = await import("../dist/vendor-verdict.js");
  const { offerEnded } = await import("../dist/retirement.js");
  const { gateFor, utcDate } = await import("../dist/ranking.js");
  const { reverificationIntervalDays, verificationAgeDays } = await import("../dist/badge-staleness.js");

  const offers = loadOffers();
  const changes = loadDealChanges();
  const enriched = enrichOffers(offers);
  const enrichedOf = new Map<object, Record<string, never>>();
  offers.forEach((o: object, i: number) => enrichedOf.set(o, enriched[i]));
  const servedOn = utcDate();
  const nowMs = Date.now();
  staleAfter = reverificationIntervalDays(offers.map((o: { verifiedDate: string }) => o.verifiedDate), nowMs);

  subjects = [...vendorSlugMap.entries()].flatMap(([slug, vendor]: [string, string]) => {
    const own = offers.filter((o: { vendor: string }) => o.vendor === vendor);
    if (own.length === 0) return [];
    const primary = own[0];
    const e = enrichedOf.get(primary) as unknown as {
      risk_level: string | null; risk_cause: never; rating_withheld: never; link_unreachable: unknown;
    };
    const levelWithheld = levelWithheldReason(primary, e.link_unreachable);
    const badge = vendorBadge({
      vendor,
      level: e.risk_level as never,
      cause: e.risk_cause,
      changes: changes.filter((c: { vendor: string }) => c.vendor.toLowerCase() === vendor.toLowerCase()),
      levelWithheld,
      unconfirmableSince: "",
      ratingWithheld: e.rating_withheld,
      offerEnded: offerEnded(primary),
      gate: gateFor(primary, servedOn)?.code ?? null,
      linkUnreachable: Boolean(e.link_unreachable),
    }) as { kind: "rating" | "ended" | "none"; word?: string; because?: Withholding };
    const verifiedDate = own.reduce(
      (max: string, o: { verifiedDate: string }) => (o.verifiedDate > max ? o.verifiedDate : max),
      primary.verifiedDate,
    );
    const because = badge.because;
    return [{
      slug,
      vendor,
      kind: badge.kind,
      word: badge.word,
      because,
      reasonKey: because ? (because.reason === "gated" ? because.gate! : because.reason) : null,
      verifiedDate,
      ageDays: verificationAgeDays(verifiedDate, nowMs),
      levelWithheld,
    }];
  });

  assert.ok(subjects.length > 1000, "the catalogue did not load");
  const started = await startHttpServer();
  proc = started.child;
  serverPort = started.port;
});

after(() => { if (proc) proc.kill(); });

let renderedBadges: Map<string, string> | null = null;

async function everyBadge(): Promise<Map<string, string>> {
  if (renderedBadges) return renderedBadges;
  const svgs = new Map<string, string>();
  let queue = 0;
  const worker = async () => {
    while (queue < subjects.length) {
      const { slug } = subjects[queue++];
      const res = await fetch(`http://localhost:${serverPort}/badge/${slug}.svg`);
      assert.strictEqual(res.status, 200, `/badge/${slug}.svg returned ${res.status}`);
      svgs.set(slug, await res.text());
    }
  };
  await Promise.all(Array.from({ length: 12 }, worker));
  renderedBadges = svgs;
  return svgs;
}

describe("#1389 the badge withholds wherever the vendor page withholds", () => {
  it("publishes a verdict on exactly the vendors the page publishes one for", async () => {
    const svgs = await everyBadge();
    const publishesWhereThePageWillNot: string[] = [];
    const withholdsWhereThePagePublishes: string[] = [];

    for (const subject of subjects) {
      const label = badgeLabel(svgs.get(subject.slug)!);
      const badgeWithholds = WITHHELD_LABEL_SET.has(label);
      const pageWithholds = subject.kind === "none";
      if (pageWithholds && !badgeWithholds) {
        publishesWhereThePageWillNot.push(`/badge/${subject.slug}.svg reads "${label}" and /vendor/${subject.slug} publishes no level (${subject.reasonKey})`);
      }
      if (!pageWithholds && badgeWithholds) {
        withholdsWhereThePagePublishes.push(`/badge/${subject.slug}.svg reads "${label}" and /vendor/${subject.slug} publishes ${subject.word ?? subject.kind}`);
      }
    }

    assert.deepStrictEqual(publishesWhereThePageWillNot.slice(0, 15), [], publishesWhereThePageWillNot.slice(0, 15).join("\n"));
    assert.deepStrictEqual(withholdsWhereThePagePublishes.slice(0, 15), [], withholdsWhereThePagePublishes.slice(0, 15).join("\n"));
  });

  it("withholds on every reason the vendor page can withhold for, so no branch is untested", () => {
    const withheld = subjects.filter(s => s.kind === "none");
    assert.ok(withheld.length > 0, "no vendor page withholds, so this asserts nothing");
    const reasons = new Set(withheld.map(s => s.reasonKey));
    for (const reason of reasons) {
      assert.ok(reason && reason in WITHHELD_LABELS, `the badge has no label for a page that withholds because of ${reason}`);
    }
    assert.ok(reasons.size >= 4, `only ${reasons.size} withholding reasons occur in the catalogue`);
  });

  it("agrees with the rendered vendor page, sampled across every withholding reason", async () => {
    const { withheldLevelClause, withheldLevelSentence } = await import("../dist/source-check.js");
    const statesTheReason = (html: string, reason: string, vendor: string): boolean =>
      html.includes(withheldLevelClause(reason as never))
      || html.includes(withheldLevelSentence(reason as never, vendor).replace(/\.$/, ""));
    const byReason = new Map<string, Subject[]>();
    for (const s of subjects.filter(x => x.kind === "none")) {
      if (!byReason.has(s.reasonKey!)) byReason.set(s.reasonKey!, []);
      byReason.get(s.reasonKey!)!.push(s);
    }
    const wrong: string[] = [];
    for (const [reason, group] of byReason) {
      for (const subject of group.slice(0, 3)) {
        const { status, text } = await get(`/vendor/${subject.slug}`);
        if (status !== 200) { wrong.push(`/vendor/${subject.slug} returned ${status}`); continue; }
        const h1 = text.match(/<h1>[\s\S]*?<\/h1>/)?.[0] ?? "";
        if (/risk-badge/.test(h1)) {
          wrong.push(`/vendor/${subject.slug} carries a risk badge in its <h1> and /badge/${subject.slug}.svg withholds for ${reason}`);
        }
        if (subject.levelWithheld && !statesTheReason(text, subject.levelWithheld, subject.vendor)) {
          wrong.push(`/vendor/${subject.slug} never states the ${subject.levelWithheld} reason the badge names`);
        }
      }
    }
    assert.ok(byReason.size >= 4, "fewer than four withholding reasons to sample");
    assert.deepStrictEqual(wrong, [], wrong.join("\n"));
  });

  it("carries a risk badge on the pages whose badge publishes a verdict", async () => {
    const publishing = subjects.filter(s => s.kind === "rating");
    assert.ok(publishing.length > 100, "almost nothing publishes, so this asserts nothing");
    const sample = ["stable", "caution", "risky"].flatMap(word => publishing.filter(s => s.word === word).slice(0, 3));
    assert.strictEqual(new Set(sample.map(s => s.word)).size, 3, "the sample does not cover all three levels");
    const missing: string[] = [];
    for (const subject of sample) {
      const { text } = await get(`/vendor/${subject.slug}`);
      const h1 = text.match(/<h1>[\s\S]*?<\/h1>/)?.[0] ?? "";
      if (!/risk-badge/.test(h1)) missing.push(`/vendor/${subject.slug} publishes no badge and /badge/${subject.slug}.svg reads ${subject.word}`);
    }
    assert.deepStrictEqual(missing, [], missing.join("\n"));
  });
});

describe("#1389 a withheld badge says which reason applies", () => {
  it("names the reason in the title and in the aria-label, on every withheld badge", async () => {
    const svgs = await everyBadge();
    const wrong: string[] = [];
    let checked = 0;
    for (const subject of subjects.filter(s => s.kind === "none")) {
      const svg = svgs.get(subject.slug)!;
      const expected = WITHHELD_LABELS[subject.reasonKey!];
      const label = badgeLabel(svg);
      checked++;
      if (label !== expected) {
        wrong.push(`/badge/${subject.slug}.svg reads "${label}", withheld for ${subject.reasonKey}`);
        continue;
      }
      if (badgeAriaLabel(svg) !== badgeTitle(svg)) {
        wrong.push(`/badge/${subject.slug}.svg gives a screen reader something other than its title`);
      }
    }
    assert.ok(checked > 0, "no badge withholds, so this asserts nothing");
    assert.deepStrictEqual(wrong.slice(0, 15), [], wrong.slice(0, 15).join("\n"));
  });

  it("does not say 'no source' about a page we could not reach or could not read", async () => {
    const svgs = await everyBadge();
    const misnamed = subjects
      .filter(s => s.kind === "none" && s.reasonKey !== "no_source")
      .filter(s => badgeLabel(svgs.get(s.slug)!) === WITHHELD_LABELS.no_source)
      .map(s => `/badge/${s.slug}.svg blames a missing source for ${s.reasonKey}`);
    assert.deepStrictEqual(misnamed.slice(0, 10), [], misnamed.slice(0, 10).join("\n"));
  });
});

describe("#1389 a state about us does not wear the vendor's warning colour", () => {
  const ABOUT_THE_VENDOR = new Set(["at risk", "free tier removed", "deprecated", "retired"]);
  const ABOUT_US = new Set([...WITHHELD_LABEL_SET, "stale"]);

  it("gives no colour to both a statement about the vendor and a statement about us", async () => {
    const svgs = await everyBadge();
    const vendorColours = new Set<string>();
    const ourColours = new Set<string>();
    for (const [, svg] of svgs) {
      const label = badgeLabel(svg);
      if (ABOUT_THE_VENDOR.has(label)) vendorColours.add(badgeColor(svg));
      if (ABOUT_US.has(label)) ourColours.add(badgeColor(svg));
    }
    assert.ok(vendorColours.size > 0 && ourColours.size > 0, "one of the two populations is empty");
    const shared = [...vendorColours].filter(c => ourColours.has(c));
    assert.deepStrictEqual(shared, [], `${shared.join(", ")} is published both for a vendor's risk and for our own queue`);
  });

  it("distinguishes a stale reading from an at-risk vendor without reading the label", async () => {
    const stale = subjects.find(s => s.kind === "rating" && s.word === "stable" && s.ageDays > staleAfter);
    const atRisk = subjects.find(s => s.kind === "rating" && s.word === "caution");
    assert.ok(atRisk, "no vendor is at risk");
    if (!stale) return;
    const staleSvg = (await get(`/badge/${stale.slug}.svg`)).text;
    const atRiskSvg = (await get(`/badge/${atRisk.slug}.svg`)).text;
    assert.strictEqual(badgeLabel(staleSvg), "stale");
    assert.strictEqual(badgeLabel(atRiskSvg), "at risk");
    assert.notStrictEqual(badgeColor(staleSvg), badgeColor(atRiskSvg));
  });
});

describe("#1389 the staleness threshold comes from the re-verification loop", () => {
  it("recovers the period of a loop that re-reads every page once per interval", async () => {
    const { reverificationIntervalDays } = await import("../dist/badge-staleness.js");
    const nowMs = Date.parse("2026-09-06T00:00:00Z");
    for (const period of [14, 30, 64, 120]) {
      const dates = Array.from({ length: period * 4 }, (_, i) =>
        new Date(nowMs - (i % period) * 86400000).toISOString().slice(0, 10));
      const estimate = reverificationIntervalDays(dates, nowMs);
      assert.ok(
        Math.abs(estimate - period) <= 2,
        `a loop of ${period} days is measured as ${estimate}`,
      );
    }
  });

  it("never returns a threshold of zero days on a catalogue read today", async () => {
    const { reverificationIntervalDays } = await import("../dist/badge-staleness.js");
    const nowMs = Date.parse("2026-09-06T00:00:00Z");
    assert.strictEqual(reverificationIntervalDays([], nowMs), 1);
    assert.strictEqual(reverificationIntervalDays(["2026-09-06", "2026-09-06"], nowMs), 1);
  });

  it("calls a reading stale once it is past the interval, not at it", async () => {
    const { readingIsBehindTheLoop } = await import("../dist/badge-staleness.js");
    const nowMs = Date.parse("2026-09-06T00:00:00Z");
    const dayBefore = (days: number) => new Date(nowMs - days * 86400000).toISOString().slice(0, 10);
    assert.strictEqual(readingIsBehindTheLoop(dayBefore(63), 64, nowMs), false);
    assert.strictEqual(readingIsBehindTheLoop(dayBefore(64), 64, nowMs), false);
    assert.strictEqual(readingIsBehindTheLoop(dayBefore(65), 64, nowMs), true);
  });

  it("holds no fixed staleness threshold in the badge source", () => {
    const src = readFileSync(path.join(REPO, "src", "serve.ts"), "utf8");
    assert.doesNotMatch(
      src,
      /readingIsBehindTheLoop\([^)]*,\s*\d+\s*,/,
      "the badge compares an age against a literal again; the threshold is derived from the catalogue",
    );
  });

  it("reads stale on exactly the vendors whose page is older than that interval", async () => {
    const svgs = await everyBadge();
    const wrong: string[] = [];
    for (const subject of subjects.filter(s => s.kind === "rating" && s.word === "stable")) {
      const label = badgeLabel(svgs.get(subject.slug)!);
      const expected = subject.ageDays > staleAfter ? "stale" : "active";
      if (label !== expected) {
        wrong.push(`/badge/${subject.slug}.svg reads "${label}" at ${subject.ageDays} days against a ${staleAfter}-day interval`);
      }
    }
    assert.deepStrictEqual(wrong.slice(0, 10), [], wrong.slice(0, 10).join("\n"));
  });

  it("leaves the stale state outside the loop rather than inside it", () => {
    const publishing = subjects.filter(s => s.kind === "rating");
    const stale = publishing.filter(s => s.word === "stable" && s.ageDays > staleAfter);
    const share = stale.length / publishing.length;
    assert.ok(
      share <= 0.25,
      `${stale.length} of ${publishing.length} live badges read stale (${(share * 100).toFixed(1)}%) at a ${staleAfter}-day threshold — the threshold is still inside the re-verification loop`,
    );
  });
});

describe("#1389 the stack grade says how much of the stack it could rate", () => {
  it("names the covered share whenever a service in the stack is unrated", async () => {
    const rated = subjects.find(s => s.kind === "rating")!;
    const withheld = subjects.find(s => s.kind === "none")!;
    const mixed = await get(`/badge/stack.svg?v=${rated.slug},${withheld.slug}`);
    assert.match(badgeTitle(mixed.text), /Stack Health: [A-F] · 1 of 2 rated/);

    const whole = await get(`/badge/stack.svg?v=${rated.slug}`);
    assert.match(badgeTitle(whole.text), /Stack Health: [A-F]$/);
  });

  it("still says nothing at all where it could rate none of the stack", async () => {
    const withheld = subjects.filter(s => s.kind === "none").slice(0, 2).map(s => s.slug);
    const { text } = await get(`/badge/stack.svg?v=${withheld.join(",")}`);
    assert.strictEqual(badgeTitle(text), "Stack Health: ?");
  });
});

describe("#1389 /badges counts at risk over vendors we make a claim about", () => {
  it("publishes an at-risk count that no withheld or stale badge is inside", async () => {
    const { text } = await get("/badges");
    const tiles = [...text.matchAll(/<div class="stat-num[^"]*">(\d+)<\/div><div class="stat-label">([^<]+)<\/div>/g)]
      .map(m => [m[2], parseInt(m[1], 10)] as const);
    const counts = new Map(tiles);
    assert.ok(counts.has("At Risk"), "/badges no longer publishes an at-risk count");

    const cautioned = subjects.filter(s => s.kind === "rating" && s.word === "caution").length;
    const withheld = subjects.filter(s => s.kind === "none").length;
    const stale = subjects.filter(s => s.kind === "rating" && s.word === "stable" && s.ageDays > staleAfter).length;

    assert.strictEqual(counts.get("At Risk"), cautioned, "the at-risk tile counts vendors we publish no claim about");
    assert.strictEqual(counts.get("Unrated"), withheld, "the unrated tile does not match the badges that withhold");
    assert.strictEqual(counts.get("Stale"), stale, "the stale tile does not match the badges that read stale");
    assert.strictEqual(counts.get("Vendors"), subjects.length);
  });

  it("adds up to the catalogue, so no vendor is counted twice or dropped", async () => {
    const { text } = await get("/badges");
    const tiles = new Map([...text.matchAll(/<div class="stat-num[^"]*">(\d+)<\/div><div class="stat-label">([^<]+)<\/div>/g)]
      .map(m => [m[2], parseInt(m[1], 10)] as const));
    const total = ["Active", "At Risk", "Ended", "Stale", "Unrated"].reduce((sum, k) => sum + (tiles.get(k) ?? 0), 0);
    assert.strictEqual(total, tiles.get("Vendors"), "the tiles do not partition the catalogue");
  });
});
