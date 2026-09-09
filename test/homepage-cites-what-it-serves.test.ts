import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { API_ENDPOINTS, DOCUMENTED_GROUPS, HOMEPAGE_GROUPS, endpointHref, endpointsInGroups, exampleSubjects, readableEndpoints } from "../dist/api-inventory.js";
import { ACCELERATOR_CREDIT_PROGRAM, ACCELERATOR_CREDIT_VENDOR, figureIsHeldBy, figuresIn, normaliseFigure, programCeiling } from "../dist/homepage-claims.js";
import { loadDealChanges, loadOffers } from "../dist/data.js";
import { SIGNAL_DOC_PATH, SIGNAL_PATH } from "../dist/signal.js";
import { CRITERIA_PATH } from "../dist/ranking.js";
import { VENDOR_SERIES_PATH } from "../dist/vendor-series.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const SERVE_SOURCE = path.join(__dirname, "..", "src", "serve.ts");

const ROUTES_WE_DO_NOT_PUBLISH = new Map<string, string>([
  ["/api/metrics", "our own service counters, read by the status page"],
  ["/api/signals", "an inbox for agent-submitted signals"],
  ["/api/page-reviews", "our editorial review register"],
  ["/api/analytics/history", "our own analytics"],
  ["/api/analytics/daily", "our own analytics"],
  ["/api/analytics/vendors", "our own analytics — the per-vendor daily series, whose state /api/traffic publishes"],
  ["/api/agent-payments", "the retired marketplace ledger"],
  ["/api/agents/register", "agent registration, not a read endpoint"],
  ["/api/agents/me", "one caller's own registration"],
  ["/api/referral/", "a redirect, not a JSON body"],
  ["/api/conversions", "the retired marketplace ledger"],
  ["/api/conversions/confirm", "the retired marketplace ledger"],
  ["/api/conversions/clawback", "the retired marketplace ledger"],
  ["/api/referral-codes/mine", "one caller's own submissions"],
  ["/api/friends", "the agent friend graph"],
  ["/api/friends/codes", "the agent friend graph"],
  ["/api/leaderboard", "the retired marketplace ledger"],
  ["/api/indexnow/status", "our own crawl plumbing"],
  ["/api/referral-health", "our own link plumbing"],
  ["/api/docs/", "an asset path under /api/docs"],
  ["/api/watchlist/", "one caller's own subscription"],
  ["/api/vendor-risk/", "published as /api/vendor-risk/:vendor"],
  ["/api/details/", "published as /api/details/:vendor"],
]);

const NAMES_A_CLIENT_NOT_A_CLAIM = ["Cursor", "Cline", "Windsurf", "Claude Desktop"];

const NAMES_AN_EXAMPLE_QUERY = ["Firebase"];

const ROUTES_NAMED_BY_A_CONSTANT: Record<string, string> = { SIGNAL_PATH, SIGNAL_DOC_PATH, CRITERIA_PATH, VENDOR_SERIES_PATH };

function constantsRoutingAPath(): string[] {
  const source = readFileSync(SERVE_SOURCE, "utf8");
  return [...new Set([...source.matchAll(/url\.pathname === ([A-Z][A-Z0-9_]*)\b/g)].map(([, name]) => name))].sort();
}

