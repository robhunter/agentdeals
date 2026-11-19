import { before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createDocument } from "@mixmark-io/domino";
import { shutdownIndexNote } from "../dist/shutdown-index-note.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const expected = [
  [
    "pay-as-you-go API access to MiniMax-M2.7, MiniMax-M2.7-highspeed, MiniMax-M2.5 and MiniMax-M2.5-highspeed",
    "closed to new users since October 19, 2026"
  ],
  [
    "Azure OpenAI o-series model retirement",
    "closed to new customers"
  ],
  [
    "OpenAI Agent Builder, Evals platform and reusable prompts",
    "existing evals read-only since October 31, 2026"
  ],
  [
    "Zeabur",
    "no new dedicated servers or domains since October 17, 2026"
  ],
  [
    "AWS Infrastructure Composer's standalone console",
    "closed to new customers since October 29, 2026"
  ],
  [
    "Val Town",
    "no new signups or plan upgrades since November 10, 2026"
  ],
  [
    "Google Jules",
    "read-only since November 11, 2026"
  ],
  [
    "HCP Vagrant and the Vagrant Public Registry",
    "no new boxes or registries since October 1, 2026"
  ],
  [
    "AWS support plans: Developer, Business and Enterprise On-Ramp",
    "closed to new subscriptions since December 2, 2025"
  ],
  [
    "Google's Custom Search JSON API",
    "closed to new customers"
  ],
  [
    "creating fine-tuning jobs on OpenAI's self-serve platform",
    "since July 2, 2026 only organizations that used a fine-tuned model in the past 60 days can create jobs"
  ],
  [
    "Claude Opus 4.1 on Amazon Bedrock",
    "Legacy since July 8, 2026: closed to new customers"
  ],
  [
    "Heroku Postgres 15",
    "no new databases since November 11, 2026, except forks and followers"
  ],
  [
    "Google App Engine standard: Python 2.7, Java 8, PHP 5.5 and Go 1.11",
    "no deploys or redeploys since January 31, 2026"
  ],
  [
    "Twilio Notify",
    "closed to new customers since 2022"
  ],
  [
    "HubSpot's design manager serverless functions (/_hcms/api/)",
    "no new functions since November 3, 2026, no edits since November 17"
  ],
  [
    "26 Amazon Bedrock models from DeepSeek, Google, Meta, Mistral AI, Qwen and others",
    "Legacy since September 30, 2026: closed to new customers"
  ],
  [
    "AWS WorkSpaces Thin Client",
    "closed to new customers since April 20, 2026; existing customers can use it until then"
  ],
  [
    "Azure Cache for Redis Enterprise and Enterprise Flash tiers",
    "no new caches since April 1, 2026"
  ],
  [
    "Gadget",
    "no new apps since November 9, 2026; existing apps keep running until then"
  ],
  [
    "Python 3.10 on Cloud Functions for Firebase and Cloud Run functions",
    "Node.js 20 functions cannot be deployed since October 30, 2026"
  ],
  [
    "Claude Sonnet 4.5 on Amazon Bedrock",
    "Legacy since October 8, 2026: closed to new customers"
  ],
  [
    "Auth0 Hooks",
    "read-only since November 18, 2024"
  ],
  [
    "Heroku's Heroku-22 stack",
    "since November 1, 2026 the first build in each 30 days fails, and a retry deploys"
  ],
  [
    "Google Cloud Deployment Manager",
    "closed to new users since June 30, 2026; existing deployments can use it until then"
  ],
  [
    "Amazon DevOps Guru",
    "closed to new customers since October 29, 2026; existing customers can use it until then"
  ],
  [
    "Auth0 Rules",
    "read-only since November 18, 2024"
  ],
  [
    "Azure Cache for Redis Basic, Standard and Premium tiers",
    "since April 1, 2026 only tenants that already had a cache can create new ones"
  ],
  [
    "Azure Communication Services (ACS) standalone services",
    "since October 23, 2026 new customers cannot get SMS or calling numbers"
  ]
];
const pages = new Map<string, string>();
async function serve(day: string): Promise<string> {
  const child = spawn("node", ["--import", path.join(ROOT, "scripts/shifted-clock.mjs"), path.join(ROOT, "dist/serve.js")], {
    cwd: ROOT, stdio: ["ignore", "ignore", "pipe"], env: { ...process.env, TZ: "UTC", PORT: "0", BASE_URL: "http://localhost", AGENTDEALS_REFERRAL_HEALTH: "off", AGENTDEALS_CLOCK_SHIFT_MS: String(Date.parse(day + "T12:00:00Z") - Date.now()) },
  });
  try {
    const port = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => { child.kill(); reject(new Error("Server startup timeout")); }, 30000);
      child.stderr!.on("data", data => { const match = String(data).match(/running on http:\/\/localhost:(\d+)/); if (match) { clearTimeout(timer); resolve(match[1]); } });
      child.on("error", error => { clearTimeout(timer); reject(error); });
      child.on("exit", code => { clearTimeout(timer); reject(new Error(`Server exited ${code}`)); });
    });
    const response = await fetch(`http://localhost:${port}/shutdowns`, { redirect: "error" });
    assert.equal(response.status, 200);
    return response.text();
  } finally {
    if (child.exitCode === null && child.signalCode === null) { const exited = once(child, "exit"); child.kill(); await exited; }
  }
}
function entries(day: string): string[] {
  const document = createDocument(pages.get(day)!);
  return Array.from(document.querySelectorAll('[aria-labelledby="by-month"] .shutdown-month-entry')).map(n => n.textContent!);
}
before(async () => {
  for (const day of ["2026-11-17", "2026-11-20", "2026-11-21", "2027-01-29"]) pages.set(day, await serve(day));
});

