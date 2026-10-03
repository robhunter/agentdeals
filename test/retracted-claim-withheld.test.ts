import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { toSlug } from "../dist/slug.js";

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const TODAY = new Date().toISOString().slice(0, 10);

const liveLog = JSON.parse(readFileSync(path.join(REPO, "data", "deal_changes.json"), "utf8"));
const catalogue = JSON.parse(readFileSync(path.join(REPO, "data", "index.json"), "utf8"));
const vendorsWithARecord = new Set<string>(liveLog.changes.map((c: { vendor: string }) => c.vendor.toLowerCase()));
const [withdrawnOffer, reversedOffer] = catalogue.offers.filter(
  (o: { vendor: string }) => /^[A-Za-z][A-Za-z0-9 ]+$/.test(o.vendor) && !vendorsWithARecord.has(o.vendor.toLowerCase()),
);

const record = (offer: { vendor: string; category: string }, words: { summary: string; before: string; after: string }, resolution: object) => ({
  vendor: offer.vendor,
  change_type: "limits_increased",
  date: TODAY,
  date_source: "discovered",
  recorded_date: TODAY,
  summary: words.summary,
  previous_state: words.before,
  current_state: words.after,
  impact: "low",
  source_url: "https://example.com/pricing",
  category: offer.category,
  alternatives: [],
  resolution,
});

const WITHDRAWN_WORDS = {
  summary: "The free plan now gives seventy-seven thousand widget runs a month.",
  before: "Free plan with eleven thousand widget runs a month.",
  after: "Free plan with seventy-seven thousand widget runs a month.",
};
const WITHDRAWAL_DETAIL = `Retracted ${TODAY}: the page states that allowance for the paid plan, and the free plan's is unchanged.`;
const WITHDRAWN = record(withdrawnOffer, WITHDRAWN_WORDS, { state: "retracted", date: TODAY, detail: WITHDRAWAL_DETAIL });

const REVERSED_WORDS = {
  summary: "The free plan now gives thirty-three thousand gadget runs a month.",
  before: "Free plan with twenty-two thousand gadget runs a month.",
  after: "Free plan with thirty-three thousand gadget runs a month.",
};
const REVERSED = record(reversedOffer, REVERSED_WORDS, { state: "reversed", date: TODAY, detail: "Reversed: the free plan is back at twenty-two thousand gadget runs." });

const scratch = mkdtempSync(path.join(tmpdir(), "retracted-claim-"));
const changesPath = path.join(scratch, "deal_changes.json");
writeFileSync(changesPath, JSON.stringify({ ...liveLog, changes: [...liveLog.changes, WITHDRAWN, REVERSED] }));

function serve(): Promise<{ child: ChildProcess; port: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn("node", [path.join(REPO, "dist", "serve.js")], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, PORT: "0", BASE_URL: "http://localhost", TZ: "UTC", AGENTDEALS_CHANGES_PATH: changesPath },
    });
    const timeout = setTimeout(() => { child.kill(); reject(new Error("Server startup timeout")); }, 60000);
    child.stderr!.on("data", (data: Buffer) => {
      const m = data.toString().match(/running on http:\/\/localhost:(\d+)/);
      if (m) { clearTimeout(timeout); resolve({ child, port: parseInt(m[1], 10) }); }
    });
    child.on("error", (e) => { clearTimeout(timeout); reject(e); });
  });
}

describe("a record we retracted says it was our error and what was wrong, and never states the claim it withdrew", () => {
  let server: ChildProcess;
  let port = 0;
  const get = async (route: string) => {
    const res = await fetch(`http://localhost:${port}${route}`);
    assert.strictEqual(res.status, 200, `${route} answered ${res.status}`);
    return res.text();
  };

  before(async () => {
    assert.ok(withdrawnOffer && reversedOffer, "the catalogue holds no two vendors without a change record");
    ({ child: server, port } = await serve());
  });

  after(() => {
    server?.kill();
    rmSync(scratch, { recursive: true, force: true });
  });

  const pages = () => [`/vendor/${toSlug(withdrawnOffer.vendor)}`, "/pricing-changes", "/changes", "/pricing-changes/feed.xml"];

  it("states the retraction, its date and its detail on every page that lists the record", async () => {
    for (const route of pages()) {
      const body = await get(route);
      assert.ok(body.includes(`this record was our error (${TODAY})`), `${route} does not say the record was our error`);
      assert.ok(body.includes(WITHDRAWAL_DETAIL.slice(0, 60)), `${route} does not say what was wrong with the record`);
    }
  });

  it("states neither the withdrawn summary nor its before and after on any of them", async () => {
    for (const route of pages()) {
      const body = await get(route);
      for (const words of Object.values(WITHDRAWN_WORDS)) {
        assert.ok(!body.includes(words), `${route} states the withdrawn words "${words}"`);
      }
    }
  });

  it("still states the claim and the before and after of a change the vendor reversed", async () => {
    for (const route of [`/vendor/${toSlug(reversedOffer.vendor)}`, "/pricing-changes"]) {
      const body = await get(route);
      for (const words of Object.values(REVERSED_WORDS)) {
        assert.ok(body.includes(words), `${route} no longer states "${words}"`);
      }
    }
  });

  it("serves the retracted record on request with the same summary, and keeps its stored states as data", async () => {
    const served = JSON.parse(await get(`/api/changes?vendor=${encodeURIComponent(withdrawnOffer.vendor)}&include_retracted=true`));
    const withdrawn = served.changes.find((c: { date: string; vendor: string }) => c.vendor === withdrawnOffer.vendor && c.date === TODAY);
    assert.ok(withdrawn, "/api/changes does not serve the retracted record when asked to");
    assert.strictEqual(withdrawn.summary, `Retracted — this record was our error (${TODAY}). ${WITHDRAWAL_DETAIL}`);
    assert.strictEqual(withdrawn.standing, "retracted");
    assert.strictEqual(withdrawn.current_state, WITHDRAWN_WORDS.after);
  });
});
