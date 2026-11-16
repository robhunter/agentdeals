import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const LAUNCH = "https://devcommunity.x.com/t/announcing-the-launch-of-x-api-pay-per-use-pricing/256476";
const BASIC = "https://devcommunity.x.com/t/important-update-legacy-x-api-basic-plans-are-moving-to-pay-per-use-ppu/266305";
const PRO = "https://devcommunity.x.com/t/important-update-legacy-x-api-pro-plans-are-moving-to-pay-per-use-ppu/273255";
let server: ChildProcess;
let html: string;
let story: string;
let text: string;

before(async () => {
  server = spawn(process.execPath, [path.join(REPO, "dist/serve.js")], {
    cwd: REPO,
    env: { ...process.env, PORT: "0", BASE_URL: "http://localhost", TZ: "UTC" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const port = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => { server.kill(); reject(new Error("Server startup timeout")); }, 30000);
    server.stderr!.on("data", (data: Buffer) => {
      const match = data.toString().match(/running on http:\/\/localhost:(\d+)/);
      if (match) { clearTimeout(timer); resolve(match[1]); }
    });
    server.on("error", (error) => { clearTimeout(timer); reject(error); });
  });
  const response = await fetch(`http://localhost:${port}/q1-2026-developer-pricing-report`);
  assert.equal(response.status, 200);
  html = await response.text();
  const cards = [...html.matchAll(/<div class="story-card">([\s\S]*?)<\/div>/g)];
  const matches = cards.filter((match) => match[1].includes("<h3>X (Twitter) API Paywall</h3>"));
  assert.equal(matches.length, 1);
  story = matches[0][1];
  text = story.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
});

after(() => { server?.kill(); });

describe("The Q1 X API story distinguishes the free-tier end from later paid-plan transitions", () => {
  it("dates the Pay-Per-Use launch and states request billing without a monthly fee", () => {
    assert.ok(text.includes("On February 6, 2026, X launched Pay-Per-Use pricing for its API, charging per request with no fixed monthly fee, and ended its Legacy Free tier."));
  });

  it("qualifies the voucher by recent activity and preserves the Public Utility Apps exception", () => {
    assert.ok(text.includes("Recently active free-tier users transitioned to Pay-Per-Use with a one-time $10 voucher; only Public Utility Apps retained free access."));
  });

  it("dates Basic and Pro transitions separately from the February launch", () => {
    assert.ok(text.includes("Basic plans to Pay-Per-Use after June 1, 2026"));
    assert.ok(text.includes("Pro plans after September 1, 2026"));
  });

  it("links each transition to its own announcement with citation attributes", () => {
    for (const url of [LAUNCH, BASIC, PRO]) {
      const anchors = [...story.matchAll(/<a\b([^>]+)>([\s\S]*?)<\/a>/g)]
        .filter((match) => match[1].includes(`href="${url}"`));
      assert.equal(anchors.length, 1, url);
      assert.match(anchors[0][1], /class="change-source"/);
      assert.match(anchors[0][1], /rel="nofollow noopener"/);
      assert.ok(!anchors[0][1].includes(" title="));
    }
  });

  it("withdraws the obsolete current Basic price while retaining the other stories", () => {
    assert.ok(!html.includes("moving to $200/month for basic access"));
    assert.ok(!story.includes("$200"));
    assert.ok(html.includes("HashiCorp discontinued the legacy HCP Terraform free plan on March 31."));
    assert.equal([...html.matchAll(/<div class="story-card">/g)].length, 7);
  });
});
