import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const SUITE = "test/change-widgets-leave-out-our-index.test.ts";

const MUTANTS = [
  ["the-gcp-guide-lists-our-index", "src/serve.ts",
    "  const gcpChanges = recordsOtherThanOurOwnIndexHousekeeping(dealChanges).filter((c: any) =>\n",
    "  const gcpChanges = dealChanges.filter((c: any) =>\n",
    ["/gcp-free-tier-2026 renders a record of our own index as a vendor event"]],

  ["the-event-pages-list-our-index", "src/serve.ts",
    "  const eventChanges = recordsOtherThanOurOwnIndexHousekeeping(allChanges)\n",
    "  const eventChanges = allChanges\n",
    ["/events/google-io-2026 renders a record of our own index as a vendor event",
     "/events/google-cloud-next-2026 renders a record of our own index as a vendor event",
     "/events/google-io-2026 badges a record of our own index",
     "/events/google-cloud-next-2026 badges a record of our own index"]],

  ["the-llm-guide-lists-our-index", "src/serve.ts",
    "  const llmChanges = recordsOtherThanOurOwnIndexHousekeeping(dealChanges).filter(c =>\n    llmVendorNames.some(",
    "  const llmChanges = dealChanges.filter(c =>\n    llmVendorNames.some(",
    ["/llm-api-pricing renders a record of our own index as a vendor event"]],
];

function run(cmd, args) {
  try {
    execFileSync(cmd, args, { stdio: "pipe", encoding: "utf-8" });
    return { ok: true, output: "" };
  } catch (error) {
    return { ok: false, output: `${error.stdout ?? ""}${error.stderr ?? ""}` };
  }
}

const suite = () => run("node", ["--test", "--test-concurrency", "1", SUITE]);

function occurrences(haystack, needle) {
  let count = 0;
  let at = haystack.indexOf(needle);
  while (at !== -1) {
    count++;
    at = haystack.indexOf(needle, at + needle.length);
  }
  return count;
}

if (!run("npm", ["run", "build"]).ok) {
  console.error("the tree does not build before any mutant was applied — fix that first");
  process.exit(2);
}
if (!suite().ok) {
  console.error("the suite is red before any mutant was applied — every mutant would score a false kill");
  process.exit(2);
}

const survivors = [];
const killedForAnotherReason = [];
const uncompiled = [];
const notApplied = [];
for (const [name, file, from, to, messages] of MUTANTS) {
  const original = readFileSync(file, "utf-8");
  const found = occurrences(original, from);
  if (found !== 1) {
    console.log(`NOT APPLIED  ${name} — its target appears ${found} times in ${file}, not once`);
    notApplied.push(name);
    continue;
  }
  writeFileSync(file, original.replace(from, to));
  const built = run("npm", ["run", "build"]).ok;
  const result = built ? suite() : { ok: false, output: "" };
  writeFileSync(file, original);
  const missing = messages.filter((message) => !result.output.includes(message));
  if (!built) {
    console.log(`NOT APPLIED — did not compile  ${name}`);
    uncompiled.push(name);
  } else if (result.ok) {
    console.log(`SURVIVED  ${name}`);
    survivors.push(name);
  } else if (missing.length > 0) {
    console.log(`KILLED FOR ANOTHER REASON  ${name} — the failure never said: ${missing.join(" | ")}`);
    killedForAnotherReason.push(name);
  } else {
    console.log(`killed    ${name} — ${messages.join(" | ")}`);
  }
}
run("npm", ["run", "build"]);
const scored = MUTANTS.length - notApplied.length - uncompiled.length;
const killed = scored - survivors.length - killedForAnotherReason.length;
console.log(`\n${killed}/${scored} killed with the failure they were written to cause, of ${MUTANTS.length} written`);
if (survivors.length > 0) console.log("survivors:", survivors.join(", "));
if (killedForAnotherReason.length > 0) console.log("killed for another reason:", killedForAnotherReason.join(", "));
if (uncompiled.length > 0) console.log("did not compile:", uncompiled.join(", "));
if (notApplied.length > 0) console.log("not applied:", notApplied.join(", "));
if (survivors.length + killedForAnotherReason.length + uncompiled.length + notApplied.length > 0) process.exit(1);
