import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { generateReadme, readmeCensus, readmeRows } = await import(`${root}/dist/llm-api-readme.js`);
const { reverificationIntervalDays } = await import(`${root}/dist/badge-staleness.js`);

const args = process.argv.slice(2);
const asJson = args.includes("--json");
const check = args.includes("--check");
const onArg = args.find(a => a.startsWith("--on="));

const OUTPUT = process.env.AGENTDEALS_LLM_INDEX_PATH || path.join(root, "artifacts", "free-llm-api-index", "README.md");

const offers = JSON.parse(readFileSync(path.join(root, "data", "index.json"), "utf8")).offers;
const changes = JSON.parse(readFileSync(path.join(root, "data", "deal_changes.json"), "utf8")).changes;

const servedOn = onArg ? onArg.slice("--on=".length) : new Date().toISOString().slice(0, 10);
const nowMs = Date.parse(`${servedOn}T00:00:00Z`);
if (!Number.isFinite(nowMs)) {
  console.error(`Not a date: ${servedOn}`);
  process.exit(2);
}

const staleAfterDays = reverificationIntervalDays(offers.map(o => o.verifiedDate), nowMs);
const context = { servedOn, nowMs, staleAfterDays };
const rows = readmeRows(offers, changes, context);
const census = readmeCensus(rows);

if (rows.length === 0) {
  console.error("Refusing to publish: the catalogue produced no rows for the published categories.");
  process.exit(1);
}

const rendered = generateReadme(offers, changes, context);
const held = (() => {
  try {
    return readFileSync(OUTPUT, "utf8");
  } catch {
    return null;
  }
})();

const changed = held !== rendered;
if (check) {
  if (changed) {
    console.error(`${path.relative(root, OUTPUT)} is not what this data generates. Run: npm run generate:llm-readme`);
    process.exit(1);
  }
} else if (changed) {
  mkdirSync(path.dirname(OUTPUT), { recursive: true });
  writeFileSync(OUTPUT, rendered);
}

const outcome = { ...census, changed, staleAfterDays, on: servedOn };
if (asJson) {
  console.log(JSON.stringify(outcome));
} else {
  console.log(`${path.relative(root, OUTPUT)} — ${changed ? "regenerated" : "unchanged"}`);
  console.log(
    [
      `rows ${census.rows}`,
      `rated ${census.rated}`,
      `ended ${census.ended}`,
      `withheld ${census.withheld}`,
      `prior terms ${census.withPriorTerms}`,
      `caveated ${census.caveated}`,
      `stale after ${staleAfterDays}d`,
    ].join(", "),
  );
  for (const [reason, count] of Object.entries(census.withheldByReason).sort((a, b) => b[1] - a[1])) {
    console.log(`  withheld ${reason}: ${count}`);
  }
}
