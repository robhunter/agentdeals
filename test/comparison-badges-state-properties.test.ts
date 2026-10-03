import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertCoversPopulation, type Population } from "./population-floor.ts";
import { everyRouteTheSitemapPublishes } from "./sitemap-routes.ts";
import { badgedSubjects } from "../src/page-reviews.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(__dirname, "..");

interface PropertyBadge {
  route: string;
  subject: string;
  badge: string;
  source: string;
  says: string;
}

const PROPERTY_BADGES_THE_VENDOR_STATES: PropertyBadge[] = [
  {
    route: "/database-free-tier-comparison-2026", subject: "Supabase", badge: "OPEN SOURCE",
    source: "https://supabase.com/", says: "Open source from day one",
  },
  {
    route: "/monitoring-comparison-2026", subject: "Elastic (ELK)", badge: "OPEN SOURCE",
    source: "https://www.elastic.co/elasticsearch",
    says: "Elasticsearch is an open source, distributed search and analytics engine",
  },
  {
    route: "/storage-comparison-2026", subject: "Cloudflare R2", badge: "ZERO EGRESS",
    source: "https://developers.cloudflare.com/r2/pricing/",
    says: "There are no charges for egress bandwidth for any storage class.",
  },
  {
    route: "/storage-comparison-2026", subject: "Tigris (Fly.io)", badge: "ZERO EGRESS",
    source: "https://www.tigrisdata.com/pricing/", says: "Zero egress fees.",
  },
  {
    route: "/auth-comparison-2026", subject: "WorkOS", badge: "1M FREE",
    source: "https://workos.com/pricing",
    says: "WorkOS User Management is free for up to 1 million monthly active users.",
  },
  {
    route: "/auth-comparison-2026", subject: "Appwrite Auth", badge: "75K FREE",
    source: "https://appwrite.io/pricing", says: "75K monthly active users",
  },
];

const PAGES_THAT_RANKED_BY_BADGE = [
  "/monitoring-comparison-2026", "/email-comparison-2026", "/testing-free-tier-comparison-2026",
  "/api-development-free-tier-comparison-2026", "/storage-comparison-2026", "/analytics-free-tier-comparison-2026",
  "/database-free-tier-comparison-2026", "/serverless-free-tier-comparison-2026", "/cloud-free-tier-comparison-2026",
  "/security-free-tier-comparison-2026",
];

const RANKS_OR_JUDGES = /BEST|MOST|WINNER|LEADER|CHEAPEST|EASIEST|SIMPLEST|LARGEST|GEM|STANDARD|MODERN|MATURE/;

const PICK_BADGE_SPAN = /<span\b[^>]*class="[^"]*\bpick-badge\b[^"]*"[^>]*>[^<]*<\/span>/g;

interface ServedBadge {
  route: string;
  subject: string;
  badge: string;
}

function comparisonBadgesOn(route: string, html: string): ServedBadge[] {
  return badgedSubjects(html.replace(PICK_BADGE_SPAN, "")).map(({ subject, badge }) => ({ route, subject, badge }));
}

const keyOf = (badge: { route: string; subject: string; badge: string }): string =>
  `${badge.route}: "${badge.subject}" carries ${badge.badge}`;

function startServer(): Promise<{ proc: ChildProcess; port: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn("node", [path.join(REPO, "dist", "serve.js")], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, PORT: "0", BASE_URL: "http://localhost", TZ: "UTC" },
    });
    const timeout = setTimeout(() => { child.kill(); reject(new Error("Server startup timeout")); }, 60000);
    child.stderr!.on("data", (data: Buffer) => {
      const m = data.toString().match(/running on http:\/\/localhost:(\d+)/);
      if (m) { clearTimeout(timeout); resolve({ proc: child, port: parseInt(m[1], 10) }); }
    });
    child.on("error", (err) => { clearTimeout(timeout); reject(err); });
  });
}

describe("#2191 a comparison badge states a property the vendor's own page states, and never a rank", () => {
  let server: { proc: ChildProcess; port: number } | null = null;
  let routesPublished: string[] = [];
  const rendered = new Map<string, string>();
  const served: ServedBadge[] = [];

  const routesTheSitemapPublishes = (): Population => ({
    size: routesPublished.length,
    read: "routes the sitemap publishes",
  });

  before(async () => {
    server = await startServer();
    const base = `http://localhost:${server.port}`;
    routesPublished = await everyRouteTheSitemapPublishes(base);
    const queue = [...routesPublished];
    let next = 0;
    await Promise.all(Array.from({ length: 12 }, async () => {
      while (next < queue.length) {
        const route = queue[next++]!;
        const response = await fetch(base + route);
        if (!response.ok) continue;
        const html = await response.text();
        rendered.set(route, html);
        served.push(...comparisonBadgesOn(route, html));
      }
    }));
  });

  after(() => { server?.proc.kill(); });

  it("reads every route the sitemap publishes", () => {
    assertCoversPopulation(rendered.size, routesTheSitemapPublishes(), "routes answered and read for badges");
  });

  it("serves no badge but one listed with its vendor's own wording", () => {
    const listed = new Set(PROPERTY_BADGES_THE_VENDOR_STATES.map(keyOf));
    const unlisted = [...new Set(served.map(keyOf))].filter(key => !listed.has(key));
    assert.deepStrictEqual(unlisted, [], `badges no vendor statement on this list supports:\n${unlisted.join("\n")}`);
  });

  it("serves every badge on the list, so the list cannot outlive the pages", () => {
    const servedKeys = new Set(served.map(keyOf));
    const unserved = PROPERTY_BADGES_THE_VENDOR_STATES.map(keyOf).filter(key => !servedKeys.has(key));
    assert.deepStrictEqual(unserved, [], `listed badges no page serves:\n${unserved.join("\n")}`);
  });

  it("lists no badge that ranks or judges", () => {
    const ranking = PROPERTY_BADGES_THE_VENDOR_STATES.filter(entry => RANKS_OR_JUDGES.test(entry.badge)).map(keyOf);
    assert.deepStrictEqual(ranking, []);
  });

  it("goes red on a ranking badge put back on a comparison row", () => {
    const html = rendered.get("/database-free-tier-comparison-2026")!;
    const restored = html.replace(
      '<a href="/vendor/neon" style="color:var(--text)">Neon</a>',
      '<a href="/vendor/neon" style="color:var(--text)">Neon</a> <span class="winner-badge">BEST POSTGRES</span>',
    );
    assert.notStrictEqual(restored, html, "the Neon row this check restores a badge to is gone from the page");
    const listed = new Set(PROPERTY_BADGES_THE_VENDOR_STATES.map(keyOf));
    const unlisted = comparisonBadgesOn("/database-free-tier-comparison-2026", restored).map(keyOf).filter(key => !listed.has(key));
    assert.deepStrictEqual(unlisted, ['/database-free-tier-comparison-2026: "Neon" carries BEST POSTGRES']);
  });

  it("calls the use-case section By Use Case on the ten pages that ranked by badge", () => {
    for (const route of PAGES_THAT_RANKED_BY_BADGE) {
      const html = rendered.get(route);
      assert.ok(html, `${route} is not served`);
      assert.ok(html.includes('<h2 id="best-for">By Use Case</h2>'), `${route} has no By Use Case heading`);
      assert.ok(html.includes('<a href="#best-for">By Use Case</a>'), `${route} has no By Use Case contents entry`);
      assert.ok(!html.includes("Best for Each Use Case"), `${route} still says Best for Each Use Case`);
    }
  });
});
