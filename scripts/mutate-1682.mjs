import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FILES = {
  plans: `${ROOT}/src/page-priced-plans.ts`,
  reader: `${ROOT}/src/page-free-plan.ts`,
  data: `${ROOT}/data/deal_changes.json`,
};
const SUITE = [
  "test/removal-record-refuted-by-its-page.test.ts",
  "test/free-tier-removal-evidence.test.ts",
  "test/licence-free-removal.test.ts",
];

const MUTANTS = [
  ["a paid ladder reads as free", "plans", "plan.amount === 0 && planIsOfferedOutright(plan)", "plan.amount >= 0 && planIsOfferedOutright(plan)"],
  ["a plan whose name calls it a trial counts", "plans", "plan.amount === 0 && planIsOfferedOutright(plan)", "plan.amount === 0 && true"],
  ["only a field named exactly price is a price", "plans", "export const A_PRICE_KEY = /price|cost|amount/i;", "export const A_PRICE_KEY = /^price$/i;"],
  ["a key named name is not a plan name", "plans", "export const A_PLAN_NAME_KEY = /^(?:name|title|label)$/i;", "export const A_PLAN_NAME_KEY = /^(?:title|label)$/i;"],
  ["one level of escaping is followed", "plans", "export const ESCAPING_LEVELS_WE_FOLLOW = 3;", "export const ESCAPING_LEVELS_WE_FOLLOW = 1;"],
  ["a paragraph counts as a plan name", "plans", "if (named !== \"\" && named.length <= LONGEST_NAME) return named;", "if (named !== \"\") return named;"],
  ["a brace inside prose counts as structure", "plans", "if (character === '\"') inString = true;", "if (character === '\\u0000') inString = true;"],
  ["a field the page names as a price is skipped", "plans", "if (!A_PRICE_KEY.test(key)) continue;", "if (A_PRICE_KEY.test(key)) continue;"],
  ["the same plan is reported once per enclosing object", "plans", "if (already.has(key)) continue;", "if (false) continue;"],
  ["the period is dropped from the reading", "plans", "  if (A_MONTHLY_PRICE_KEY.test(field)) return \"month\";", "  if (false) return \"month\";"],
  ["the currency is dropped from the reading", "plans", "if (typeof value === \"string\" && A_CURRENCY_CODE.test(value.trim())) return value.trim();", "if (false) return String(value);"],
  ["a payload with no price key is skipped", "plans", "if (typeof content !== \"string\" || !content.includes(\"{\") || !A_PRICE_KEY.test(content)) continue;", "if (typeof content !== \"string\" || !content.includes(\"{\") || A_PRICE_KEY.test(content)) continue;"],
  ["the largest object we parse is the whole page", "plans", "export const LONGEST_OBJECT_WE_PARSE = 8192;", "export const LONGEST_OBJECT_WE_PARSE = 64;"],
  ["a priced plan outranks what the rendered page says", "reader", "  if (visible) return { where: \"visible\", sentence: visible };", "  if (visible && !aPlanPricedAtNothing(parts.plans)) return { where: \"visible\", sentence: visible };"],
  ["a priced plan is not markup we discard", "reader", "return where === \"structured\" || where === \"priced\";", "return where === \"structured\";"],
  ["the reading does not name the field it came from", "reader", "if (priced) return { where: \"priced\", sentence: readingOf(priced) };", "if (priced) return { where: \"priced\", sentence: priced.name };"],
  ["the record is a free tier removal again", "data", "\"vendor\": \"Unkey\",\n      \"change_type\": \"limits_reduced\",", "\"vendor\": \"Unkey\",\n      \"change_type\": \"free_tier_removed\","],
];

const held = Object.fromEntries(Object.entries(FILES).map(([key, file]) => [key, readFileSync(file, "utf8")]));
const restore = () => {
  for (const [key, file] of Object.entries(FILES)) writeFileSync(file, held[key]);
};

function run(command, args) {
  try {
    execFileSync(command, args, { cwd: ROOT, stdio: "pipe", encoding: "utf8", timeout: 900000 });
    return { ok: true, out: "" };
  } catch (error) {
    return { ok: false, out: `${error.stdout ?? ""}${error.stderr ?? ""}` };
  }
}

const baseline = run("npx", ["tsc"]);
if (!baseline.ok) {
  console.log("BASELINE BUILD FAILED");
  console.log(baseline.out.slice(0, 2000));
  process.exit(1);
}
const green = run("node", ["--test", ...SUITE]);
if (!green.ok) {
  console.log("BASELINE SUITE RED — nothing measured");
  console.log(green.out.slice(-3000));
  process.exit(1);
}
console.log("baseline: build clean, suite green");
console.log("");

const outcomes = [];
for (const [name, target, from, to] of MUTANTS) {
  const file = FILES[target];
  const source = held[target];
  const occurrences = source.split(from).length - 1;
  if (occurrences !== 1) {
    outcomes.push([name, `NOT APPLIED — the target text appears ${occurrences} times`]);
    console.log(`NOT APPLIED  ${name} (${occurrences} occurrences)`);
    continue;
  }
  writeFileSync(file, source.replace(from, to));

  const built = run("npx", ["tsc"]);
  if (!built.ok) {
    restore();
    outcomes.push([name, "NOT APPLIED — the compiler rejected it"]);
    console.log(`NOT APPLIED  ${name} (compiler)`);
    continue;
  }
  const result = run("node", ["--test", ...SUITE]);
  restore();
  const verdict = result.ok ? "SURVIVED" : "killed";
  outcomes.push([name, verdict]);
  console.log(`${verdict.padEnd(11)}  ${name}`);
  if (result.ok) console.log("             nothing went red");
}

restore();
run("npx", ["tsc"]);

const killed = outcomes.filter(([, verdict]) => verdict === "killed").length;
console.log("");
console.log(`${killed} of ${MUTANTS.length} killed`);
for (const [name, verdict] of outcomes.filter(([, v]) => v !== "killed")) console.log(`  ${verdict}: ${name}`);
