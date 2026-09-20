import { readFileSync, writeFileSync } from "node:fs";
import { deprecationEndsTheListedProduct, discontinuationDateStatedInText, DISCONTINUATION_DATE_UNRESOLVED } from "../dist/product-deprecation.js";

const PATH = new URL("../data/deal_changes.json", import.meta.url);

const READ_FROM_THE_RECORD = new Map([
  ["smartlook.com", "2027-09-30"],
]);

const data = JSON.parse(readFileSync(PATH, "utf-8"));

const withField = [];
for (const change of data.changes) {
  if (!deprecationEndsTheListedProduct(change)) continue;
  if (change.discontinued_date !== undefined) continue;
  const stated = READ_FROM_THE_RECORD.get(change.vendor) ?? discontinuationDateStatedInText(change);
  const value = stated ?? DISCONTINUATION_DATE_UNRESOLVED;
  const rebuilt = {};
  for (const [key, held] of Object.entries(change)) {
    rebuilt[key] = held;
    if (key === "date") rebuilt.discontinued_date = value;
  }
  if (rebuilt.discontinued_date === undefined) rebuilt.discontinued_date = value;
  Object.keys(change).forEach((key) => delete change[key]);
  Object.assign(change, rebuilt);
  withField.push(`${change.vendor}: ${value}`);
}

writeFileSync(PATH, JSON.stringify(data, null, 2) + "\n");
console.log(`${withField.length} deprecation records now state a discontinuation date`);
withField.forEach((line) => console.log(`  ${line}`));
