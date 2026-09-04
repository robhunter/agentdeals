import { gateVerdict, readFailingFiles, readNonBlockingTests } from "../dist/data-push-gate.js";

const HELP = `Decide whether a red suite holds a scheduled data commit back from main.

Reads the list of test files that failed, written by scripts/reporters/failing-test-files.js,
and subtracts the files listed in scripts/gate-non-blocking-tests.json. Anything left holds
the commit. Nothing left means every failure reported on how current our own reading is
rather than on whether the data is right, so the data goes to main and the failures are
printed for a person to read.

Usage: node scripts/gate-verdict.js <failing-files-list>

Exit status: 0 push, 1 quarantine, 2 the arguments were wrong.
`;

const [list] = process.argv.slice(2);
if (!list || list === "--help" || list === "-h") {
  console.log(HELP);
  process.exit(list ? 0 : 2);
}

const verdict = gateVerdict(readFailingFiles(list), readNonBlockingTests());

for (const t of verdict.excused) console.log(`Not held by ${t.file} — ${t.reason}`);
console.log(verdict.reason);
process.exit(verdict.decision === "push" ? 0 : 1);
