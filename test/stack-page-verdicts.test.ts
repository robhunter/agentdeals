import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  costHeadlineCaveat,
  limitCellText,
  limitsPublishedOn,
  mayRecommendAsFree,
  NO_CURRENT_FIGURE,
  overconfidentPicks,
  proseWithoutNames,
  slotsMissingAVerdict,
  stackFreshnessStatement,
  unreadablePicks,
  verdictConfidence,
  verdictsPublishedOn,
  type PublishedPick,
} from "../dist/stack-claim.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(__dirname, "..");

const STACK_PAGES = [
  "/free-ai-stack",
  "/free-devops-stack",
  "/free-django-stack",
  "/free-fastapi-stack",
  "/free-frontend-stack",
  "/free-go-stack",
  "/free-nextjs-stack",
  "/free-saas-stack",
  "/free-startup-stack",
  "/agent-stack",
  "/stacks/ai-startup",
  "/stacks/api-first",
  "/stacks/open-source",
  "/stacks/saas-mvp",
  "/stacks/side-project",
];

let proc: ChildProcess | null = null;
let port = 0;

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

async function get(route: string): Promise<string> {
  const res = await fetch(`http://localhost:${port}${route}`);
  assert.strictEqual(res.status, 200, `${route} returned ${res.status}`);
  return res.text();
}

const badges = new Map<string, string>();

async function badgeVerdict(slug: string): Promise<string> {
  const held = badges.get(slug);
  if (held !== undefined) return held;
  const svg = await get(`/badge/${slug}.svg`);
  const texts = [...svg.matchAll(/<text[^>]*>(.*?)<\/text>/gs)].map(m => m[1].replace(/<[^>]+>/g, "").trim());
  const verdict = texts.length > 0 ? texts[texts.length - 1] : "";
  badges.set(slug, verdict);
  return verdict;
}

interface StoredOffer {
  description: string;
  terms_superseded: { reading: { terms: string } | null } | null;
}

const records = new Map<string, StoredOffer | null>();

async function offerRecord(slug: string): Promise<StoredOffer | null> {
  const held = records.get(slug);
  if (held !== undefined) return held;
  const res = await fetch(`http://localhost:${port}/api/details/${slug}`);
  const offer = res.status === 200 ? ((await res.json()) as { offer?: StoredOffer }).offer ?? null : null;
  records.set(slug, offer);
  return offer;
}

const pages = new Map<string, string>();

before(async () => {
  const started = await startHttpServer();
  proc = started.child;
  port = started.port;
  for (const route of STACK_PAGES) pages.set(route, await get(route));
});

after(() => { proc?.kill(); });

