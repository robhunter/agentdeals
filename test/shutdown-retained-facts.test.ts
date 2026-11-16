import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createDocument } from "@mixmark-io/domino";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const facts: Array<[string, string[]]> = [
  ["AWS App Runner (New Customers)", ["Existing customers can keep using it as normal, including creating new services.", "no new features", "ECS Express Mode"]],
  ["HubSpot Contact Lists API v1", ["Contact Lists API v1 endpoints return HTTP 404.", "its current migration guide lists them as returning 404 too", "Six Contacts API v1 read endpoints", "still work but no longer return list memberships", "visitor ID, email address or user token", "legacyListId"]],
  ["OpenAI Realtime API Beta", ["OpenAI-Beta: realtime=v1", "The GA Realtime API was not affected.", "/v1/realtime/client_secrets"]],
  ["OpenAI DALL·E Model Snapshots", ["POST /v1/images/generations", "leave out the model parameter", "default to dall-e-2 unless a parameter specific to the GPT image models is used", "image variations endpoint, which supports only dall-e-2", "base64-encoded images only"]],
  ["OpenAI legacy model snapshots", ["gpt-4-1106-preview", "fine-tuned versions", "March 26, 2026", "Replacement base models for fine-tunes", "do not support fine-tuning or the legacy /v1/completions endpoint"]],
  ["Firebase Studio (New Workspaces)", ["New workspace creation and user signup", "Existing workspaces keep working until March 22, 2027.", "Google Antigravity"]],
  ["Tenor API", ["Tenor.com, the GIF Keyboard apps and Gboard still serve Tenor GIFs", "Every Tenor API request fails with an error", "Tenor-compatible v2 endpoints"]],
  ["Gemini 2.0 Flash", ["Image generation via 2.0 Flash shut down November 14, 2025", "gemini-2.0-flash and gemini-2.0-flash-lite model IDs no longer work", "gemini-3.6-flash", "gemini-3.1-flash-lite"]],
  ["OpenAI Assistants API", ["Assistants, Threads, Runs, and Messages endpoints removed", "code interpreter, file search, and persistent assistants", "Responses API and the Conversations API", "v1/prompts API"]],
  ["OpenAI Videos API (Sora)", ["POST /v1/videos", "sora-2 and sora-2-pro models, including their dated snapshots", "No direct OpenAI replacement"]],
  ["OpenAI legacy GPT models (September 2026)", ["ft-babbage-002, ft-davinci-002", "gpt-3.5-turbo-instruct, babbage-002 and davinci-002 run on the legacy Completions endpoint (/v1/completions).", "Chat Completions or Responses API"]],
  ["Firebase Studio (Full Shutdown)", ["all workspaces deleted, data removed", "All remaining Firebase Studio data permanently deleted", "Apps already deployed to Firebase keep running."]],
  ["AWS WorkSpaces Thin Client", ["they cannot connect to Amazon WorkSpaces or be managed in the console", "existing customers can use them as normal and can still buy devices", "The WorkSpaces themselves keep working."]],
  ["Node.js 20 AWS Lambda Runtime", ["Functions keep running; AWS never blocks invocations.", "creating functions from 2027-07-29 and updating them from 2027-08-31", "nodejs22.x", "nodejs24.x", "nodejs26.x"]],
  ["Google Maps Platform Client IDs", ["published no final termination date", "increase in frequency and duration", "Service usually returns within a few hours", "project Owners or Editors", "unpausing the client ID in the Cloud Console", "Support for a temporary exemption", "Switch to API key authentication"]],
  ["AWS Fargate Platform Version 1.3.0", ["ECS Fargate tasks on PV 1.3.0 will fail to launch", "Platform Version 1.4.0+", "networking and storage behavior changes"]],
  ["AWS App Mesh", ["no longer be able to access the AWS App Mesh console or AWS App Mesh resources", "ECS/EKS", "Amazon ECS Service Connect"]],
  ["AWS Proton", ["Proton console and Proton resources are no longer accessible", "Deployed CloudFormation stacks and the resources they manage keep running.", "CloudFormation Git Sync"]],
];
const cards = new Map<string, Element>();
const scratch = mkdtempSync(path.join(tmpdir(), "shutdown-retained-facts-"));

