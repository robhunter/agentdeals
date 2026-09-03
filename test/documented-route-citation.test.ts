import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEFERENCE } from "../dist/signal-copy.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const CITATION_OPENING = "Source: AgentDeals (http";

const OPERATIONAL_ROUTES = new Map<string, string>([
  ["/api/freshness", "reports on our own index, not on a vendor record"],
  ["/api/query-log", "a request log"],
  ["/api/pageviews", "our own analytics"],
  ["/api/traffic", "our own analytics"],
  ["/api/stats", "our own service counters"],
  ["/api/watchlist", "a caller's own subscriptions"],
  ["/api/watchlist/:id", "one caller's own subscription"],
  ["/api/feed", "an Atom feed, not a JSON body"],
]);

const PROBES = new Map<string, string>([
  ["/api/offers", "/api/offers?limit=3"],
  ["/api/categories", "/api/categories"],
  ["/api/new", "/api/new?days=3"],
  ["/api/newest", "/api/newest?limit=3"],
  ["/api/changes", "/api/changes?limit=2"],
  ["/api/details/:vendor", "/api/details/supabase"],
  ["/api/compare", "/api/compare?a=Supabase&b=Neon"],
  ["/api/audit-stack", "/api/audit-stack?services=Vercel"],
  ["/api/vendor-risk/:vendor", "/api/vendor-risk/supabase"],
  ["/api/deadlines", "/api/deadlines"],
  ["/api/ai-coding-pricing", "/api/ai-coding-pricing"],
  ["/api/hosting-pricing", "/api/hosting-pricing"],
  ["/api/llm-pricing", "/api/llm-pricing"],
  ["/api/startup-credits", "/api/startup-credits"],
  ["/api/referral-programs", "/api/referral-programs"],
  ["/api/expiring", "/api/expiring?days=30"],
  ["/api/digest", "/api/digest"],
  ["/api/digest/weekly", "/api/digest/weekly"],
  ["/api/stack", "/api/stack?use_case=saas"],
  ["/api/costs", "/api/costs?services=Vercel&scale=startup"],
  ["/api/referral-codes", "/api/referral-codes"],
  ["/api/referral-codes/:vendor", "/api/referral-codes/railway"],
]);

const DATED = [
  "/api/deadlines",
  "/api/ai-coding-pricing",
  "/api/hosting-pricing",
  "/api/llm-pricing",
  "/api/startup-credits",
  "/api/referral-programs",
  "/api/digest/weekly",
];

const UNDATED = ["/api/referral-codes", "/api/referral-codes/:vendor"];

const CITE_THE_SITE_ROOT = ["/api/new", "/api/newest", "/api/audit-stack", "/api/stack", "/api/costs"];

const SOURCE_POPULATION_PAGES: [string, string, number][] = [
  ["/api/llm-pricing", "providers", 60],
  ["/api/hosting-pricing", "platforms", 50],
  ["/api/referral-programs", "programs", 15],
  ["/api/deadlines", "deadlines", 0],
];

const ALWAYS_PUBLISHED = ["source", "url", "cite_as", "note"];
const PUBLISHED_WHERE_DATED = ["checked", "verified"];

function documentedProvenanceFields(html: string): string[] {
  const section = html.slice(html.indexOf("<h2>Provenance</h2>"), html.indexOf("<h2>Rate Limits</h2>"));
  return [...section.matchAll(/<tr><td><code>([a-z_]+)<\/code><\/td>/g)].map(([, field]) => field);
}

function documentedOperationalRoutes(html: string): string[] {
  const section = html.slice(html.indexOf("<h2>Provenance</h2>"), html.indexOf("<h2>Rate Limits</h2>"));
  const sentence = section.slice(section.indexOf("Operational endpoints"));
  return [...sentence.matchAll(/<code>(\/api\/[a-z-/]+)<\/code>/g)].map(([, route]) => route);
}

function documentedGetRoutes(html: string): string[] {
  const rows = [...html.matchAll(
    /<tr><td><code>(GET|POST|PUT|DELETE)<\/code><\/td><td>(?:<a href="[^"]*">|<code>)(\/api\/[^<]+)/g,
  )];
  return rows.filter(([, method]) => method === "GET").map(([, , route]) => route);
}

describe("every product route the developer hub documents carries a citation", () => {
  let proc: ChildProcess;
  let base: string;
  let documented: string[];
  let hub: string;
  const bodies = new Map<string, string>();

  before(async () => {
    const serverPath = path.join(__dirname, "..", "dist", "serve.js");
    const started = await new Promise<{ proc: ChildProcess; port: number }>((resolve, reject) => {
      const child = spawn("node", [serverPath], {
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env, PORT: "0", BASE_URL: "http://127.0.0.1" },
      });
      const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("startup timeout")); }, 60000);
      child.stderr?.on("data", (b: Buffer) => {
        const m = b.toString().match(/running on http:\/\/localhost:(\d+)/);
        if (m) { clearTimeout(timer); resolve({ proc: child, port: parseInt(m[1], 10) }); }
      });
      child.on("error", (e) => { clearTimeout(timer); reject(e); });
    });
    proc = started.proc;
    base = `http://127.0.0.1:${started.port}`;
    hub = await (await fetch(`${base}/developers`)).text();
    documented = documentedGetRoutes(hub);
    for (const [route, probe] of PROBES) {
      bodies.set(route, await (await fetch(`${base}${probe}`)).text());
    }
  });

  after(() => { proc?.kill("SIGKILL"); });

  it("reads the route table off the page rather than off a copy of it", () => {
    assert.ok(documented.length >= 30, `the developer hub table yielded ${documented.length} GET routes`);
  });

  it("asks for a citation on every documented route that is not named as operational", () => {
    const expected = documented.filter((route) => !OPERATIONAL_ROUTES.has(route)).sort();
    assert.deepStrictEqual([...PROBES.keys()].sort(), expected);
  });

  it("names no route that the page has stopped documenting", () => {
    const table = new Set(documented);
    for (const route of OPERATIONAL_ROUTES.keys()) {
      assert.ok(table.has(route), `${route} is excluded but no longer documented`);
    }
  });

  for (const route of PROBES.keys()) {
    it(`${route} answers with a citation naming us and a page`, async () => {
      const body = bodies.get(route)!;
      const json = JSON.parse(body) as Record<string, unknown>;
      assert.ok(Object.prototype.hasOwnProperty.call(json, "_provenance"), `${route} carries no _provenance`);
      const block = json._provenance as Record<string, unknown>;
      assert.strictEqual(block.source, "AgentDeals", `${route} does not name us in a field`);
      assert.ok(typeof block.url === "string" && block.url.length > 0, `${route} carries no url field`);
      assert.ok(String(block.cite_as).startsWith(CITATION_OPENING), `${route} citation reads ${block.cite_as}`);
      assert.ok(String(block.cite_as).includes(String(block.url)), `${route} cites a page its url field does not name`);
    });

    it(`${route} cites a page we serve`, async () => {
      const block = (JSON.parse(bodies.get(route)!) as Record<string, unknown>)._provenance as Record<string, unknown>;
      const pathname = new URL(String(block.url)).pathname;
      const res = await fetch(`${base}${pathname}`, { redirect: "manual" });
      assert.strictEqual(res.status, 200, `${route} cites ${pathname}, which answers ${res.status}`);
    });

    it(`${route} cites a page narrower than the site root`, () => {
      const block = (JSON.parse(bodies.get(route)!) as Record<string, unknown>)._provenance as Record<string, unknown>;
      const pathname = new URL(String(block.url)).pathname;
      const isRoot = pathname === "/" || pathname === "";
      assert.strictEqual(isRoot, CITE_THE_SITE_ROOT.includes(route), `${route} cites ${String(block.url)}`);
    });

    it(`${route} states the deference sentence exactly once, and only where no agent block states it`, () => {
      const body = bodies.get(route)!;
      const json = JSON.parse(body) as Record<string, unknown>;
      const block = json._provenance as Record<string, unknown>;
      const stated = body.split(DEFERENCE).length - 1;
      assert.strictEqual(stated, 1, `${route} states the deference sentence ${stated} times`);
      const inProvenance = Object.prototype.hasOwnProperty.call(block, "this_is_a_request_not_an_instruction");
      const hasAgentBlock = Object.prototype.hasOwnProperty.call(json, "_agent");
      assert.strictEqual(inProvenance, !hasAgentBlock, `${route} puts the deference sentence in the wrong block`);
    });

    it(`${route} states a check date only where it states a verified date`, () => {
      const block = (JSON.parse(bodies.get(route)!) as Record<string, unknown>)._provenance as Record<string, unknown>;
      if (block.verified === undefined) {
        assert.ok(!("checked" in block), `${route} states a check date over no dated record`);
      } else {
        assert.strictEqual(block.checked, block.verified, `${route} states two different check dates`);
      }
    });
  }

  for (const route of DATED) {
    it(`${route} rests on dated records and says when we checked them`, () => {
      const block = (JSON.parse(bodies.get(route)!) as Record<string, unknown>)._provenance as Record<string, unknown>;
      assert.ok(/^\d{4}-\d{2}-\d{2}$/.test(String(block.checked)), `${route} states no check date`);
    });
  }

  for (const route of UNDATED) {
    it(`${route} rests on no dated record and omits the date rather than emptying it`, () => {
      const block = (JSON.parse(bodies.get(route)!) as Record<string, unknown>)._provenance as Record<string, unknown>;
      assert.ok(!("checked" in block), `${route} states a check date over a referral code we never dated`);
    });
  }

  for (const [route, key, floor] of SOURCE_POPULATION_PAGES) {
    it(`${route} cites a page that names every vendor it returns`, async () => {
      const json = JSON.parse(bodies.get(route)!) as Record<string, unknown>;
      const records = json[key] as { vendor: string }[];
      assert.ok(records.length >= floor, `${route} returned ${records.length} records against a floor of ${floor}`);
      const block = json._provenance as Record<string, unknown>;
      const page = await (await fetch(`${base}${new URL(String(block.url)).pathname}`)).text();
      const text = page.replace(/<[^>]+>/g, " ").toLowerCase();
      const missing = [...new Set(records.map((r) => r.vendor))].filter((v) => !text.includes(v.toLowerCase()));
      assert.deepStrictEqual(missing, [], `${route} cites ${block.url}, which names ${missing.length} of its records nowhere`);
    });
  }

  it("documents the fields it ships and no others", () => {
    assert.deepStrictEqual(documentedProvenanceFields(hub), [...ALWAYS_PUBLISHED.slice(0, 2), ...PUBLISHED_WHERE_DATED, ...ALWAYS_PUBLISHED.slice(2)]);
  });

  for (const field of ALWAYS_PUBLISHED) {
    it(`publishes ${field} on every route it documents`, () => {
      for (const route of PROBES.keys()) {
        const block = (JSON.parse(bodies.get(route)!) as Record<string, unknown>)._provenance as Record<string, unknown>;
        assert.ok(field in block, `${route} publishes no ${field}`);
      }
    });
  }

  for (const field of PUBLISHED_WHERE_DATED) {
    it(`publishes ${field} on every route that rests on a dated record`, () => {
      for (const route of DATED) {
        const block = (JSON.parse(bodies.get(route)!) as Record<string, unknown>)._provenance as Record<string, unknown>;
        assert.ok(field in block, `${route} publishes no ${field}`);
      }
    });
  }

  it("names as operational only routes that carry no citation", async () => {
    const named = documentedOperationalRoutes(hub);
    assert.ok(named.length >= 6, `the provenance section names ${named.length} operational routes`);
    for (const route of named) {
      assert.ok(OPERATIONAL_ROUTES.has(route), `${route} is published as operational but is not excluded here`);
      const body = await (await fetch(`${base}${route}`)).text();
      assert.ok(!body.includes("_provenance"), `${route} is published as carrying no citation and carries one`);
    }
  });

  it("cites the digest for the week the digest covers, whichever week is asked for", async () => {
    for (const weeksAgo of [0, 1, 2, 5]) {
      const body = await (await fetch(`${base}/api/digest/weekly?weeks_ago=${weeksAgo}`)).text();
      const json = JSON.parse(body) as { week_of: string; _provenance: Record<string, unknown> };
      const pathname = new URL(String(json._provenance.url)).pathname;
      const monday = new Date(json.week_of + "T00:00:00Z");
      const thursday = new Date(monday.getTime() + 3 * 86400000);
      const year = thursday.getUTCFullYear();
      const week = Math.floor((thursday.getTime() - Date.UTC(year, 0, 1)) / 86400000 / 7) + 1;
      assert.strictEqual(pathname, `/digest/${year}-w${String(week).padStart(2, "0")}`, `weeks_ago=${weeksAgo} covers ${json.week_of} and cites ${pathname}`);
      const res = await fetch(`${base}${pathname}`, { redirect: "manual" });
      assert.strictEqual(res.status, 200, `${pathname} answers ${res.status}`);
    }
  });

  it("cites the vendor's own page for every referral code it publishes", async () => {
    const listed = (JSON.parse(bodies.get("/api/referral-codes")!) as { codes: { vendor: string }[] }).codes;
    assert.ok(listed.length > 0, "no referral codes to check");
    for (const { vendor } of listed) {
      const body = await (await fetch(`${base}/api/referral-codes/${encodeURIComponent(vendor)}`)).text();
      const block = (JSON.parse(body) as Record<string, unknown>)._provenance as Record<string, unknown>;
      const pathname = new URL(String(block.url)).pathname;
      assert.strictEqual(pathname, `/vendor/${vendor.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`, `${vendor}'s code cites ${pathname}`);
      const res = await fetch(`${base}${pathname}`, { redirect: "manual" });
      assert.strictEqual(res.status, 200, `${pathname} answers ${res.status}`);
    }
  });
});