describe("stack pages do not out-claim the badge", () => {
  it("publishes a verdict for every vendor a recommendation slot links", () => {
    const missing: string[] = [];
    for (const route of STACK_PAGES) {
      for (const slug of slotsMissingAVerdict(pages.get(route)!)) missing.push(`${route} ${slug}`);
    }
    assert.deepStrictEqual(missing, [], `recommendation slots stating no verdict:\n${missing.join("\n")}`);
  });

  it("states no verdict stronger than the one the badge publishes", async () => {
    const over: string[] = [];
    const unparsed: string[] = [];
    let compared = 0;
    for (const route of STACK_PAGES) {
      const picks: PublishedPick[] = [];
      for (const { slug, verdict } of verdictsPublishedOn(pages.get(route)!)) {
        picks.push({ vendor: slug, badgeVerdict: await badgeVerdict(slug), pageVerdict: verdict });
      }
      compared += picks.length;
      for (const p of overconfidentPicks(picks)) {
        over.push(`${route} ${p.vendor}: page "${p.pageVerdict}" over badge "${p.badgeVerdict}"`);
      }
      for (const p of unreadablePicks(picks)) {
        unparsed.push(`${route} ${p.vendor}: unreadable ${p.side} verdict "${p.side === "badge" ? p.badgeVerdict : p.pageVerdict}"`);
      }
    }
    assert.ok(compared >= 400, `only ${compared} published verdicts compared across ${STACK_PAGES.length} pages`);
    assert.deepStrictEqual(unparsed, [], `verdicts neither side could be ranked from:\n${unparsed.join("\n")}`);
    assert.deepStrictEqual(over, [], `pages stating a stronger verdict than the badge:\n${over.join("\n")}`);
  });

  it("recommends no vendor whose badge says the free tier has ended", async () => {
    const recommended: string[] = [];
    for (const route of STACK_PAGES) {
      const html = pages.get(route)!;
      for (const { slug, verdict } of verdictsPublishedOn(html)) {
        if (verdictConfidence(verdict) !== 0) continue;
        const inChip = new RegExp(`href="/vendor/${slug}"[^>]*class="[^"]*alt-chip`).test(html);
        const badged = new RegExp(`<span class="pick-badge">Recommended</span>\\s*<a href="/vendor/${slug}"`).test(html);
        if (inChip || badged) recommended.push(`${route} ${slug}: ${await badgeVerdict(slug)}`);
      }
    }
    assert.deepStrictEqual(recommended, [], `ended offers still recommended:\n${recommended.join("\n")}`);
  });

  it("states no hard-coded freshness month", () => {
    const hardcoded: string[] = [];
    for (const route of STACK_PAGES) {
      const found = pages.get(route)!.match(/(?:verified|updated)[^.<]{0,60}?(January|February|March|April|May|June|July|August|September|October|November|December)\s+20\d\d/gi);
      if (found) hardcoded.push(`${route}: ${[...new Set(found)].join(" | ")}`);
    }
    assert.deepStrictEqual(hardcoded, [], `hard-coded freshness claims:\n${hardcoded.join("\n")}`);
  });

  it("dates its freshness statement from the picks it recommends", () => {
    const undated: string[] = [];
    for (const route of STACK_PAGES) {
      if (!/read from vendor pricing pages (on|between) \d{4}-\d{2}-\d{2}/.test(pages.get(route)!)) undated.push(route);
    }
    assert.deepStrictEqual(undated, [], `pages with no derived freshness statement:\n${undated.join("\n")}`);
  });

  it("keeps the withholding notice out of the limit column", () => {
    const misplaced: string[] = [];
    for (const route of STACK_PAGES) {
      const html = pages.get(route)!;
      for (const cell of html.match(/<td[^>]*color:var\(--accent\)[^>]*>([^<]*)</g) ?? []) {
        if (/terms are superseded and withheld|names them as the previous ones/.test(cell)) misplaced.push(`${route}: ${cell}`);
      }
      for (const cell of html.match(/class="(pick-limits|limits-cell)"[^>]*>([^<]*)</g) ?? []) {
        if (/terms are superseded and withheld|names them as the previous ones/.test(cell)) misplaced.push(`${route}: ${cell}`);
      }
    }
    assert.deepStrictEqual(misplaced, [], `withholding notices in a limit slot:\n${misplaced.join("\n")}`);
  });

  it("states a limit our own record still stands behind", async () => {
    const wrong: string[] = [];
    let checked = 0;
    for (const route of STACK_PAGES) {
      for (const { slug, limit } of limitsPublishedOn(pages.get(route)!)) {
        const offer = await offerRecord(slug);
        if (!offer) continue;
        const superseded = offer.terms_superseded;
        const source = superseded ? (superseded.reading?.terms ?? null) : offer.description;
        checked += 1;
        if (source === null) {
          if (limit !== NO_CURRENT_FIGURE) wrong.push(`${route} ${slug}: states "${limit}" where our record holds no readable figure`);
          continue;
        }
        const whole = source.replace(/\s+/g, " ").trim();
        if (limit === whole) continue;
        if (!limit.endsWith("\u2026")) {
          wrong.push(`${route} ${slug}: states "${limit}" as a finished claim, but our record reads "${whole.slice(0, 90)}"`);
          continue;
        }
        if (!whole.startsWith(limit.slice(0, -1))) {
          wrong.push(`${route} ${slug}: states "${limit}", which does not open our record "${whole.slice(0, 90)}"`);
        }
      }
    }
    assert.ok(checked >= 100, `only ${checked} limit slots checked against a record`);
    assert.deepStrictEqual(wrong, [], `limit slots our record does not support:\n${wrong.join("\n")}`);
  });

  it("cites the reading behind a limit our stored terms no longer supply", async () => {
    const uncited: string[] = [];
    let cited = 0;
    for (const route of STACK_PAGES) {
      const html = pages.get(route)!;
      let fromAReading = 0;
      for (const { slug } of limitsPublishedOn(html)) {
        const offer = await offerRecord(slug);
        if (offer?.terms_superseded?.reading) fromAReading += 1;
      }
      const citations = (html.match(/class="stack-limit-source"/g) ?? []).length;
      cited += citations;
      if (citations !== fromAReading) uncited.push(`${route}: ${fromAReading} limits read from a change record, ${citations} of them cited`);
    }
    assert.ok(cited > 0, "no limit on any stack page is served from a change record, so nothing was checked");
    assert.deepStrictEqual(uncited, [], `limits published without the reading behind them:\n${uncited.join("\n")}`);
  });

  it("keeps a dropped pick out of the prose that recommended it", () => {
    const offending: string[] = [];
    for (const route of STACK_PAGES) {
      const html = pages.get(route)!;
      const dropped = [...html.matchAll(/class="alt-ended"[^>]*>No longer a free-tier pick: ([\s\S]*?)<\/p>/g)]
        .flatMap(m => [...m[1].matchAll(/<a href="\/vendor\/[a-z0-9-]+">([^<]+)<\/a>/g)].map(a => a[1]));
      if (dropped.length === 0) continue;
      for (const box of html.match(/<div class="(?:outgrow-box|whynot-box)">[\s\S]*?<\/div>/g) ?? []) {
        for (const name of dropped) if (box.includes(name)) offending.push(`${route}: ${name}`);
      }
    }
    assert.deepStrictEqual(offending, [], `prose still selling a dropped pick:\n${offending.join("\n")}`);
  });

  it("qualifies a $0 headline it cannot stand behind", async () => {
    const unqualified: string[] = [];
    for (const route of STACK_PAGES) {
      const html = pages.get(route)!;
      if (!/\$0<span[^>]*>\/month|tier-amount cost-free">\$0\/mo|Total: <strong>\$0\/month/.test(html)) continue;
      const weak: string[] = [];
      for (const { slug, verdict } of verdictsPublishedOn(html)) {
        if (verdictConfidence(verdict) !== 3) weak.push(slug);
      }
      if (weak.length > 0 && !html.includes("class=\"cost-caveat\"")) unqualified.push(`${route}: ${[...new Set(weak)].join(", ")}`);
    }
    assert.deepStrictEqual(unqualified, [], `unqualified $0 headlines:\n${unqualified.join("\n")}`);
  });
});

describe("the verdict comparison itself", () => {
  it("fails a recommendation whose badge reads free tier removed", () => {
    const over = overconfidentPicks([
      { vendor: "logrocket", badgeVerdict: "free tier removed · Aug 2026", pageVerdict: "Free Forever" },
    ]);
    assert.strictEqual(over.length, 1);
    assert.strictEqual(over[0].badgeConfidence, 0);
    assert.strictEqual(over[0].pageConfidence, 3);
  });

  it("passes a recommendation that repeats the badge", () => {
    assert.deepStrictEqual(overconfidentPicks([
      { vendor: "railway", badgeVerdict: "at risk · Aug 2026", pageVerdict: "at risk" },
      { vendor: "neon", badgeVerdict: "active · Sep 2026", pageVerdict: "active" },
      { vendor: "stripe", badgeVerdict: "unrated — not a free offer", pageVerdict: "unrated — not a free offer" },
    ]), []);
  });

  it("reports a verdict neither side can be ranked from", () => {
    const unreadable = unreadablePicks([
      { vendor: "neon", badgeVerdict: "active", pageVerdict: "active" },
      { vendor: "turso", badgeVerdict: "active", pageVerdict: "5 GB" },
      { vendor: "orama", badgeVerdict: "???", pageVerdict: "active" },
    ]);
    assert.deepStrictEqual(unreadable.map(u => [u.vendor, u.side]), [["turso", "page"], ["orama", "badge"]]);
  });

  it("passes a page more cautious than the badge", () => {
    assert.deepStrictEqual(overconfidentPicks([
      { vendor: "neon", badgeVerdict: "active · Sep 2026", pageVerdict: "at risk" },
    ]), []);
  });

  it("ranks the vocabulary both surfaces publish", () => {
    assert.strictEqual(verdictConfidence("active · Sep 2026"), 3);
    assert.strictEqual(verdictConfidence("Stable"), 3);
    assert.strictEqual(verdictConfidence("at risk · Aug 2026"), 2);
    assert.strictEqual(verdictConfidence("Watch"), 2);
    assert.strictEqual(verdictConfidence("unrated — page unreadable"), 1);
    assert.strictEqual(verdictConfidence("Volatile"), 1);
    assert.strictEqual(verdictConfidence("free tier removed · Aug 2026"), 0);
    assert.strictEqual(verdictConfidence("retired"), 0);
    assert.strictEqual(verdictConfidence(""), null);
  });

  it("reads a verdict as belonging to the vendor last linked before it", () => {
    const html =
      `<a href="/vendor/vercel" class="alt-chip">Vercel <span class="stack-verdict">active</span></a>` +
      `<a href="/vendor/railway" class="alt-chip">Railway <span class="stack-verdict">at risk</span></a>`;
    assert.deepStrictEqual(verdictsPublishedOn(html), [
      { slug: "vercel", verdict: "active" },
      { slug: "railway", verdict: "at risk" },
    ]);
  });

  it("reads the older stability cell as a verdict too", () => {
    const html = `<td><a href="/vendor/github-actions">GitHub Actions</a></td><td><span class="stability-dot" style="background:#3fb950" title="Stable"></span> Stable</td>`;
    assert.deepStrictEqual(verdictsPublishedOn(html), [{ slug: "github-actions", verdict: "Stable" }]);
  });

  it("names a recommendation slot that states no verdict", () => {
    const row = `<tr><td><a href="/vendor/turso">Turso</a></td><td>5 GB</td></tr>`;
    assert.deepStrictEqual(slotsMissingAVerdict(row), ["turso"]);
    assert.deepStrictEqual(slotsMissingAVerdict(row.replace("5 GB", `<span class="stack-verdict">active</span>`)), []);
  });

  it("refuses to recommend a removed or retired offer as free", () => {
    assert.strictEqual(mayRecommendAsFree("removed"), false);
    assert.strictEqual(mayRecommendAsFree("retired"), false);
    assert.strictEqual(mayRecommendAsFree("at-risk"), true);
    assert.strictEqual(mayRecommendAsFree("withheld"), true);
  });
});

describe("prose that names a pick we have dropped", () => {
  it("drops the sentence rather than the whole paragraph", () => {
    const prose = "Highlight.io offers 500 sessions bundled. LogRocket gives 1K sessions/month. Sentry is the default.";
    assert.strictEqual(
      proseWithoutNames(prose, ["LogRocket"]),
      "Highlight.io offers 500 sessions bundled. Sentry is the default.",
    );
  });

  it("leaves prose naming nothing we dropped alone", () => {
    const prose = "Highlight.io offers 500 sessions bundled. Sentry is the default.";
    assert.strictEqual(proseWithoutNames(prose, []), prose);
    assert.strictEqual(proseWithoutNames(prose, ["LogRocket"]), prose);
  });
});

describe("the derived freshness statement", () => {
  it("spans the oldest and newest reading", () => {
    assert.strictEqual(
      stackFreshnessStatement(["2026-09-04", "2026-07-24", "2026-08-11"]),
      "The limits on this page were read from vendor pricing pages between 2026-07-24 and 2026-09-04.",
    );
  });

  it("states one date when every reading shares it", () => {
    assert.strictEqual(
      stackFreshnessStatement(["2026-09-04", "2026-09-04"]),
      "The limits on this page were read from vendor pricing pages on 2026-09-04.",
    );
  });

  it("says nothing when it holds no reading", () => {
    assert.strictEqual(stackFreshnessStatement([]), "");
    assert.strictEqual(stackFreshnessStatement(["not a date"]), "");
  });
});

describe("the $0 caveat", () => {
  it("names every pick the headline does not cover", () => {
    assert.strictEqual(
      costHeadlineCaveat([
        { vendor: "Neon", verdict: "active", readsActive: true },
        { vendor: "Railway", verdict: "at risk", readsActive: false },
        { vendor: "Stripe", verdict: "unrated — not a free offer", readsActive: false },
      ]),
      "$0 covers the 1 of 3 picks whose free tier our own badge still reads as active. " +
      "It does not cover Railway (at risk), Stripe (unrated — not a free offer).",
    );
  });

  it("says nothing when every pick reads active", () => {
    assert.strictEqual(costHeadlineCaveat([{ vendor: "Neon", verdict: "active", readsActive: true }]), "");
  });
});

describe("the limit cell", () => {
  it("never truncates into a sentence that reads complete", () => {
    const railway = "Free $0 per month. Start with a 30-day free trial with $5 credits, then $1 per month.";
    const cell = limitCellText(railway, 60);
    assert.ok(cell.endsWith("…"), `truncated cell reads as a finished claim: ${cell}`);
    assert.ok(!/^Free \$0 per month\.$/.test(cell));
  });

  it("passes terms through whole when they fit", () => {
    assert.strictEqual(limitCellText("10 GB storage, zero egress", 60), "10 GB storage, zero egress");
  });
});