async function readCardsAt(day: string): Promise<Map<string, Element>> {
  const read = new Map<string, Element>();
  writeFileSync(path.join(scratch, "index.json"), JSON.stringify({ offers: [] }));
  writeFileSync(path.join(scratch, "changes.json"), JSON.stringify({ changes: [] }));
  const child = spawn(process.execPath, ["--import", path.join(ROOT, "scripts/shifted-clock.mjs"), path.join(ROOT, "dist/serve.js")], {
    cwd: ROOT, stdio: ["ignore", "ignore", "pipe"],
    env: { ...process.env, TZ: "UTC", PORT: "0", BASE_URL: "http://localhost", AGENTDEALS_REFERRAL_HEALTH: "off",
      AGENTDEALS_INDEX_PATH: path.join(scratch, "index.json"), AGENTDEALS_CHANGES_PATH: path.join(scratch, "changes.json"),
      AGENTDEALS_CLOCK_SHIFT_MS: String(Date.parse(`${day}T12:00:00Z`) - Date.now()) },
  });
  try {
    const port = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => { child.kill(); reject(new Error("Server startup timeout")); }, 30_000);
      let stderr = "";
      child.stderr.on("data", chunk => {
        stderr += String(chunk);
        const match = stderr.match(/running on http:\/\/localhost:(\d+)/);
        if (match) { clearTimeout(timer); resolve(match[1]); }
      });
      child.on("error", error => { clearTimeout(timer); reject(error); });
      child.on("exit", code => { clearTimeout(timer); reject(new Error(`Server exited with code ${code}: ${stderr}`)); });
    });
    const response = await fetch(`http://localhost:${port}/shutdowns`, { redirect: "error" });
    assert.equal(response.status, 200);
    for (const card of createDocument(await response.text()).querySelectorAll(".shutdown-card")) read.set(card.querySelector("h3")!.textContent!, card);
  } finally {
    if (child.exitCode === null && child.signalCode === null) { const exited = once(child, "exit"); child.kill(); await exited; }
  }
  return read;
}
before(async () => {
  for (const [service, card] of await readCardsAt("2027-11-01")) cards.set(service, card);
});
after(() => rmSync(scratch, { recursive: true, force: true }));

describe("hand-typed shutdown facts after the detail window", () => {
  it("keeps all eighteen cards while omitting their audience and impact rows", () => {
    assert.equal(cards.size, 18);
    assert.deepEqual([...cards.keys()].sort(), facts.map(([service]) => service).sort());
    for (const card of cards.values()) assert.deepEqual([...card.querySelectorAll(".detail-label")].map(label => label.textContent), ["Migration path:"]);
  });

  for (const [service, expected] of facts) it(`retains ${service} qualifiers in the description or migration path`, () => {
    const card = cards.get(service);
    assert.ok(card, service);
    const retained = card.querySelector(".shutdown-what")!.textContent + " " + [...card.querySelectorAll(".detail-row")].map(row => row.textContent).join(" ");
    for (const sentence of expected) assert.ok(retained.includes(sentence), `${service}: ${sentence}`);
  });
});


describe("shutdown descriptions when detail rows disappear", () => {
  it("adds Proton's omitted facts only after day ninety", async () => {
    const sentence = "Deployed CloudFormation stacks and the resources they manage keep running.";
    const atBoundary = (await readCardsAt("2027-01-05")).get("AWS Proton")!;
    const afterBoundary = (await readCardsAt("2027-01-06")).get("AWS Proton")!;
    assert.equal(atBoundary.querySelectorAll(".detail-row").length, 3);
    assert.ok(!atBoundary.querySelector(".shutdown-what")!.textContent!.includes(sentence));
    assert.equal(atBoundary.textContent!.split(sentence).length - 1, 1);
    assert.deepEqual([...afterBoundary.querySelectorAll(".detail-label")].map(label => label.textContent), ["Migration path:"]);
    assert.ok(afterBoundary.querySelector(".shutdown-what")!.textContent!.includes(sentence));
    assert.equal(afterBoundary.textContent!.split(sentence).length - 1, 1);
  });

  it("keeps retained sentences in their visible rows exactly once", async () => {
    const current = await readCardsAt("2026-11-16");
    for (const [service, sentence] of [
      ["AWS Proton", "Deployed CloudFormation stacks and the resources they manage keep running."],
      ["AWS App Mesh", "After September 30, 2026, you will no longer be able to access the AWS App Mesh console or AWS App Mesh resources."],
      ["OpenAI legacy GPT models (September 2026)", "gpt-3.5-turbo-instruct, babbage-002 and davinci-002 run on the legacy Completions endpoint (/v1/completions)."],
      ["OpenAI Videos API (Sora)", "Developers using the Videos API (POST /v1/videos and the other /v1/videos endpoints) and the sora-2 and sora-2-pro models, including their dated snapshots."],
      ["OpenAI Assistants API", "code interpreter, file search, and persistent assistants"],
      ["Firebase Studio (Full Shutdown)", "All remaining Firebase Studio data permanently deleted"],
      ["AWS WorkSpaces Thin Client", "After 2027-03-31 the devices stop working"],
      ["Node.js 20 AWS Lambda Runtime", "Functions keep running; AWS never blocks invocations."],
    ]) {
      const card = current.get(service)!;
      assert.equal(card.querySelectorAll(".detail-row").length, 3, service);
      assert.equal(card.textContent!.split(sentence).length - 1, 1, service);
    }
  });

  it("leads the completed App Runner description with the existing-customer allowance", async () => {
    const card = (await readCardsAt("2026-11-16")).get("AWS App Runner (New Customers)")!;
    const what = card.querySelector(".shutdown-what")!.textContent!;
    assert.ok(what.startsWith("Existing customers can keep using it as normal, including creating new services."));
    assert.ok(what.includes("App Runner closed to new customers"));
    assert.equal(what.split("Existing customers can keep using it as normal, including creating new services.").length - 1, 1);
  });
});
