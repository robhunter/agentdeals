import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { ROOT, heldIndex, indexPath, renderIndex, servedOnFrom } from "./llm-api-index-render.js";

const args = process.argv.slice(2);
const asJson = args.includes("--json");
const check = args.includes("--check");

const OUTPUT = indexPath();

let index;
try {
  index = await renderIndex(servedOnFrom(args));
} catch (error) {
  console.error(error.message);
  process.exit(2);
}

const { census, excludedByReason: leftOut, excluded, rendered, staleAfterDays, servedOn } = index;

if (census.rows === 0) {
  console.error("Refusing to publish: no catalogue record carries a subtype label this file selects on.");
  process.exit(1);
}

const held = heldIndex(OUTPUT);

const changed = held !== rendered;
if (check) {
  if (changed) {
    console.error(`${path.relative(ROOT, OUTPUT)} is not what this data generates. Run: npm run generate:llm-readme`);
    process.exit(1);
  }
} else if (changed) {
  mkdirSync(path.dirname(OUTPUT), { recursive: true });
  writeFileSync(OUTPUT, rendered);
}

const outcome = { ...census, excluded: excluded.length, excludedByReason: leftOut, changed, staleAfterDays, on: servedOn };
if (asJson) {
  console.log(JSON.stringify(outcome));
} else {
  console.log(`${path.relative(ROOT, OUTPUT)} — ${changed ? "regenerated" : "unchanged"}`);
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
  console.log(`left out ${excluded.length}`);
  for (const [reason, count] of Object.entries(leftOut).sort((a, b) => b[1] - a[1])) {
    console.log(`  left out ${reason}: ${count}`);
  }
}
