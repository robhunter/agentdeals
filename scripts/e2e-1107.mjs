#!/usr/bin/env node

/**
 * End-to-end check of the change gate against the real vendor pages.
 *
 * Fetches each vendor's page over the network, replays the detection the
 * model produced for it, and asserts what the run writes to a throwaway
 * change log. Needs no credential — the second opinion is stubbed, so this
 * exercises the fetch, the price-signal read, the gate and the writer.
 *
 * Usage:
 *   node scripts/e2e-1107.mjs
 */

import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { runAiMode } from "./reverify-rolling.js";
import { REJECT_NO_PRICE_SIGNAL, REJECT_UNQUANTIFIED_LIMIT } from "./change-gate.js";

const CASES = [
  {
    vendor: "Thunder Client",
    url: "https://www.thunderclient.com",
    description:
      "Lightweight REST API client for VS Code. Free tier includes collections, environments, local storage, and request history. No account required for local use. Premium ($10/yr) adds cloud sync and team collaboration",
    detection: {
      status: "changed",
      change_type: "pricing_model_change",
      summary:
        "The pricing information has changed. The page no longer explicitly mentions a free tier. It highlights Git Sync for team collaboration, which was previously a premium feature.",
      current_state:
        "The page describes Thunder Client as a lightweight REST API client with local storage and Git Sync for team collaboration. It does not mention a free or premium tier, or any pricing.",
      impact: "high",
    },
    expect: { recorded: 0, reason: REJECT_NO_PRICE_SIGNAL },
  },
  {
    vendor: "Doczilla",
    url: "https://www.doczilla.app/",
    description:
      "SaaS API empowering the generation of screenshots or PDFs directly from HTML/CSS/JS code. The free plan allows 250 documents month.",
    detection: {
      status: "changed",
      change_type: "limits_increased",
      summary:
        "The pricing page states there are 'no strict limits' on the number of documents or screenshots, contradicting the stored information of a 250 documents/month limit.",
      current_state: "There are no strict limits to the number of documents or screenshots that can be generated.",
      impact: "high",
    },
    expect: { recorded: 0, reason: REJECT_NO_PRICE_SIGNAL },
  },
  {
    vendor: "Harness CI",
    url: "https://www.harness.io/pricing",
    description:
      "CI/CD platform — free plan: 2,000 Harness Cloud build credits/month (Linux, macOS, Windows runners), YAML pipelines, secrets management, test intelligence. Requires business email for cloud runners; self-hosted runner alternative available",
    detection: {
      status: "changed",
      change_type: "limits_reduced",
      summary:
        "The free plan now has significantly reduced limits compared to the stored information. The stored info stated 2,000 build credits/month, while the current page details limits for concurrent pipeline executions (up to 60), storage (250GB), and organizations (up to 1).",
      current_state:
        "Free Plan is available for individual developers and small teams. It includes up to 60 concurrent pipeline executions, 250GB storage, up to 1 organization, up to 500 maximum users, up to 5 custom dashboards, unlimited templates, up to 5 custom roles, and policy as code.",
      impact: "high",
    },
    expect: { recorded: 0, reason: REJECT_UNQUANTIFIED_LIMIT },
  },
  {
    vendor: "FreeIPAPI",
    url: "https://freeipapi.com",
    description:
      "Free, Fast and Reliable IP Geolocation API for commercial and non-commercial users available in JSON",
    detection: {
      status: "changed",
      change_type: "limits_reduced",
      summary:
        "While a free tier still exists, it is limited to 60 requests per minute. Paid tiers are now available with higher limits and additional features.",
      current_state:
        "FreeIPAPI is still FREE with no account required! We're introducing subscriptions for users who want to increase the request limit to more than 60 requests per minute. The free tier includes 60 Requests per minute.",
      impact: "medium",
    },
    expect: { recorded: 1, reason: null },
  },
  {
    vendor: "DB-IP",
    url: "https://db-ip.com/api/free",
    description: "Free IP geolocation API with 1k request per IP per day.lite database under the CC-BY 4.0 License is free too.",
    detection: {
      status: "changed",
      change_type: "limits_reduced",
      summary: "The free tier now has a limit of 500 daily requests, down from 1k.",
      current_state: "The Free API is limited to 500 daily requests.",
      impact: "medium",
    },
    expect: { recorded: 1, reason: null },
  },
];

let failures = 0;

function check(label, actual, expected) {
  const ok = actual === expected;
  if (!ok) failures++;
  console.log(`  ${ok ? "✓" : "✗"} ${label}: ${JSON.stringify(actual)}${ok ? "" : ` (expected ${JSON.stringify(expected)})`}`);
}

for (const testCase of CASES) {
  const offer = {
    vendor: testCase.vendor,
    category: "Dev Utilities",
    tier: "Free",
    description: testCase.description,
    url: testCase.url,
    verifiedDate: "2026-01-01",
  };
  const dir = mkdtempSync(path.join(tmpdir(), "e2e-1107-"));
  const changesPath = path.join(dir, "deal_changes.json");
  writeFileSync(changesPath, JSON.stringify({ changes: [] }, null, 2) + "\n");

  console.log(`${testCase.vendor} — ${testCase.url}`);
  const result = await runAiMode([{ index: 0, offer }], { offers: [{ ...offer }] }, false, new Date(), {
    verifyFn: async () => testCase.detection,
    confirmFn: async () => ({ verdict: "yes", reason: null }),
    rateLimitMs: 0,
    changesPath,
  });

  if (result.flagged > 0) {
    console.log(`  ! the page could not be read, so this case proved nothing`);
    failures++;
  }
  check("records written", JSON.parse(readFileSync(changesPath, "utf-8")).changes.length, testCase.expect.recorded);
  check("refusal reason", result.rejected[0]?.reason ?? null, testCase.expect.reason);
  rmSync(dir, { recursive: true, force: true });
}

console.log(`\n${failures === 0 ? "all cases behaved as expected" : `${failures} check(s) failed`}`);
process.exit(failures === 0 ? 0 : 1);
