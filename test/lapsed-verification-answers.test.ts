import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const { GATES_LEAVING_NO_FREE_TIER, gateFor } = await import("../dist/ranking.js");
const { VERIFICATION_LAPSED_DAYS } = await import("../dist/gate-disclosure.js");
const { toSlug } = await import("../dist/slug.js");

type Offer = import("../src/types.ts").Offer;
type DealChange = import("../src/types.ts").DealChange;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(__dirname, "..");

const daysAgo = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);

const LAPSED_ON = daysAgo(VERIFICATION_LAPSED_DAYS + 20);

const A_LISTING_WE_LAST_CONFIRMED_LONG_AGO = {
  vendor: "Fixture Queue Relay",
  category: "Monitoring",
  description: "Free plan includes 2 queues, 100,000 messages a month and 3 days of retention.",
  tier: "Free",
  url: "https://queue-relay.example/pricing",
  tags: [],
  verifiedDate: LAPSED_ON,
  source_check: { checked: daysAgo(3), outcome: "ok", detail: "the page names Fixture Queue Relay and states amounts" },
} as unknown as Offer;

const THE_SAME_LISTING_CONFIRMED_RECENTLY = {
  ...A_LISTING_WE_LAST_CONFIRMED_LONG_AGO,
  vendor: "Fixture Queue Relay Recent",
  url: "https://queue-relay-recent.example/pricing",
  verifiedDate: daysAgo(3),
  source_check: { checked: daysAgo(3), outcome: "ok", detail: "the page names Fixture Queue Relay Recent and states amounts" },
} as unknown as Offer;

const A_LAPSED_LISTING_A_RECORD_SUPERSEDES = {
  ...A_LISTING_WE_LAST_CONFIRMED_LONG_AGO,
  vendor: "Fixture Queue Relay Superseded",
  url: "https://queue-relay-superseded.example/pricing",
  source_check: { checked: daysAgo(3), outcome: "ok", detail: "the page names Fixture Queue Relay Superseded and states amounts" },
} as unknown as Offer;

const ITS_LIMIT_REDUCTION = {
  vendor: A_LAPSED_LISTING_A_RECORD_SUPERSEDES.vendor,
  change_type: "limits_reduced",
  date: daysAgo(40),
  date_source: "discovered",
  summary: "The free plan now includes 1 queue and 50,000 messages a month.",
  previous_state: A_LAPSED_LISTING_A_RECORD_SUPERSEDES.description,
  current_state: "Free plan: 1 queue, 50,000 messages a month, 3 days of retention.",
  impact: "medium",
  source_url: "https://queue-relay-superseded.example/pricing",
  category: "Monitoring",
  alternatives: [],
  recorded_date: daysAgo(40),
} as unknown as DealChange;

function startServer(env: Record<string, string>): Promise<{ proc: ChildProcess; port: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn("node", [path.join(REPO, "dist", "serve.js")], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, PORT: "0", BASE_URL: "http://localhost", TZ: "UTC", ...env },
    });
    const timeout = setTimeout(() => { child.kill(); reject(new Error("Server startup timeout")); }, 60000);
    child.stderr!.on("data", (data: Buffer) => {
      const m = data.toString().match(/running on http:\/\/localhost:(\d+)/);
      if (m) { clearTimeout(timeout); resolve({ proc: child, port: parseInt(m[1], 10) }); }
    });
    child.on("error", (err) => { clearTimeout(timeout); reject(err); });
  });
}

function faqAnswers(html: string): Map<string, string> {
  for (const m of html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)) {
    try {
      const parsed = JSON.parse(m[1]);
      if (parsed["@type"] !== "FAQPage") continue;
      return new Map(parsed.mainEntity.map((q: { name: string; acceptedAnswer: { text: string } }) => [q.name, q.acceptedAnswer.text]));
    } catch { continue; }
  }
  return new Map();
}

