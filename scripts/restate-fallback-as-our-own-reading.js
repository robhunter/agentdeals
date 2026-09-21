import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { A_CLAIM_ABOUT_WHAT_THE_PAGE_CONTAINS, WE_MATCHED_NO_AMOUNT_TO_OUR_TERMS } from "./vendor-naming.js";

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const INDEX = path.join(REPO, "data", "index.json");

export const THE_CLAIM_THIS_RESTATES = "states amounts, none of which is a figure we publish";

export function detailAttributedToOurReading(detail) {
  const sentence = detail ?? "";
  if (!sentence.endsWith(THE_CLAIM_THIS_RESTATES)) return sentence;
  return `${sentence.slice(0, -THE_CLAIM_THIS_RESTATES.length)}${WE_MATCHED_NO_AMOUNT_TO_OUR_TERMS}`;
}

function run({ write }) {
  const data = JSON.parse(fs.readFileSync(INDEX, "utf-8"));
  const counts = { checked: 0, claiming: 0, restated: 0 };
  const restated = [];
  const unreached = [];
  for (const offer of data.offers) {
    counts.checked++;
    const detail = offer.source_check?.detail ?? "";
    if (!A_CLAIM_ABOUT_WHAT_THE_PAGE_CONTAINS.test(detail)) continue;
    counts.claiming++;
    const settled = detailAttributedToOurReading(detail);
    if (settled === detail || A_CLAIM_ABOUT_WHAT_THE_PAGE_CONTAINS.test(settled)) {
      unreached.push(`${offer.vendor}: ${detail}`);
      continue;
    }
    counts.restated++;
    restated.push(offer.vendor);
    offer.source_check.detail = settled;
  }
  console.log(`Records read: ${counts.checked}`);
  console.log(`Saying a figure of ours is absent from the page: ${counts.claiming}`);
  console.log(`Restated as what our reading matched: ${counts.restated}`);
  for (const vendor of restated) console.log(`  ${vendor}`);
  if (unreached.length > 0) {
    console.log(`Claims in a shape this restatement does not reach: ${unreached.length}`);
    for (const line of unreached) console.log(`  ${line}`);
  }
  if (write) {
    fs.writeFileSync(INDEX, `${JSON.stringify(data, null, 2)}\n`);
    console.log(`Wrote ${INDEX}`);
  } else {
    console.log("Dry run. Pass --write to save.");
  }
  return counts;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run({ write: process.argv.includes("--write") });
}
