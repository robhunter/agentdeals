import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const dir = process.argv[2] ?? "data/analytics";
const apply = process.argv.includes("--apply");
const SEP = "|";
const OVERFLOW = "__other_pages__";

let changed = 0;
for (const file of readdirSync(dir).filter((f) => f.endsWith(".json")).sort()) {
  const path = join(dir, file);
  const doc = JSON.parse(readFileSync(path, "utf8"));
  const block = doc.traffic?.class_route_truncation;
  if (!block) continue;

  let overflow = 0;
  for (const [key, count] of Object.entries(doc.traffic.by_class_route ?? {})) {
    if (key.slice(key.indexOf(SEP) + 1) === OVERFLOW) overflow += count;
  }

  const before = JSON.stringify(block);
  block.requests_discarded = overflow;
  if (block.keys_discarded === 0 && overflow > 0) {
    block.keys_discarded = null;
    block.keys_discarded_is_exact = false;
  }
  const after = JSON.stringify(block);
  if (before === after) continue;

  changed++;
  console.log(`${file}\n  before ${before}\n  after  ${after}`);
  if (apply) writeFileSync(path, `${JSON.stringify(doc, null, 2)}\n`);
}
console.log(`${changed} file(s) ${apply ? "rewritten" : "would change"}`);
