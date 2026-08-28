import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { growthLimitPhrases, readPeriod } from "../dist/growth-limits.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(__dirname, "..");

const rateLimit = (description: string): string => {
  const phrases = growthLimitPhrases(description);
  assert.equal(phrases.length, 1, `expected one limit phrase from: ${description}`);
  return phrases[0];
};

describe("the free-tier threshold reads its period from the clause the quantity is in", () => {
  it("keeps a per-day rate written with a slash", () => {
    assert.equal(
      rateLimit("Edge compute with 100K requests/day, 10ms CPU time per invocation"),
      "100K requests/day"
    );
  });

  it("keeps a per-day rate written as a phrase", () => {
    assert.equal(rateLimit("The free plan allows 300 requests per day."), "300 requests/day");
  });

  it("keeps a per-day rate written as an article", () => {
    assert.equal(rateLimit("Free accounts get 15 emails a day forever."), "15 emails/day");
  });

  it("keeps a per-day rate written as an adverb", () => {
    assert.equal(
      rateLimit("Free for one organization, 1,000 API calls daily. Task management, apps, workspaces"),
      "1,000 API calls/day"
    );
  });

  it("keeps a per-hour rate written with a slash", () => {
    assert.equal(
      rateLimit("Free tier: 100 searches/month, 50 requests/hour throughput limit."),
      "50 requests/hour"
    );
  });

  it("keeps a per-hour rate written as an adverb, and does not reach past it to a later period", () => {
    assert.equal(
      rateLimit("Free tier includes 500 invocations hourly, 2,500 invocations daily and 50,000 monthly"),
      "500 invocations/hour"
    );
  });

  it("keeps a per-minute rate and does not describe it as monthly", () => {
    const phrase = rateLimit("Free model only, 3 requests/minute rate limit. No free trial credits.");
    assert.equal(phrase, "3 requests/min");
    assert.doesNotMatch(phrase, /\/mo\b/);
  });

  it("keeps a per-minute rate written as a phrase and does not describe it as monthly", () => {
    const phrase = rateLimit("Serverless backend, 60 API calls per minute, no credit-card signup.");
    assert.doesNotMatch(phrase, /\/mo\b/);
    assert.equal(phrase, "60 API calls/min");
  });

  it("keeps a per-second rate and does not describe it as monthly", () => {
    const phrase = rateLimit("Free embeds: 5,000/month at 15 requests/second");
    assert.equal(phrase, "15 requests/sec");
    assert.doesNotMatch(phrase, /\/mo\b/);
  });

  it("keeps a per-month rate written as a phrase", () => {
    assert.equal(
      rateLimit("2,500 subscribers and 10,000 emails per month free"),
      "10,000 emails/mo"
    );
  });

  it("keeps a per-month rate stated after an intervening free", () => {
    assert.equal(
      rateLimit("Observability for LLM apps. Log up to 10,000 requests for free every month."),
      "10,000 requests/mo"
    );
  });

  it("keeps a window that is several units wide rather than rounding it to a month", () => {
    assert.equal(
      rateLimit("1,000 contacts, 4,000 emails per 30 days (marketing + transactional)"),
      "4,000 emails per 30 days"
    );
  });

  it("keeps the scope a rate is measured against", () => {
    assert.equal(
      rateLimit("Free for up to 5 editors. 1,000 API calls/workspace/month. 2-week revision history"),
      "1,000 API calls/mo per workspace"
    );
  });

  it("keeps both the window and the scope when the source states both", () => {
    assert.equal(
      rateLimit("Free forever, with rate limits per registry (e.g., 5 messages per 5 sec per channel). No charges ever"),
      "5 messages per 5 seconds per channel"
    );
  });
});

