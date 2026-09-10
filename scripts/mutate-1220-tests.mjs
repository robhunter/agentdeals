import { copyFileSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const SUITE = [
  "test/vendor-merge-redirect.test.ts",
  "test/shared-pricing-pages.test.ts",
  "test/substitute-evidence.test.ts",
];

const INDEX = "data/index.json";
const REGISTRY = "data/vendor_merges.json";
const BEFORE = "/tmp/mutate-1220-before.json";
const AFTER = "/tmp/mutate-1220-after.json";

const MERGES = "src/vendor-merges.ts";
const LINT = "scripts/lint-shared-pages.js";
const ROLE = "src/product-role.ts";

const MUTANTS = [
  ["a-listed-record-redirects-anyway", MERGES,
    `    if (liveSlugs.has(from)) continue;
    if (!liveSlugs.has(to)) continue;`,
    `    if (!liveSlugs.has(to)) continue;`],
  ["a-redirect-points-at-a-page-the-catalogue-does-not-answer", MERGES,
    `    if (liveSlugs.has(from)) continue;
    if (!liveSlugs.has(to)) continue;`,
    `    if (liveSlugs.has(from)) continue;`],
  ["history-moves-before-the-record-does", MERGES,
    `    if (liveVendors.has(key)) return null;
    if (!liveVendors.has(merge.survivor.trim().toLowerCase())) return null;`,
    `    if (!liveVendors.has(merge.survivor.trim().toLowerCase())) return null;`],
  ["history-moves-to-a-name-the-catalogue-does-not-carry", MERGES,
    `    if (liveVendors.has(key)) return null;
    if (!liveVendors.has(merge.survivor.trim().toLowerCase())) return null;`,
    `    if (liveVendors.has(key)) return null;`],
  ["a-registered-merge-stops-silencing-its-own-pair", LINT,
    `    const live = members.filter((o) => !retiredKeys.has(vendorKey(o.vendor)));`,
    `    const live = members.slice();`],
  ["every-shared-page-reads-as-reviewed", LINT,
    `    if (allowSets.some((allowed) => sameVendorSet(vendors, allowed))) continue;`,
    `    if (true) continue;`],
  ["an-add-on-is-offered-as-a-substitute", ROLE,
    `  if (role.is_addon) gates.add("addon");`,
    `  if (false) gates.add("addon");`],
  ["a-local-emulator-is-offered-as-a-substitute", ROLE,
    `  if (role.deployment_model === "local_dev_only") gates.add("local_dev_only");`,
    `  if (false) gates.add("local_dev_only");`],
  ["a-record-is-turned-away-under-the-last-reason-it-carries", ROLE,
    `  for (const gate of MEMBERSHIP_GATE_ORDER) {
    if (candidateGates.has(gate) && !subjectGates.has(gate)) return gate;
  }
  return null;
}

export function alternativeMembershipGate`,
    `  for (const gate of [...MEMBERSHIP_GATE_ORDER].reverse()) {
    if (candidateGates.has(gate) && !subjectGates.has(gate)) return gate;
  }
  return null;
}

export function alternativeMembershipGate`],
];

function run(cmd, args) {
  try {
    execFileSync(cmd, args, { stdio: "pipe", encoding: "utf-8" });
    return true;
  } catch {
    return false;
  }
}

copyFileSync(INDEX, BEFORE);

const index = JSON.parse(readFileSync(BEFORE, "utf-8"));
const retired = new Set(
  JSON.parse(readFileSync(REGISTRY, "utf-8")).merges.map((m) => m.retired.trim().toLowerCase()),
);
writeFileSync(
  AFTER,
  JSON.stringify({ ...index, offers: index.offers.filter((o) => !retired.has(o.vendor.trim().toLowerCase())) }),
);

const CATALOGUES = [["before the merge", BEFORE], ["after the merge", AFTER]];

const survivors = [];
for (const [name, file, from, to] of MUTANTS) {
  const original = readFileSync(file, "utf-8");
  if (!original.includes(from)) {
    console.log(`SKIP  ${name} — the line it mutates is not in ${file}`);
    survivors.push(`${name} (not applied)`);
    continue;
  }
  writeFileSync(file, original.replace(from, to));
  const built = run("npm", ["run", "build"]);
  const survived = [];
  if (built) {
    for (const [label, catalogue] of CATALOGUES) {
      copyFileSync(catalogue, INDEX);
      if (run("node", ["--test", "--test-concurrency", "1", ...SUITE])) survived.push(label);
    }
  }
  writeFileSync(file, original);
  copyFileSync(BEFORE, INDEX);
  const verdict = !built
    ? "killed (did not compile)"
    : survived.length === 0
      ? "killed          "
      : survived.length === CATALOGUES.length
        ? "SURVIVED        "
        : `killed only ${survived.length === 1 && survived[0] === "before the merge" ? "before" : "after"} `;
  console.log(`${verdict}  ${name}`);
  if (survived.length > 0) survivors.push(`${name} [survives ${survived.join(" and ")}]`);
}
run("npm", ["run", "build"]);
console.log(`\n${MUTANTS.length - survivors.length}/${MUTANTS.length} killed against both catalogues`);
if (survivors.length > 0) console.log("survivors:", survivors.join("; "));
