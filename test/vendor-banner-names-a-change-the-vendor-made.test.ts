import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const DAY_MS = 86_400_000;
const TODAY = new Date().toISOString().slice(0, 10);
const dayFromToday = (days: number) => new Date(Date.parse(`${TODAY}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);

const liveLog = JSON.parse(readFileSync(path.join(REPO, "data", "deal_changes.json"), "utf8"));

function offer(vendor: string) {
  return {
    vendor,
    category: "APIs",
    description: "Free tier with 10,000 requests per month",
    tier: "Free",
    url: `https://${vendor.toLowerCase()}.example/pricing`,
    tags: ["apis"],
    verifiedDate: dayFromToday(-2),
    source_check: { checked: dayFromToday(-2), outcome: "ok", detail: "text" },
  };
}

function record(vendor: string, change_type: string, date: string, summary: string) {
  return {
    vendor,
    change_type,
    date,
    summary,
    previous_state: "The terms before the change",
    current_state: "The terms after the change",
    impact: "medium",
    source_url: `https://${vendor.toLowerCase()}.example/pricing`,
    category: "APIs",
    alternatives: [],
    recorded_date: date,
    date_source: "hand_written",
  };
}

function retracted<T extends object>(change: T) {
  return {
    ...change,
    resolution: {
      state: "retracted",
      date: dayFromToday(-1),
      detail: "Retracted: the vendor's page never stated this change.",
      source_url: "https://example.com/pricing",
    },
  };
}

function reversed<T extends object>(change: T) {
  return {
    ...change,
    resolution: {
      state: "reversed",
      date: dayFromToday(-2),
      detail: "Reversed: the vendor restored the free plan.",
      source_url: "https://example.com/pricing",
    },
  };
}

const ALL_RETRACTED = "Allretractedcorp";
const RETRACTED_ON_TOP = "Retractedontopcorp";
const CORRECTED_ON_TOP = "Correctedontopcorp";
const REVERSED_ON_TOP = "Reversedontopcorp";

const CAUSE = (vendor: string) => record(vendor, "open_source_killed", dayFromToday(-30), `${vendor} moved its open-source edition to a paid licence`);
const NARROWING = (vendor: string) => record(vendor, "limits_reduced", dayFromToday(-10), `${vendor} lowered its free allowance from 20,000 to 10,000 requests a month`);
const RETRACTED_REMOVAL = retracted(record(RETRACTED_ON_TOP, "free_tier_removed", dayFromToday(-5), `${RETRACTED_ON_TOP} ended its free plan`));
const RETRACTION_LABEL = "this record was our error";

const RECORDS = [
  retracted(record(ALL_RETRACTED, "free_tier_removed", dayFromToday(-20), `${ALL_RETRACTED} ended its free plan`)),
  retracted(record(ALL_RETRACTED, "limits_reduced", dayFromToday(-5), `${ALL_RETRACTED} cut its free allowance in half`)),
  CAUSE(RETRACTED_ON_TOP),
  NARROWING(RETRACTED_ON_TOP),
  RETRACTED_REMOVAL,
  CAUSE(CORRECTED_ON_TOP),
  NARROWING(CORRECTED_ON_TOP),
  record(CORRECTED_ON_TOP, "record_corrected", dayFromToday(-3), `Data correction - ${CORRECTED_ON_TOP}'s record carried the wrong allowance`),
  record(REVERSED_ON_TOP, "limits_reduced", dayFromToday(-200), `${REVERSED_ON_TOP} lowered its free allowance from 50,000 to 20,000 requests a month`),
  reversed(record(REVERSED_ON_TOP, "free_tier_removed", dayFromToday(-20), `${REVERSED_ON_TOP} ended its free plan`)),
];

let scratch = "";
let server: ChildProcess | null = null;
let port = 0;

