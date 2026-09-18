import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const SUITE = ["test/data-push-gate.test.ts"];
const ONLY = "#1764|pushes a data change the suite accepts|commits nothing when the run produced no data change";

const REPORTER = "scripts/report-data-push-outcome.sh";
const GATE = "scripts/gate-data-push.sh";

const MUTANTS = [
  ["every-job-shares-one-refusal-alarm-again", REPORTER,
    '    SCOPE="$JOB_SLUG"\n',
    '    SCOPE=""\n'],

  ["the-refusal-alarm-title-names-no-job", REPORTER,
    'TITLE="$JOB was refused — the part of the catalogue it writes is not advancing"',
    'TITLE="A scheduled data push was refused — the catalogue is not advancing"'],

  ["a-push-closes-whichever-refusal-alarm-it-finds-first", REPORTER,
    'FROZEN_ALARM="$(the_open_alarm_carrying "$CLEARS_MARKER:$JOB_SLUG")"',
    'FROZEN_ALARM="$(the_open_alarm_carrying "$CLEARS_MARKER")"'],

  ["an-issue-is-closed-without-asking-who-opened-it", REPORTER,
    'the_open_alarm_carrying() {\n  gh issue list --state open --limit 200 --json number,body,author \\\n    --jq "[.[] | select(.author.login == \\"$OPENED_BY_THE_SYSTEM\\") | select(.body | contains(\\"<!-- $1 -->\\"))]',
    'the_open_alarm_carrying() {\n  gh issue list --state open --limit 200 --json number,body,author \\\n    --jq "[.[] | select(.body | contains(\\"<!-- $1 -->\\"))]'],

  ["the-alarm-that-names-no-job-closes-while-a-job-is-still-frozen", REPORTER,
    '[ "$(how_many_open_alarms_name_a_job)" = "0" ]',
    "true"],

  ["a-shallow-checkout-is-read-no-deeper-than-its-tip", REPORTER,
    '    git fetch --shallow-since="30 days ago" origin main >/dev/null 2>&1 || true\n',
    "    true\n"],

  ["the-freeze-is-measured-from-the-commit-the-run-could-not-push", REPORTER,
    "  for ref in FETCH_HEAD origin/main; do",
    "  for ref in FETCH_HEAD origin/main HEAD; do"],

  ["the-freeze-is-measured-from-whichever-job-pushed-last", REPORTER,
    'found="$(git log "$ref" --fixed-strings --grep="$subject" -1 --format=\'%H %cI\' 2>/dev/null || true)"',
    'found="$(git log "$ref" -1 --format=\'%H %cI\' 2>/dev/null || true)"'],

  ["a-run-with-nothing-to-push-reports-nothing", GATE,
    '  echo "pushed_nothing=true" >>"$OUTPUT"\n',
    ""],

  ["a-push-that-reached-main-reports-no-commit", GATE,
    '    echo "pushed_commit=$COMMIT" >>"$OUTPUT"\n',
    ""],
];

function run(cmd, args) {
  try {
    execFileSync(cmd, args, { stdio: "pipe", encoding: "utf-8", env: { ...process.env, TZ: "UTC" } });
    return true;
  } catch {
    return false;
  }
}

const survivors = [];
const skipped = [];
for (const [name, file, from, to] of MUTANTS) {
  const original = readFileSync(file, "utf-8");
  if (!original.includes(from)) {
    console.log(`SKIP  ${name} — the line it mutates is not in ${file}`);
    skipped.push(name);
    continue;
  }
  writeFileSync(file, original.replace(from, to));
  const green = run("npx", ["tsx", "--test", "--test-concurrency", "1", "--test-name-pattern", ONLY, ...SUITE]);
  writeFileSync(file, original);
  console.log(`${green ? "SURVIVED" : "killed  "}  ${name}`);
  if (green) survivors.push(name);
}
const killed = MUTANTS.length - survivors.length - skipped.length;
console.log(`\n${killed}/${MUTANTS.length} killed`);
if (survivors.length > 0) console.log("survivors:", survivors.join(", "));
if (skipped.length > 0) console.log("skipped — target string moved, so these scored nothing:", skipped.join(", "));
