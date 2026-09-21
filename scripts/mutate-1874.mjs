import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const SUITE = ["test/check-figure-bears-on-the-offer.test.ts"];

const ARMS = [
  {
    name: "restate a claim found anywhere in the sentence, not only at its end",
    file: "scripts/restate-fallback-as-our-own-reading.js",
    from: "if (!sentence.endsWith(THE_CLAIM_THIS_RESTATES)) return sentence;",
    to: "if (!sentence.includes(THE_CLAIM_THIS_RESTATES)) return sentence;",
  },
  {
    name: "append the new clause without removing the retired one",
    file: "scripts/restate-fallback-as-our-own-reading.js",
    from: "return `${sentence.slice(0, -THE_CLAIM_THIS_RESTATES.length)}${WE_MATCHED_NO_AMOUNT_TO_OUR_TERMS}`;",
    to: "return `${sentence}${WE_MATCHED_NO_AMOUNT_TO_OUR_TERMS}`;",
  },
  {
    name: "restate the claim as itself",
    file: "scripts/restate-fallback-as-our-own-reading.js",
    from: "${WE_MATCHED_NO_AMOUNT_TO_OUR_TERMS}`;",
    to: "${THE_CLAIM_THIS_RESTATES}`;",
  },
  {
    name: "leave every stored sentence as it was",
    file: "scripts/restate-fallback-as-our-own-reading.js",
    from: "  const sentence = detail ?? \"\";",
    to: "  const sentence = detail ?? \"\";\n  if (true) return sentence;",
  },
  {
    name: "write the new wording over a sentence that reports a figure",
    file: "scripts/restate-fallback-as-our-own-reading.js",
    from: "  if (!sentence.endsWith(THE_CLAIM_THIS_RESTATES)) return sentence;",
    to: "  if (false) return sentence;",
  },
];

function run() {
  let killed = 0;
  for (const arm of ARMS) {
    const target = path.join(REPO, arm.file);
    const original = fs.readFileSync(target, "utf-8");
    const occurrences = original.split(arm.from).length - 1;
    if (occurrences !== 1) {
      console.log(`NOT APPLIED (${occurrences} matches) — ${arm.name}`);
      continue;
    }
    fs.writeFileSync(target, original.replace(arm.from, arm.to));
    let survived = true;
    try {
      execFileSync("node", ["--test", "--test-concurrency", "1", ...SUITE], { cwd: REPO, stdio: "pipe" });
    } catch {
      survived = false;
    }
    fs.writeFileSync(target, original);
    if (survived) console.log(`SURVIVED — ${arm.name}`);
    else {
      killed++;
      console.log(`killed   — ${arm.name}`);
    }
  }
  console.log(`${killed} of ${ARMS.length} killed`);
}

run();
