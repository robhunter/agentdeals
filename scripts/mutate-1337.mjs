import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const SUITE = ["test/data-push-holdback.test.ts", "test/data-push-gate.test.ts"];

const MUTANTS = [
  ["the-blame-reads-the-whole-log-rather-than-the-failure-report", "src/data-push-holdback.ts",
    "  const at = log.lastIndexOf(FAILING_TESTS_MARKER);\n  return at === -1 ? \"\" : log.slice(at);",
    "  return log;"],

  ["a-vendor-name-is-matched-as-a-fragment-of-a-longer-word", "src/data-push-holdback.ts",
    "  return new RegExp(`(?<![\\\\p{L}\\\\p{N}])${escaped}(?![\\\\p{L}\\\\p{N}])`, \"iu\").test(text);",
    "  return new RegExp(escaped, \"iu\").test(text);"],

  ["the-blame-is-not-narrowed-to-the-vendors-this-run-moved", "src/data-push-holdback.ts",
    "  const attributable = named.filter((v) => movedKeys.has(vendorKey(v)));",
    "  const attributable = named;"],

  ["blaming-every-vendor-the-run-moved-still-counts-as-a-holdback", "src/data-push-holdback.ts",
    "  if (attributable.length >= moved.length) {",
    "  if (attributable.length > moved.length) {"],

  ["only-the-first-row-of-a-held-vendor-is-put-back", "src/data-push-holdback.ts",
    "    for (const was of restored.get(key) ?? []) out.push(was);",
    "    out.push((restored.get(key) ?? [])[0]);"],

  ["a-row-the-run-added-for-a-held-vendor-is-kept", "src/data-push-holdback.ts",
    "    if (placed.has(key)) continue;\n    placed.add(key);\n    for (const was of restored.get(key) ?? []) out.push(was);",
    "    out.push(row);"],

  ["a-held-vendor-is-matched-only-in-the-case-the-failure-printed", "src/data-push-holdback.ts",
    "  return typeof name === \"string\" ? name.trim().toLowerCase() : \"\";",
    "  return typeof name === \"string\" ? name.trim() : \"\";"],

  ["a-vendor-whose-row-stood-still-counts-as-moved", "src/data-push-holdback.ts",
    "    if (JSON.stringify(was.get(key) ?? null) === JSON.stringify(now.get(key) ?? null)) continue;",
    "    if (false) continue;"],

  ["the-file-is-written-without-the-newline-the-shipped-files-end-in", "src/data-push-holdback.ts",
    "  return `${JSON.stringify(doc, null, 2)}\\n`;",
    "  return JSON.stringify(doc, null, 2);"],

  ["the-gate-holds-a-second-set-of-vendors-back-on-the-same-run", "scripts/gate-data-push.sh",
    "  if [ -n \"$HELD_BACK_VENDORS\" ]; then\n    echo \"── A set of vendors has already been held back on this run and the suite is still red, so the batch stands or falls as one ──\"\n    return 1\n  fi\n",
    ""],

  ["the-reduced-batch-is-pushed-without-the-suite-reading-it", "scripts/gate-data-push.sh",
    "      if hold_back_the_vendors_a_failing_test_named; then continue; fi",
    "      if hold_back_the_vendors_a_failing_test_named; then break; fi"],

  ["the-quarantine-ref-carries-the-reduced-batch-rather-than-the-one-the-run-wrote", "scripts/gate-data-push.sh",
    "  local refused=\"${BATCH_AS_THE_RUN_WROTE_IT:-$(git rev-parse HEAD)}\"",
    "  local refused=\"$(git rev-parse HEAD)\""],

  ["the-run-that-held-a-vendor-back-says-so-nowhere", "scripts/gate-data-push.sh",
    "      echo \"held_back_vendors=$HELD_BACK_VENDORS\" >>\"$OUTPUT\"",
    "      : >>\"$OUTPUT\""],

  ["the-held-vendor-names-never-reach-the-caller", "scripts/gate-hold-back-vendors.js",
    "writeFileSync(args.vendorsTo, verdict.vendors.map((v) => `${v}\\n`).join(\"\"));",
    "writeFileSync(args.vendorsTo, \"\");"],

  ["a-run-committing-no-vendor-keyed-file-is-treated-as-having-held-back", "scripts/gate-hold-back-vendors.js",
    "if (files.length === 0) {\n  console.log(\"None of the files a vendor's rows live in is among the paths this run may commit, so there is nothing to hold back.\");\n  process.exit(1);\n}",
    "if (files.length === 0) {\n  process.exit(1);\n}"],
];

function run(cmd, args) {
  try {
    execFileSync(cmd, args, { stdio: "pipe", encoding: "utf-8" });
    return true;
  } catch {
    return false;
  }
}

const survivors = [];
const uncompiled = [];
const skipped = [];
for (const [name, file, from, to] of MUTANTS) {
  const original = readFileSync(file, "utf-8");
  if (!original.includes(from)) {
    console.log(`SKIP  ${name} — the line it mutates is not in ${file}`);
    skipped.push(name);
    continue;
  }
  writeFileSync(file, original.replace(from, to));
  const built = run("npm", ["run", "build"]);
  const green = built && run("node", ["--test", "--test-concurrency", "1", ...SUITE]);
  writeFileSync(file, original);
  if (!built) uncompiled.push(name);
  console.log(`${green ? "SURVIVED" : built ? "killed  " : "DID NOT COMPILE"}  ${name}`);
  if (green) survivors.push(name);
}
run("npm", ["run", "build"]);
const killed = MUTANTS.length - survivors.length - uncompiled.length - skipped.length;
console.log(`\n${killed}/${MUTANTS.length} killed`);
if (survivors.length > 0) console.log("survivors:", survivors.join(", "));
if (uncompiled.length > 0) console.log("did not compile:", uncompiled.join(", "));
if (skipped.length > 0) console.log("skipped — target string moved, so these scored nothing:", skipped.join(", "));