describe("a threshold with no stated period does not gain one", () => {
  it("reports a one-off allowance without a period", () => {
    const phrase = rateLimit("Company logo API with 44M+ brands. First 10,000 API calls are free.");
    assert.equal(phrase, "10,000 API calls");
    assert.doesNotMatch(phrase, /\/mo\b|per /);
  });

  it("reports a bare quantity in a feature list without a period", () => {
    const phrase = rateLimit("Free tier includes: 100 SMS and calls, 3000 Emails, Push, Slack, MS Teams");
    assert.equal(phrase, "3000 Emails");
    assert.doesNotMatch(phrase, /\/mo\b|per /);
  });

  it("does not borrow the period from a different quantity in the same sentence", () => {
    const phrase = rateLimit("Serverless workflow orchestration — 50K function executions/month, 100K events, 5 concurrent steps");
    assert.equal(phrase, "100K events");
    assert.doesNotMatch(phrase, /\/mo\b/);
  });

  it("does not reach past the clause it matched for a period named later in the sentence", () => {
    const phrase = rateLimit("Free tier includes 100K events, with dedicated support billed per hour.");
    assert.equal(phrase, "100K events");
    assert.doesNotMatch(phrase, /\/hour/);
  });

  it("does not reach past the clause it matched for an adverb named later in the sentence", () => {
    const phrase = rateLimit("Free tier includes 100K events, with usage reports delivered monthly.");
    assert.equal(phrase, "100K events");
    assert.doesNotMatch(phrase, /\/mo\b/);
  });

  it("does not treat a stored depth as a rate", () => {
    const phrase = rateLimit("The free plan includes 10,000 messages of search history and File storage up to 5 GB.");
    assert.equal(phrase, "10,000 messages of search history");
    assert.doesNotMatch(phrase, /\/mo\b/);
  });
});

describe("a description naming two periods for the same noun", () => {
  it("reports one limit with the period stated beside it", () => {
    const phrase = rateLimit("Free with a personal account: 60 requests/minute, 1,000 requests/day, 1M token context");
    assert.equal(phrase, "60 requests/min");
    assert.doesNotMatch(phrase, /\/day|\/mo\b/);
  });
});

describe("reading a period from the text that follows a quantity", () => {
  it("finds nothing to read when the sentence simply continues", () => {
    assert.equal(readPeriod(" are free."), null);
    assert.equal(readPeriod(" for unlimited projects and unlimited status pages."), null);
    assert.equal(readPeriod(", 12-week history) begins at Starter $9/month."), null);
  });

  it("does not accept a noun that is not a unit of time", () => {
    assert.equal(readPeriod("/request"), null);
    assert.equal(readPeriod(" per seat"), null);
  });
});

describe("the other free-tier limits the page reports", () => {
  it("reports storage, bandwidth, users and projects unchanged by rate parsing", () => {
    assert.deepEqual(
      growthLimitPhrases("Free tier: 5 GB storage, 100 GB bandwidth, 50K MAU, 3 projects"),
      ["5 GB storage", "100 GB bandwidth", "50K MAU", "3 projects"]
    );
  });
});

const A_RATE_WE_CONFIRMED = {
  vendor: "Controlcorp",
  category: "Databases",
  description: "Free tier with 100K requests/day and 5 GB storage",
  tier: "Free",
  url: "https://controlcorp.example/pricing",
  tags: ["databases"],
  verifiedDate: "2026-08-11",
  source_check: { checked: "2026-08-28", outcome: "ok", detail: "text" },
};

const A_PER_MINUTE_RATE_WE_CONFIRMED = {
  ...A_RATE_WE_CONFIRMED,
  vendor: "Minutecorp",
  url: "https://minutecorp.example/pricing",
  description: "Free model access, 3 requests/minute rate limit. No trial credits.",
};

const A_RATE_FROM_A_PAGE_STATING_NO_TERMS = {
  ...A_RATE_WE_CONFIRMED,
  vendor: "Prosecorp",
  url: "https://prosecorp.example/pricing",
  description: "Free inference for open-source models with 100 requests/day limit.",
  source_check: { checked: "2026-08-28", outcome: "states_no_terms", detail: "no amount, tier or rate" },
};

let fixtureDir = "";
let serverPort = 0;
let proc: ChildProcess | null = null;

