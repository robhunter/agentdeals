import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { deadlineTextsOf, statedDeadlines, type DeadlineText } from "../dist/stated-deadlines.js";
import type { DealChange } from "../src/types.ts";

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const TODAY = "2026-11-16";
const SOURCE = "https://docs.aws.amazon.com/workspaces-thin-client/latest/ug/workspacesthinclient-end-of-support.html";
const thinClient: DealChange = {
  vendor: "AWS", category: "Cloud IaaS", change_type: "product_deprecated", date: "2026-04-20",
  summary: "Amazon WorkSpaces Thin Client stopped accepting new customers on 2026-04-20. Existing Amazon WorkSpaces Thin Client customers can keep using their devices, and can still order more, until AWS ends support on 2027-03-31.",
  previous_state: "Available", current_state: "Support ending", impact: "low", alternatives: [],
  source_url: SOURCE, date_source: "hand_written", listing_effect: "none",
};
const bedrock: DealChange = {
  ...thinClient, date: "2027-03-30", category: "AI / ML",
  summary: "Amazon Bedrock removes 26 models on March 30, 2027.",
  source_url: "https://docs.aws.amazon.com/bedrock/latest/userguide/model-lifecycle-legacy.html",
};
const statedText = (extra: Partial<DeadlineText> = {}): DeadlineText => ({
  vendor: "AWS", category: "Cloud IaaS", text: "Support ends on 2027-03-31.",
  sourceUrl: SOURCE, statedIn: "description", ...extra,
});

describe("a nearby record replaces only a deadline with the same evidence", () => {
  it("keeps Thin Client support beside the unrelated Bedrock retirement", () => {
    const result = statedDeadlines(deadlineTextsOf([], [thinClient]), [bedrock], TODAY);
    assert.equal(result.length, 1);
    assert.equal(result[0].date, "2027-03-31");
    assert.equal(result[0].sentence, thinClient.summary.split(". ")[1]);
    assert.equal(result[0].sourceUrl, SOURCE);
    assert.equal(result[0].record, thinClient);
  });

  for (const [date, suppressed] of [["2027-03-29", false], ["2027-03-30", true], ["2027-03-31", true], ["2027-04-01", true], ["2027-04-02", false]] as const) {
    it(`uses the one-day window for a matching source dated ${date}`, () => {
      const result = statedDeadlines([statedText()], [{ ...bedrock, date, source_url: SOURCE }], TODAY);
      assert.equal(result.length, suppressed ? 0 : 1);
    });
  }

  for (const statedIn of ["condition", "description", "record"] as const) {
    it(`keeps a ${statedIn} deadline beside an unrelated same-day record`, () => {
      assert.equal(statedDeadlines([statedText({ statedIn })], [{ ...bedrock, date: "2027-03-31" }], TODAY).length, 1);
    });
  }

  it("does not match a source belonging to another vendor", () => {
    assert.equal(statedDeadlines([statedText()], [{ ...bedrock, vendor: "Another Cloud", source_url: SOURCE }], TODAY).length, 1);
  });

  it("does not treat absent or empty sources as matching evidence", () => {
    for (const sourceUrl of [null, ""]) {
      for (const source_url of [undefined, ""]) {
        assert.equal(statedDeadlines([statedText({ sourceUrl })], [{ vendor: "AWS", date: "2027-03-31", source_url }], TODAY).length, 1);
      }
    }
  });

  it("recognizes the originating record even without a source URL", () => {
    const ownRecord = { ...thinClient, date: "2027-03-31", source_url: "" };
    const texts = deadlineTextsOf([], [ownRecord]);
    assert.equal(statedDeadlines(texts, [ownRecord], TODAY).length, 0);
    assert.equal(statedDeadlines(texts, [{ ...ownRecord }], TODAY).length, 1);
    assert.equal(statedDeadlines(texts, [], TODAY).length, 1);
  });

  it("keeps the existing preference and adjacent-day text rules", () => {
    const texts = [
      statedText({ text: "The free plan ends on 2027-03-30." }),
      statedText(),
      statedText({ text: "The API retires on 2027-03-31.", statedIn: "condition" }),
    ];
    const result = statedDeadlines(texts, [], TODAY);
    assert.equal(result.length, 1);
    assert.equal(result[0].date, "2027-03-31");
    assert.equal(result[0].statedIn, "condition");
  });
});

