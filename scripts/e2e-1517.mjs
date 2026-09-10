#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { runAiMode, summaryLines } from "./reverify-rolling.js";
import { fetchPageText } from "./verify-freshness.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const INDEX_PATH = resolve(__dirname, "..", "data", "index.json");

const PAGE = process.argv[2] ?? "https://www.scraperapi.com/pricing/";

const READING_THE_RUN_GOT = {
  status: "changed",
  change_type: "limits_increased",
  summary: "The free tier now offers 5,000 API credits and a 7-day trial instead of 1,000 credits/month.",
  current_state: "Start collecting data with our 7-day trial and 5,000 API credits. No credit card required.",
  impact: "medium",
};

const data = JSON.parse(readFileSync(INDEX_PATH, "utf-8"));
const index = data.offers.findIndex((offer) => offer.url === PAGE);
if (index === -1) {
  console.error(`No catalogue record cites ${PAGE}`);
  process.exit(2);
}
const offer = data.offers[index];

console.log(`Re-reading ${offer.vendor} at ${offer.url}`);
console.log(`The catalogue holds: ${offer.description}`);
console.log(`The reading being replayed: ${READING_THE_RUN_GOT.change_type} — ${READING_THE_RUN_GOT.current_state}`);
console.log("");

const now = new Date();
const result = await runAiMode([{ index, offer }], data, true, now, {
  fetchFn: fetchPageText,
  verifyFn: async () => READING_THE_RUN_GOT,
  confirmFn: async () => ({ verdict: "yes", reason: "replayed" }),
  rateLimitMs: 0,
});

for (const line of summaryLines(result, {
  useAi: true,
  checked: 1,
  oldestRemaining: null,
  total: data.offers.length,
})) {
  console.log(line);
}

console.log("");
console.log(`Records this run would write to data/deal_changes.json: ${result.recorded.length}`);
process.exit(result.recorded.length === 0 ? 0 : 1);