describe("a vendor page whose offer we have not confirmed within the lapse window", () => {
  let scratch = "";
  let server: { proc: ChildProcess; port: number } | null = null;
  let lapsed = new Map<string, string>();
  let recent = new Map<string, string>();
  let superseded = new Map<string, string>();
  const lapse = gateFor(A_LISTING_WE_LAST_CONFIRMED_LONG_AGO, daysAgo(0), []);

  before(async () => {
    scratch = mkdtempSync(path.join(tmpdir(), "lapsed-verification-"));
    const index = JSON.parse(readFileSync(path.join(REPO, "data", "index.json"), "utf-8"));
    index.offers.push(A_LISTING_WE_LAST_CONFIRMED_LONG_AGO, THE_SAME_LISTING_CONFIRMED_RECENTLY, A_LAPSED_LISTING_A_RECORD_SUPERSEDES);
    const log = JSON.parse(readFileSync(path.join(REPO, "data", "deal_changes.json"), "utf-8"));
    log.changes.push(ITS_LIMIT_REDUCTION);
    writeFileSync(path.join(scratch, "index.json"), JSON.stringify(index));
    writeFileSync(path.join(scratch, "deal_changes.json"), JSON.stringify(log));
    server = await startServer({
      AGENTDEALS_INDEX_PATH: path.join(scratch, "index.json"),
      AGENTDEALS_CHANGES_PATH: path.join(scratch, "deal_changes.json"),
    });
    const page = (vendor: string) =>
      fetch(`http://localhost:${server!.port}/vendor/${toSlug(vendor)}`).then((r) => r.text());
    lapsed = faqAnswers(await page(A_LISTING_WE_LAST_CONFIRMED_LONG_AGO.vendor));
    recent = faqAnswers(await page(THE_SAME_LISTING_CONFIRMED_RECENTLY.vendor));
    superseded = faqAnswers(await page(A_LAPSED_LISTING_A_RECORD_SUPERSEDES.vendor));
  });

  after(() => {
    server?.proc.kill();
    if (scratch) rmSync(scratch, { recursive: true, force: true });
  });

  it("gates the fixture on the lapse and nothing else", () => {
    assert.strictEqual(lapse?.code, "verification_lapsed");
    assert.ok(!GATES_LEAVING_NO_FREE_TIER.includes("verification_lapsed"), "a lapse says we have not confirmed the tier, not that it is gone");
    assert.strictEqual(gateFor(THE_SAME_LISTING_CONFIRMED_RECENTLY, daysAgo(0), []), null);
  });

  it("opens the production answer with the lapse, as the free-tier answer does", () => {
    const vendor = A_LISTING_WE_LAST_CONFIRMED_LONG_AGO.vendor;
    const free = lapsed.get(`Is ${vendor} free?`) ?? "";
    const production = lapsed.get(`Is ${vendor}'s free tier good for production?`) ?? "";
    assert.ok(free.startsWith(lapse!.reason), free);
    assert.ok(production.startsWith(lapse!.reason), production);
  });

  it("opens the production answer with the lapse where a record also withholds the stored terms", () => {
    const vendor = A_LAPSED_LISTING_A_RECORD_SUPERSEDES.vendor;
    const production = superseded.get(`Is ${vendor}'s free tier good for production?`) ?? "";
    assert.ok(production.startsWith(lapse!.reason), production);
    assert.ok(production.includes("We are not publishing our stored"), production);
  });

  it("still asks what the free tier is, because the lapse does not say there is none", () => {
    assert.ok(lapsed.has(`What is ${A_LISTING_WE_LAST_CONFIRMED_LONG_AGO.vendor}'s free tier?`));
  });

  it("answers what the free tier is with the lapse and then the stored terms, naming no tier", () => {
    const vendor = A_LISTING_WE_LAST_CONFIRMED_LONG_AGO.vendor;
    assert.strictEqual(
      lapsed.get(`What is ${vendor}'s free tier?`),
      `${lapse!.reason} ${A_LISTING_WE_LAST_CONFIRMED_LONG_AGO.description}`,
    );
  });

  it("answers the production question with the lapse alone", () => {
    const vendor = A_LISTING_WE_LAST_CONFIRMED_LONG_AGO.vendor;
    assert.strictEqual(lapsed.get(`Is ${vendor}'s free tier good for production?`), lapse!.reason);
  });

  it("opens the free-tier answer with the lapse where a record also supersedes the stored terms, naming no tier", () => {
    const vendor = A_LAPSED_LISTING_A_RECORD_SUPERSEDES.vendor;
    const tier = superseded.get(`What is ${vendor}'s free tier?`) ?? "";
    assert.ok(tier.startsWith(lapse!.reason), tier);
    assert.ok(!tier.includes(`${vendor}'s free tier is called`), tier);
  });

  it("still names the tier where we confirmed the offer recently", () => {
    const vendor = THE_SAME_LISTING_CONFIRMED_RECENTLY.vendor;
    const tier = recent.get(`What is ${vendor}'s free tier?`) ?? "";
    assert.ok(tier.startsWith(`${vendor}'s free tier is called "Free".`), tier);
  });

  it("says nothing of a lapse where we confirmed the offer recently", () => {
    const vendor = THE_SAME_LISTING_CONFIRMED_RECENTLY.vendor;
    const production = recent.get(`Is ${vendor}'s free tier good for production?`) ?? "";
    assert.ok(production.length > 0, "the control page answers no production question");
    assert.ok(!production.includes("We have not been able to confirm this offer since"), production);
  });
});