async function withServer(changes: DealChange[], check: (get: (route: string) => Promise<string>) => Promise<void>) {
  const scratch = mkdtempSync(path.join(tmpdir(), "deadline-event-"));
  writeFileSync(path.join(scratch, "index.json"), JSON.stringify({ offers: [] }));
  writeFileSync(path.join(scratch, "changes.json"), JSON.stringify({ changes }));
  const server = spawn("node", ["--import", path.join(REPO, "scripts/shifted-clock.mjs"), path.join(REPO, "dist/serve.js")], {
    cwd: REPO, stdio: ["ignore", "ignore", "pipe"],
    env: { ...process.env, PORT: "0", BASE_URL: "http://localhost", TZ: "UTC", AGENTDEALS_REFERRAL_HEALTH: "off",
      AGENTDEALS_CLOCK_SHIFT_MS: String(Date.parse(`${TODAY}T12:00:00Z`) - Date.now()),
      AGENTDEALS_INDEX_PATH: path.join(scratch, "index.json"), AGENTDEALS_CHANGES_PATH: path.join(scratch, "changes.json") },
  });
  try {
    const base = await new Promise<string>((resolve, reject) => {
      let stderr = "";
      const timeout = setTimeout(() => reject(new Error("Server startup timeout")), 30000);
      server.stderr.on("data", chunk => {
        stderr += chunk.toString();
        const port = stderr.match(/running on http:\/\/localhost:(\d+)/)?.[1];
        if (port) { clearTimeout(timeout); resolve(`http://localhost:${port}`); }
      });
      server.on("error", error => { clearTimeout(timeout); reject(error); });
      server.on("exit", code => { clearTimeout(timeout); reject(new Error(`Server exited ${code}: ${stderr}`)); });
    });
    await check(async route => {
      const response = await fetch(base + route, { redirect: "error", headers: { "User-Agent": "agentdeals-internal-bot/1.0 deadline-test" } });
      assert.equal(response.status, 200, route);
      return response.text();
    });
  } finally {
    server.kill();
    await new Promise<void>(resolve => server.exitCode !== null ? resolve() : server.once("exit", () => resolve()));
    rmSync(scratch, { recursive: true, force: true });
  }
}

describe("deadline views retain separate events", () => {
  it("serves Thin Client exactly once beside Bedrock in HTML and JSON", async () => {
    await withServer([thinClient, bedrock], async get => {
      const html = await get("/deadlines");
      const cards = html.split(/<div class="dl-card[^\"]*">/).slice(1);
      const thin = cards.filter(card => card.includes("Thin Client"));
      assert.equal(cards.length, 2);
      assert.equal(thin.length, 1);
      assert.ok(thin[0].includes('<div class="dl-date">2027-03-31</div>'));
      assert.ok(thin[0].includes(`href="${SOURCE}"`));
      const { deadlines, count } = JSON.parse(await get("/api/deadlines"));
      assert.equal(count, 2);
      assert.deepEqual(deadlines.map((entry: { date: string }) => entry.date), ["2027-03-30", "2027-03-31"]);
      assert.equal(deadlines[1].record_date, thinClient.date);
      assert.equal(deadlines[1].source_url, SOURCE);
      assert.equal(deadlines[1].countdown_days, 135);
      const filtered = JSON.parse(await get("/api/deadlines?type=product_deprecated"));
      assert.equal(filtered.count, 2);
      const shutdowns = await get("/shutdowns");
      assert.equal((shutdowns.match(/<h3[^>]*>[\s\S]*?<\/h3>/g) ?? []).filter(heading => heading.includes("WorkSpaces Thin Client")).length, 1);
    });
  });

  it("serves a record's own stated deadline exactly once", async () => {
    const record = { ...thinClient, date: "2027-03-31" };
    await withServer([record], async get => {
      assert.equal((await get("/deadlines")).split(/<div class="dl-card[^\"]*">/).length - 1, 1);
      const { deadlines, count } = JSON.parse(await get("/api/deadlines"));
      assert.equal(count, 1);
      assert.equal(deadlines[0].date, record.date);
      assert.equal(deadlines[0].summary, record.summary);
    });
  });
});
