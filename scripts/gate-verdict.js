import { writeFileSync } from "node:fs";
import { dataGatingTestsPath, driftedGuardsMarkdown, gateVerdict, readDataGatingTests, readFailures } from "../dist/data-push-gate.js";

const HELP = `Decide whether a red suite holds a scheduled data commit back from main.

Reads the failures written by scripts/reporters/failing-tests.js, one JSON object a line,
and holds the commit for one class only: a file named in scripts/gate-blocking-tests.json,
whose failures mean a record the run produced is wrong. Every other red file is reported and
does not hold the commit. An assertion carrying a drifted guard never holds it either, named
in that file or not: it states only that a floor has drifted into the headroom it declares.
A red suite that named no file at all holds the commit, because what failed is unknown.

Usage: node scripts/gate-verdict.js <failures-list> [--excused-to <path>] [--drift-to <path>]

  --excused-to  write the failing files that did not hold the commit, one a line
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

const verdict = gateVerdict(readFailures(list), readDataGatingTests(), dataGatingTestsPath());

const excusedTo = optionAfter("--excused-to");
if (excusedTo) writeFileSync(excusedTo, verdict.reported.map((t) => `${t.file}\n`).join(""));

const driftTo = optionAfter("--drift-to");
if (driftTo && verdict.drifted.length > 0) writeFileSync(driftTo, `${driftedGuardsMarkdown(verdict.drifted)}\n`);

console.log(`Red: ${verdict.files.join(", ") || "no file the reporter could name"}`);
for (const t of verdict.reported) console.log(`Not held by ${t.file} — ${t.reason}`);
for (const d of verdict.drifted) {
  console.log(
    `Not held by ${d.site} — it states ${d.stated} over the ${d.measured} it measured, and clears at ${d.clearsAt}: ${d.subject}`,
  );
}
console.log(verdict.reason);
process.exit(verdict.decision === "push" ? 0 : 1);
