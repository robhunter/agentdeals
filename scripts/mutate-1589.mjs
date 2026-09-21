import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const GATE = "scripts/gate-data-push.sh";

const SUITE = [
  "--test",
  "--test-concurrency",
  "1",
  "--test-name-pattern",
  "#1589 a replay conflicting only in what this run derives",
  "--test-name-pattern",
  "#1337 main moving under a run whose data the suite accepted",
  "test/data-push-gate.test.ts",
];

const MUTANTS = [
  ["the-replay-aborts-on-any-conflict-as-it-did-before", GATE,
    `  local resolved=0\n  while take_mains_copy_of_what_this_run_derives; do\n    if GIT_EDITOR=true git rebase --continue; then\n      COMMIT="$(git rev-parse --short HEAD)"\n      return 0\n    fi\n    resolved="$((resolved + 1))"\n    [ "$resolved" -lt "$COMMITS_ONE_REPLAY_RESOLVES" ] || break\n  done\n  git rebase --abort || true\n  return 1`,
    `  git rebase --abort || true\n  return 1`],

  ["every-conflicted-path-counts-as-one-this-run-regenerates", GATE,
    `  if [ -n "$held" ]; then\n    READINGS_THE_REPLAY_COULD_NOT_MERGE="$held"\n    return 1\n  fi\n`,
    ``],

  ["the-regenerated-set-is-hard-coded-rather-than-read-from-this-run-s-flags", GATE,
    `  if [ -n "$RATCHET_BUDGETS" ]; then echo "$BUDGETS_PATH"; fi\n  if [ -n "$UPDATE_PAGE_LASTMOD" ]; then echo "$PAGE_LASTMOD_PATH"; fi\n  if [ -n "$REGENERATE_LLM_INDEX" ]; then echo "$LLM_INDEX_PATH"; fi\n  if [ -n "$SYNC_PAGE_REVIEWS" ]; then echo "$PAGE_REVIEWS_PATH"; fi`,
    `  echo "$BUDGETS_PATH"\n  echo "$PAGE_LASTMOD_PATH"\n  echo "$LLM_INDEX_PATH"\n  echo "$PAGE_REVIEWS_PATH"`],

  ["a-commit-the-resolution-empties-is-let-go", GATE,
    `  if git diff --cached --quiet HEAD; then\n    git commit -q --allow-empty -C REBASE_HEAD || return 1\n  fi\n`,
    ``],

  ["the-resolution-is-never-staged", GATE,
    `    git add -- "$path" || return 1`,
    `    git status --porcelain -- "$path" >/dev/null || return 1`],

  ["the-conflict-markers-are-staged-as-the-resolution", GATE,
    `    git checkout --ours -- "$path" || return 1\n    git add -- "$path" || return 1`,
    `    git add -- "$path" || return 1`],

  ["the-log-says-nothing-about-what-it-resolved", GATE,
    `  echo "── Replayed over a conflict in `,
    `  : "── Replayed over a conflict in `],

  ["the-refusal-names-no-file", GATE,
    `\${READINGS_THE_REPLAY_COULD_NOT_MERGE:+ — the conflict is in $READINGS_THE_REPLAY_COULD_NOT_MERGE, which this run does not regenerate after a replay, so the two sides are a real disagreement}`,
    ``],

  ["this-run-s-own-copy-is-kept-rather-than-main-s", GATE,
    `    git checkout --ours -- "$path" || return 1`,
    `    git checkout --theirs -- "$path" || return 1`],
];

function run(cmd, args) {
  try {
    execFileSync(cmd, args, { stdio: "pipe", encoding: "utf-8" });
    return true;
  } catch {
    return false;
  }
}

function occurrences(haystack, needle) {
  let count = 0;
  let at = haystack.indexOf(needle);
  while (at !== -1) {
    count++;
    at = haystack.indexOf(needle, at + needle.length);
  }
  return count;
}

if (!run("bash", ["-n", GATE])) {
  console.error(`${GATE} does not parse before any mutant was applied — fix that first`);
  process.exit(2);
}
if (!run("node", SUITE)) {
  console.error("the scoped suite is red before any mutant was applied — every mutant would score a false kill");
  process.exit(2);
}

const survivors = [];
const unparsed = [];
const notApplied = [];
for (const [name, file, from, to] of MUTANTS) {
  const original = readFileSync(file, "utf-8");
  const found = occurrences(original, from);
  if (found !== 1) {
    console.log(`NOT APPLIED  ${name} — its target appears ${found} times in ${file}, not once`);
    notApplied.push(name);
    continue;
  }
  writeFileSync(file, original.replace(from, to));
  const parses = run("bash", ["-n", file]);
  const green = parses && run("node", SUITE);
  writeFileSync(file, original);
  if (!parses) unparsed.push(name);
  console.log(`${green ? "SURVIVED" : parses ? "killed  " : "NOT APPLIED — does not parse"}  ${name}`);
  if (green) survivors.push(name);
}
const scored = MUTANTS.length - notApplied.length - unparsed.length;
console.log(`\n${scored - survivors.length}/${scored} killed, of ${MUTANTS.length} written`);
if (survivors.length > 0) console.log("survivors:", survivors.join(", "));
if (unparsed.length > 0) console.log("does not parse:", unparsed.join(", "));
if (notApplied.length > 0) console.log("not applied:", notApplied.join(", "));