function startServer(indexPath: string): Promise<ChildProcess> {
  return new Promise((resolve, reject) => {
    const child = spawn("node", [path.join(REPO, "dist", "serve.js")], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, PORT: "0", BASE_URL: "http://localhost", AGENTDEALS_INDEX_PATH: indexPath },
    });
    const timeout = setTimeout(() => { child.kill(); reject(new Error("Server startup timeout")); }, 20000);
    child.stderr!.on("data", (data: Buffer) => {
      const m = data.toString().match(/running on http:\/\/localhost:(\d+)/);
      if (m) { serverPort = parseInt(m[1], 10); clearTimeout(timeout); resolve(child); }
    });
    child.on("error", (err) => { clearTimeout(timeout); reject(err); });
  });
}

const get = async (p: string) => {
  const res = await fetch(`http://localhost:${serverPort}${p}`);
  return { status: res.status, body: await res.text() };
};

function growthBlock(body: string): string {
  const block = body.match(/<div class="section growth-section">[\s\S]*?<\/div>/)?.[0];
  assert.ok(block, "the page must carry a growth section for the assertion to mean anything");
  return block;
}

function outgrowAnswer(body: string): string {
  const page = [...body.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)]
    .map((m) => { try { return JSON.parse(m[1]); } catch { return null; } })
    .find((json) => json && json["@type"] === "FAQPage");
  assert.ok(page, "the page must ship FAQPage structured data for the assertion to mean anything");
  const entry = page.mainEntity.find((e: { name: string }) => /outgrow/i.test(e.name));
  assert.ok(entry, "the structured data must carry the outgrow question");
  return entry.acceptedAnswer.text;
}

before(async () => {
  fixtureDir = mkdtempSync(path.join(tmpdir(), "growth-limits-"));
  const indexPath = path.join(fixtureDir, "index.json");
  writeFileSync(
    indexPath,
    JSON.stringify({
      offers: [A_RATE_WE_CONFIRMED, A_PER_MINUTE_RATE_WE_CONFIRMED, A_RATE_FROM_A_PAGE_STATING_NO_TERMS],
    }, null, 2)
  );
  proc = await startServer(indexPath);
});

after(() => {
  if (proc) proc.kill();
  if (fixtureDir) rmSync(fixtureDir, { recursive: true, force: true });
});

describe("the outgrow block on a vendor page", () => {
  it("renders, so the assertions below are about a real page", async () => {
    const res = await get("/vendor/controlcorp");
    assert.equal(res.status, 200);
    assert.match(growthBlock(res.body), /At 100K requests\/day, you'll need to upgrade\./);
  });

  it("states a per-minute rate as per-minute", async () => {
    const { body } = await get("/vendor/minutecorp");
    const block = growthBlock(body);
    assert.match(block, /At 3 requests\/min, you'll need to upgrade\./);
    assert.doesNotMatch(block, /\/mo\b/);
  });

  it("ships the same threshold to readers and to structured data", async () => {
    const { body } = await get("/vendor/minutecorp");
    assert.match(growthBlock(body), /At 3 requests\/min, you'll need to upgrade\./);
    assert.match(outgrowAnswer(body), /^At 3 requests\/min, you'll need to upgrade\./);
  });

  it("does not state a threshold read off a page that states no terms", async () => {
    const { body } = await get("/vendor/prosecorp");
    const block = growthBlock(body);
    assert.doesNotMatch(block, /At 100 requests\/day, you'll need to upgrade/);
    assert.match(block, /states no terms we can read/);
    assert.match(block, /we cannot confirm that threshold today/);
  });

  it("keeps the recorded threshold visible while saying it is unconfirmed", async () => {
    const { body } = await get("/vendor/prosecorp");
    assert.match(growthBlock(body), /We record 100 requests\/day as the limit/);
  });

  it("withholds the same threshold in structured data as on the page", async () => {
    const { body } = await get("/vendor/prosecorp");
    const answer = outgrowAnswer(body);
    assert.doesNotMatch(answer, /^At 100 requests\/day/);
    assert.match(answer, /we cannot confirm that threshold today/);
  });
});
