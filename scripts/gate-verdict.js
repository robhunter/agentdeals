import { writeFileSync } from "node:fs";
import { driftedGuardsMarkdown, gateVerdict, readFailures, readNonBlockingTests } from "../dist/data-push-gate.js";

const HELP = `Decide whether a red suite holds a scheduled data commit back from main.

Reads the failures written by scripts/reporters/failing-tests.js, one JSON object a line,
and subtracts two classes. A file listed in scripts/gate-non-blocking-tests.json is excused
whatever it fires on. An individual assertion carrying a drifted guard is excused on its own:
it names no record and no vendor, and states only that a floor has drifted into the headroom
it declares. Anything left holds the commit.

Usage: node scripts/gate-verdict.js <failures-list> [--excused-to <path>] [--drift-to <path>]

  --excused-to  write the failing files the allowlist excuses, one a line
  --drift-to    write a markdown table of the drifted guards, for an issue body

Exit status: 0 push, 1 quarantine, 2 the arguments were wrong.
`;

const argv = process.argv.slice(2);
const [list] = argv;
if (!list || list === "--help" || list === "-h") {
  console.log(HELP);
  process.exit(list ? 0 : 2);
}

const optionAfter = (flag) => {
  const at = argv.indexOf(flag);
  return at === -1 ? null : (argv[at + 1] ?? null);
};

const verdict = gateVerdict(readFailures(list), readNonBlockingTests());

const excusedTo = optionAfter("--excused-to");
if (excusedTo) writeFileSync(excusedTo, verdict.excused.map((t) => `${t.file}\n`).join(""));

const driftTo = optionAfter("--drift-to");
if (driftTo && verdict.drifted.length > 0) writeFileSync(driftTo, `${driftedGuardsMarkdown(verdict.drifted)}\n`);

for (const t of verdict.excused) console.log(`Not held by ${t.file} — ${t.reason}`);
for (const d of verdict.drifted) {
  console.log(
    `Not held by ${d.site} — it states ${d.stated} over the ${d.measured} it measured, and clears at ${d.clearsAt}: ${d.subject}`,
  );
}
console.log(verdict.reason);
process.exit(verdict.decision === "push" ? 0 : 1);