describe("restrictions in the shutdown month index", () => {
  it("prints each current restriction once, on its card's first remaining entry", () => {
    const lines = entries("2026-11-17");
    for (const [service, note] of expected) {
      const own = lines.filter(line => line.startsWith(service + " (") || line.startsWith(service + ": "));
      assert.ok(own.length > 0, service);
      assert.ok(own[0].endsWith(`; ${note})`), own[0]);
      assert.equal(own.filter(line => line.includes(`; ${note})`)).length, 1, service);
    }
  });
  it("preserves unknown dates, year-only dates and existing-customer exceptions", () => {
    const lines = entries("2026-11-17");
    assert.ok(lines.includes("Google's Custom Search JSON API (January 1; closed to new customers)"));
    assert.ok(lines.some(line => line.startsWith("Twilio Notify (") && line.endsWith("; closed to new customers since 2022)")));
    for (const service of ["Amazon DevOps Guru", "AWS WorkSpaces Thin Client", "Gadget", "Google Cloud Deployment Manager"]) assert.ok(lines.some(line => line.startsWith(service + " (") && line.includes("until then)")), service);
  });
  it("removes a note when its last shutdown date has passed", () => {
    const twenty = entries("2026-11-20");
    assert.ok(!twenty.some(line => line.startsWith("Azure OpenAI o-series model retirement")));
    assert.ok(entries("2026-11-17").some(line => line.startsWith("Azure OpenAI o-series model retirement") && line.includes("closed to new customers")));
    assert.ok(!twenty.some(line => line.startsWith("Conductor Cloud") && line.includes("read-only since November 13, 2026")));
    assert.ok(!entries("2026-11-21").some(line => line.startsWith("Conductor Cloud")));
  });
  it("does not restate a restriction from a cancelled announcement", () => {
    assert.equal(shutdownIndexNote({ service: "Conductor Cloud", dateSource: "https://www.conductor.build/changelog/0.93.0-conductor-is-joining-meta", what: "It goes read-only on November 13, 2026: old chats can still be read and exported, but no new messages sent. Since November 4, 2026, new users cannot sign up or download the app." }, "2026-11-17"), "");
  });
  it("moves the single note to the next remaining stage", () => {
    const own = entries("2027-01-29").filter(line => line.startsWith("Heroku Postgres 15"));
    assert.equal(own.length, 1);
    assert.ok(own[0].endsWith("; no new databases since November 11, 2026, except forks and followers)"));
  });
  it("withholds a restriction when the source, service, evidence or known day does not match", () => {
    const entry = { service: "AWS WorkSpaces Thin Client", dateSource: "https://docs.aws.amazon.com/workspaces-thin-client/latest/ug/workspacesthinclient-end-of-support.html", what: "Closed to new customers since 2026-04-20. AWS ends support on 2027-03-31." };
    assert.ok(shutdownIndexNote(entry, "2026-11-17").includes("existing customers"));
    assert.equal(shutdownIndexNote(entry, "2026-04-19"), "");
    assert.equal(shutdownIndexNote({ ...entry, what: "Customers can sign up." }, "2026-11-17"), "");
    assert.equal(shutdownIndexNote({ ...entry, service: "Other product" }, "2026-11-17"), "");
    assert.equal(shutdownIndexNote({ ...entry, dateSource: "https://example.com/other" }, "2026-11-17"), "");
  });
});
