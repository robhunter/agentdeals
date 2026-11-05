import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import assert from "node:assert/strict";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const indexPath = join(root, "data/index.json");
const reviewsPath = join(root, "data/page-reviews.json");
const originals = new Map([indexPath, reviewsPath].map(path => [path, readFileSync(path)]));
const supplied = process.argv.indexOf("--index");
const index = JSON.parse(supplied < 0 ? originals.get(indexPath) : readFileSync(process.argv[supplied + 1], "utf8"));
if (supplied < 0) {
  for (const offer of index.offers) {
    offer.conditions?.forEach((condition, at) => { if (at % 2 === 1) condition.operating_detail = true; else delete condition.operating_detail; });
  }
}
const mixed = index.offers.filter(offer => offer.conditions?.some(c => c.operating_detail === true) && offer.conditions.some(c => c.operating_detail !== true));
assert.ok(mixed.length >= 3, "the fixture has mixed conditions on several vendors");
const env = { ...process.env, TZ: "UTC", AGENTDEALS_INDEX_PATH: indexPath, AGENTDEALS_PAGE_REVIEWS_PATH: reviewsPath, AGENTDEALS_API_URL: "http://tests-start-their-own-api.invalid", AGENTDEALS_REFERRAL_HEALTH: "off" };
delete env.TEST_SHARD;
const files = readdirSync(join(root, "test")).filter(name => name.endsWith(".test.ts")).filter(name => {
  const source = readFileSync(join(root, "test", name), "utf8");
  return /withoutItsOwnConditions|plainConditionsByVendor|SoftwareApplication|nodeDescriptionOf|groq|mistral|gemini|xai|ollama|deepseek/i.test(source)
    || /^(?:conditions-|page-data-provenance|page-lastmod|change-entry-date-provenance)/.test(name);
}).sort();
const run = args => {
  const result = spawnSync(process.execPath, args, { cwd: root, env, stdio: "inherit" });
  assert.equal(result.status, 0, `${args.join(" ")} failed`);
};
try {
  writeFileSync(indexPath, JSON.stringify(index));
  console.log(`Marked-condition fixture: ${mixed.length} mixed listings; ${files.length} test files.`);
  run(["scripts/sync-page-reviews.js"]);
  run(["--test", "--test-concurrency=1", ...files.map(name => `test/${name}`)]);
} finally {
  for (const [path, bytes] of originals) writeFileSync(path, bytes);
}