function servedApiRoutes(): string[] {
  const source = readFileSync(SERVE_SOURCE, "utf8");
  const exact = [...source.matchAll(/url\.pathname === "(\/api\/[^"]+)"/g)].map(([, route]) => route);
  const prefixed = [...source.matchAll(/url\.pathname\.startsWith\("(\/api\/[^"]+)"\)/g)].map(([, route]) => route);
  const named = constantsRoutingAPath()
    .map((name) => ROUTES_NAMED_BY_A_CONSTANT[name])
    .filter((route): route is string => typeof route === "string" && route.startsWith("/api/"));
  return [...new Set([...exact, ...prefixed, ...named])].sort();
}

function requestsPrintedOnHome(html: string): string[] {
  const blocks = [...html.matchAll(/<pre><code>([\s\S]*?)<\/code><\/pre>/g)].map(([, body]) => body);
  return blocks
    .flatMap((block) => block.split("\n"))
    .filter((line) => line.startsWith("GET /api/"))
    .map((line) => line.slice(4).replace(/&amp;/g, "&"));
}

function withoutMarkup(html: string): string {
  const body = html.slice(html.indexOf("<body"));
  const noScript = body.replace(/<script[\s\S]*?<\/script>/g, " ").replace(/<style[\s\S]*?<\/style>/g, " ");
  return noScript.replace(/<pre[\s\S]*?<\/pre>/g, " ").replace(/<code[\s\S]*?<\/code>/g, " ");
}

function namedOutsideALink(prose: string, name: string): boolean {
  const outside = prose.replace(/<a\b[^>]*>[\s\S]*?<\/a>/g, "   ").replace(/<[^>]*>/g, " ");
  return mentions(outside, name);
}

function namedInsideALink(prose: string, name: string): boolean {
  const linked = [...prose.matchAll(/<a\b[^>]*>([\s\S]*?)<\/a>/g)].map(([, text]) => text.replace(/<[^>]*>/g, "")).join(" | ");
  return mentions(linked, name);
}

function mentions(corpus: string, name: string): boolean {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![\\w.-])${escaped}(?![\\w-])`).test(corpus);
}

describe("the homepage publishes only what it can serve", () => {
  let proc: ChildProcess;
  let base: string;
  let home: string;
  let printed: string[];

  before(async () => {
    const started = await new Promise<{ proc: ChildProcess; port: number }>((resolve, reject) => {
      const child = spawn("node", [path.join(__dirname, "..", "dist", "serve.js")], {
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
    home = await (await fetch(`${base}/`)).text();
    printed = requestsPrintedOnHome(home);
  });

  after(() => { proc?.kill("SIGKILL"); });

  it("prints enough requests to be worth issuing", () => {
    assert.ok(printed.length >= 20, `the homepage printed ${printed.length} API requests`);
  });

  it("issues every API request it prints and gets an answer", async () => {
    const refused: string[] = [];
    for (const request of printed) {
      const res = await fetch(`${base}${request}`);
      if (res.status >= 400) refused.push(`${request} -> ${res.status} ${(await res.text()).slice(0, 120)}`);
    }
    assert.deepStrictEqual(refused, [], `requests printed on / that the server refuses:\n${refused.join("\n")}`);
  });

  it("states an endpoint count equal to the number of requests it prints", () => {
    const stated = [...withoutMarkup(home).matchAll(/(\d+)\s+read endpoints/g)].map(([, n]) => Number(n));
    assert.ok(stated.length > 0, "the homepage states no endpoint count");
    for (const count of stated) assert.strictEqual(count, printed.length);
  });

  it("prints every read endpoint the inventory publishes, and nothing it does not", () => {
    const subjects = exampleSubjects(loadOffers().map((o) => o.vendor), []);
    const expected = readableEndpoints(HOMEPAGE_GROUPS)
      .map((e) => endpointHref(e, subjects))
      .filter((href): href is string => href !== null);
    assert.deepStrictEqual([...printed].sort(), [...expected].sort());
  });

  it("holds every /api route the server serves in one inventory or names why it is unpublished", () => {
    const known = new Set(API_ENDPOINTS.map((e) => e.path.replace(/:[a-z]+$/i, "")));
    const stray = servedApiRoutes().filter((route) => !known.has(route) && !ROUTES_WE_DO_NOT_PUBLISH.has(route));
    assert.deepStrictEqual(stray, [], `served /api routes in neither the inventory nor the unpublished register: ${stray.join(", ")}`);
  });

  it("resolves every constant the router matches a path against, so none can hide from that scan", () => {
    const unresolved = constantsRoutingAPath().filter((name) => ROUTES_NAMED_BY_A_CONSTANT[name] === undefined);
    assert.deepStrictEqual(unresolved, [], `constants the router keys on that this scan cannot resolve to a path: ${unresolved.join(", ")}`);
  });

  it("issues every API link the developer hub offers and gets an answer", async () => {
    const hub = await (await fetch(`${base}/developers`)).text();
    const links = [...new Set([...hub.matchAll(/<td><a href="([^"]*(\/api\/[^"]*))">/g)].map(([, , request]) => request.replace(/&amp;/g, "&")))];
    assert.ok(links.length >= 25, `the developer hub offers ${links.length} API links`);
    const refused: string[] = [];
    for (const link of links) {
      const res = await fetch(`${base}${link}`);
      if (res.status >= 400) refused.push(`${link} -> ${res.status}`);
    }
    assert.deepStrictEqual(refused, [], `API links on /developers that the server refuses:\n${refused.join("\n")}`);
  });

  it("states one endpoint count wherever it states one", async () => {
    const hub = await (await fetch(`${base}/developers`)).text();
    const report = await (await fetch(`${base}/state-of-free-tiers`)).text();
    const onHub = hub.match(/<div class="num">(\d+)<\/div><div class="label">Endpoints<\/div>/);
    const onReport = report.match(/(\d+) endpoints\. Open data\./);
    assert.ok(onHub, "/developers states no endpoint count");
    assert.ok(onReport, "/state-of-free-tiers states no endpoint count");
    assert.strictEqual(Number(onReport![1]), Number(onHub![1]));
    assert.strictEqual(Number(onHub![1]), endpointsInGroups(DOCUMENTED_GROUPS).length);
  });

  it("writes no endpoint count as a literal in a source file", () => {
    const source = readFileSync(SERVE_SOURCE, "utf8");
    const literals = [...source.matchAll(/>(\d+) endpoints/g)].map(([match]) => match);
    assert.deepStrictEqual(literals, []);
  });

  it("states no figure above the fold that no record of ours holds", () => {
    const prose = withoutMarkup(home).replace(/<[^>]*>/g, " ");
    const above = prose.slice(0, prose.indexOf("How It Works"));
    const corpus = [
      ...loadOffers().map((o) => `${o.description ?? ""} ${o.tier ?? ""}`),
      ...loadDealChanges().flatMap((c) => [c.summary, c.previous_state, c.current_state]),
    ];
    const unheld = figuresIn(above).filter((figure) => !figureIsHeldBy(figure, corpus));
    assert.deepStrictEqual([...new Set(unheld)], [], `figures published above the fold that no record holds: ${unheld.join(", ")}`);
  });

  it("takes the accelerator credit ceiling from the record rather than from prose", () => {
    const record = loadOffers().find((o) => o.vendor === ACCELERATOR_CREDIT_VENDOR);
    const ceiling = programCeiling(record, ACCELERATOR_CREDIT_PROGRAM);
    assert.ok(ceiling, `no ${ACCELERATOR_CREDIT_PROGRAM} ceiling in the ${ACCELERATOR_CREDIT_VENDOR} record`);
    const statements = [...home.matchAll(/<p class="problem-text">([\s\S]*?)<\/p>/g)].map(([, text]) => text);
    const claiming = statements.filter((text) => /credits/i.test(text));
    assert.ok(claiming.length > 0, "the problem statement makes no credit claim");
    for (const claim of claiming) {
      const stated = figuresIn(claim.replace(/<[^>]*>/g, " "));
      assert.deepStrictEqual(
        stated.map(normaliseFigure),
        stated.map(() => normaliseFigure(ceiling!)),
        `the problem statement says ${stated.join(", ")} where the record's ceiling is ${ceiling}`,
      );
    }
  });

  it("links the vendor on every change it puts on the page", () => {
    const cells = [...home.matchAll(/<span class="change-vendor">([\s\S]*?)<\/span>/g)].map(([, cell]) => cell);
    assert.ok(cells.length > 0, "the homepage renders no change cards");
    const unlinked = cells.filter((cell) => !/<a\b/.test(cell)).map((cell) => cell.trim());
    assert.deepStrictEqual(unlinked, [], `change cards naming a vendor with no link: ${unlinked.join(", ")}`);
  });

  it("reaches a page for every vendor it names in prose", () => {
    const prose = withoutMarkup(home);
    const excused = new Set([...NAMES_A_CLIENT_NOT_A_CLAIM, ...NAMES_AN_EXAMPLE_QUERY]);
    const unreachable = loadOffers()
      .map((o) => o.vendor)
      .filter((vendor) => vendor.length >= 4 && !excused.has(vendor))
      .filter((vendor) => namedOutsideALink(prose, vendor) && !namedInsideALink(prose, vendor));
    assert.deepStrictEqual([...new Set(unreachable)], [], `vendors named on / that reach no page: ${unreachable.join(", ")}`);
  });
});