function startServer(indexPath: string, changesPath: string): Promise<ChildProcess> {
  return new Promise((resolve, reject) => {
    const child = spawn("node", [path.join(REPO, "dist", "serve.js")], {
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        PORT: "0",
        BASE_URL: "http://localhost",
        TZ: "UTC",
        AGENTDEALS_INDEX_PATH: indexPath,
        AGENTDEALS_CHANGES_PATH: changesPath,
      },
    });
    const timeout = setTimeout(() => { child.kill(); reject(new Error("Server startup timeout")); }, 60000);
    child.stderr!.on("data", (data: Buffer) => {
      const m = data.toString().match(/running on http:\/\/localhost:(\d+)/);
      if (m) { port = parseInt(m[1], 10); clearTimeout(timeout); resolve(child); }
    });
    child.on("error", (err) => { clearTimeout(timeout); reject(err); });
  });
}

async function vendorPage(vendor: string): Promise<string> {
  const res = await fetch(`http://localhost:${port}/vendor/${vendor.toLowerCase()}`);
  assert.strictEqual(res.status, 200, `/vendor/${vendor.toLowerCase()} did not render`);
  return res.text();
}

function bannerOf(html: string): string | null {
  return /<div class="change-notice"[\s\S]*?<\/div>/.exec(html)?.[0] ?? null;
}

const escaped = (text: string) => text.replace(/'/g, "&#39;");

before(async () => {
  scratch = mkdtempSync(path.join(tmpdir(), "vendor-banner-"));
  const indexPath = path.join(scratch, "index.json");
  const changesPath = path.join(scratch, "deal_changes.json");
  writeFileSync(indexPath, JSON.stringify({ offers: [ALL_RETRACTED, RETRACTED_ON_TOP, CORRECTED_ON_TOP, REVERSED_ON_TOP].map(offer) }));
  writeFileSync(changesPath, JSON.stringify({ ...liveLog, changes: [...liveLog.changes, ...RECORDS] }));
  server = await startServer(indexPath, changesPath);
});

after(() => {
  if (server) server.kill();
  if (scratch) rmSync(scratch, { recursive: true, force: true });
});

describe("the vendor page's pricing-change banner names a change the vendor made", () => {
  it("shows no banner when every record the vendor has is one we retracted, and still lists them, labelled, without the claims we withdrew", async () => {
    const html = await vendorPage(ALL_RETRACTED);
    assert.strictEqual(bannerOf(html), null, "the banner headlines a record we retracted");
    const withdrawn = RECORDS.filter((c) => c.vendor === ALL_RETRACTED);
    assert.strictEqual(html.split('<div class="change-item change-resolved').length - 1, withdrawn.length, "the history does not list every retracted row");
    for (const change of withdrawn) {
      assert.ok(!html.includes(escaped(change.summary)), `the page states the withdrawn claim "${change.summary}"`);
      assert.ok(html.includes(change.resolution.detail), "the history does not say what was wrong with the retracted row");
    }
    assert.ok(html.includes(RETRACTION_LABEL), "the history does not label the retracted rows");
  });

  it("shows the vendor's newest change, not a retraction dated after it", async () => {
    const banner = bannerOf(await vendorPage(RETRACTED_ON_TOP));
    assert.ok(banner, "a vendor whose newest change is a narrowing that is not its rating's cause shows no banner");
    assert.ok(banner.includes(escaped(NARROWING(RETRACTED_ON_TOP).summary)), `the banner does not name the vendor's narrowing: ${banner}`);
    assert.ok(!banner.includes(RETRACTION_LABEL), `the banner headlines a record we retracted: ${banner}`);
    assert.ok(!banner.includes(escaped(RETRACTED_REMOVAL.summary)), `the banner headlines a record we retracted: ${banner}`);
  });

  it("shows the vendor's newest change when a correction of our own is dated after it", async () => {
    const banner = bannerOf(await vendorPage(CORRECTED_ON_TOP));
    assert.ok(banner, "a correction of our own hides the vendor's newest change from the banner");
    assert.ok(banner.includes(escaped(NARROWING(CORRECTED_ON_TOP).summary)), `the banner does not name the vendor's narrowing: ${banner}`);
  });

  it("shows no banner when the vendor's newest change is one it has since reversed", async () => {
    const html = await vendorPage(REVERSED_ON_TOP);
    assert.strictEqual(bannerOf(html), null, "the banner warns of a change the vendor has undone");
    assert.ok(html.includes(escaped(`${REVERSED_ON_TOP} ended its free plan`)), "the history no longer lists the reversed change");
  });
});
