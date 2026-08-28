#!/usr/bin/env node

/**
 * End-to-end check that a record read from a page about other companies is
 * refused, and that its offer keeps the verified date it had.
 *
 * Fetches each page over the network and runs the real re-verification path.
 * Needs no credential — the model and the second opinion are stubbed, so this
 * exercises the fetch, the naming read, the gate, the writer and the marker
 * written back to the record.
 *
 * Usage:
 *   node scripts/e2e-1109.mjs
 */

import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { runAiMode } from "./reverify-rolling.js";
import { REJECT_PAGE_NOT_ABOUT_VENDOR } from "./change-gate.js";
import { SOURCE_CHECK_OK, SOURCE_CHECK_NOT_NAMED } from "./vendor-naming.js";

const CASES = [
  {
    vendor: "Cloudways",
    url: "https://www.joinsecret.com/offers",
    description: "30% off for 3 months. Access via: First deal free, then 99€/year or invite friends",
    detection: {
      status: "changed",
      change_type: "limits_reduced",
      summary:
        "The offer has been reduced: the page now shows a first deal free, then 99€/year, rather than 30% off for 3 months.",
      current_state: "First deal free, then 99€/year or invite friends.",
      impact: "high",
    },
    expect: { recorded: 0, reason: REJECT_PAGE_NOT_ABOUT_VENDOR, outcome: SOURCE_CHECK_NOT_NAMED, dateMoves: false },
  },
  {
    vendor: "Aircall",
    url: "https://brex.com/rewards/",
    description: "2 months free. Access via: Free for Brex customers",
    detection: {
      status: "changed",
      change_type: "free_tier_removed",
      summary: "The rewards page no longer offers 2 months free and instead advertises up to 7x points.",
      current_state: "Earn up to 7x points on purchases and redeem for business-building rewards.",
      impact: "high",
    },
    expect: { recorded: 0, reason: REJECT_PAGE_NOT_ABOUT_VENDOR, outcome: SOURCE_CHECK_NOT_NAMED, dateMoves: false },
  },
  {
    vendor: "Cloudways",
    url: "https://www.joinsecret.com/cloudways",
    description: "30% off for 3 months. Access via: First deal free, then 99€/year or invite friends",
    detection: {
      status: "confirmed",
    },
    expect: { recorded: 0, reason: null, outcome: SOURCE_CHECK_OK, dateMoves: true },
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
        "While a free tier still exists, it is limited to 60 requests per minute. Paid tiers are now available with higher limits.",
      current_state:
        "FreeIPAPI is still FREE with no account required, with the free tier limited to 60 requests per minute.",
      impact: "medium",
    },
    expect: { recorded: 1, reason: null, outcome: SOURCE_CHECK_OK, dateMoves: false },
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
    category: "Startup Perks",
    tier: "Startup Program",
    description: testCase.description,
    url: testCase.url,
    verifiedDate: "2026-01-01",
  };
  const dir = mkdtempSync(path.join(tmpdir(), "e2e-1109-"));
  const changesPath = path.join(dir, "deal_changes.json");
  writeFileSync(changesPath, JSON.stringify({ changes: [] }, null, 2) + "\n");

  console.log(`${testCase.vendor} — ${testCase.url}`);
  const data = { offers: [{ ...offer }] };
  const result = await runAiMode([{ index: 0, offer }], data, false, new Date(), {
    verifyFn: async () => testCase.detection,
    confirmFn: async () => ({ verdict: "yes", reason: null }),
    rateLimitMs: 0,
    changesPath,
  });

  if (result.flagged > 0) {
    console.log("  ! the page could not be read, so this case proved nothing");
    failures++;
  }
  check("records written", JSON.parse(readFileSync(changesPath, "utf-8")).changes.length, testCase.expect.recorded);
  check("refusal reason", result.rejected[0]?.reason ?? null, testCase.expect.reason);
  check("source outcome", data.offers[0].source_check?.outcome ?? null, testCase.expect.outcome);
  check("verified date moved", data.offers[0].verifiedDate !== "2026-01-01", testCase.expect.dateMoves);
  rmSync(dir, { recursive: true, force: true });
}

console.log(`\n${failures === 0 ? "all cases behaved as expected" : `${failures} check(s) failed`}`);
process.exit(failures === 0 ? 0 : 1);