describe("a record does not contradict its own source check", () => {
  it("states the accelerator credit ceiling its own check read off the page", () => {
    const record = loadOffers().find((o) => o.vendor === ACCELERATOR_CREDIT_VENDOR);
    const detail = record?.source_check?.detail ?? "";
    const quoted = [...detail.matchAll(/"(\$[^"]{1,20})"/g)].map(([, figure]) => figure);
    assert.ok(quoted.length > 0, `the ${ACCELERATOR_CREDIT_VENDOR} check quotes no figure`);
    const ceiling = programCeiling(record, ACCELERATOR_CREDIT_PROGRAM);
    assert.ok(ceiling, `no ${ACCELERATOR_CREDIT_PROGRAM} ceiling in the ${ACCELERATOR_CREDIT_VENDOR} record`);
    assert.ok(
      quoted.some((figure) => normaliseFigure(figure) === normaliseFigure(ceiling!)),
      `the record states ${ceiling} where its own check read ${quoted.join(", ")} off the page`,
    );
  });

  it("carries the date it asserts inside the finding its citation is read from", () => {
    const months = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
    const mismatched = loadDealChanges()
      .filter((change) => change.source_check)
      .filter((change) => {
        const [year, month, day] = change.date.split("-").map(Number);
        const spelled = `${months[month - 1]} ${day}, ${year}`;
        return !change.source_check!.finding.includes(spelled) && !change.source_check!.finding.includes(change.date);
      })
      .map((change) => `${change.vendor} ${change.date}: ${change.source_check!.finding}`);
    assert.deepStrictEqual(mismatched, [], `records whose finding does not carry the date they assert:\n${mismatched.join("\n")}`);
  });

  it("checks a source on the deprecations the homepage leads with", () => {
    const checked = loadDealChanges().filter((change) => change.source_check);
    assert.ok(checked.length >= 2, `only ${checked.length} change records record what their source says`);
  });
});
