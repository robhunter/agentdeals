import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parsePageLastmod } from "../dist/page-lastmod.js";

const GENERATOR = "node scripts/update-page-lastmod.js --json";

const HELP = `Report what a page-dating run did, from the outcome it wrote.

Reads the outcome that ${GENERATOR} <path> wrote and the ledger that run wrote, and prints
moved=, added= and dropped= for a workflow step's outputs. A run that wrote no ledger update
fails here rather than reporting success, and every failure names the command whose output it
could not use, so a truncated payload is never reported as this step's own parse error.

Usage: node scripts/report-page-lastmod.js <outcome-path> <ledger-path>
`;

function readOutcome(file) {
  let text;
  try {
    text = readFileSync(file, "utf-8");
  } catch (err) {
    throw new Error(`${GENERATOR} ${file} left nothing there to read: ${err.message}`);
  }
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new Error(
      `${GENERATOR} ${file} left ${text.length} bytes there that are not JSON: ${err.message}. `
      + `A payload that stops at a round power of two went through a pipe rather than to a path.`,
    );
  }
}

function countsFor(outcome, file) {
  const lines = [];
  for (const key of ["moved", "added", "dropped"]) {
    if (!Array.isArray(outcome[key])) {
      throw new Error(`${GENERATOR} ${file} reports ${key} as ${JSON.stringify(outcome[key])}, expected a list of paths`);
    }
    lines.push(`${key}=${outcome[key].length}`);
  }
  return lines.join("\n");
}

function ledgerThatRunWrote(outcome, outcomeFile, expected) {
  if (typeof outcome.wrote !== "string" || outcome.wrote.length === 0) {
    throw new Error(
      `${GENERATOR} ${outcomeFile} reports that it wrote no ledger, so this run has no dates to send anywhere and must not report success.`,
    );
  }
  if (resolve(outcome.wrote) !== resolve(expected)) {
    throw new Error(`${GENERATOR} ${outcomeFile} wrote ${outcome.wrote} and this step reads ${expected}`);
  }
  let ledger;
  try {
    ledger = parsePageLastmod(readFileSync(expected, "utf-8"), expected);
  } catch (err) {
    throw new Error(`${GENERATOR} ${outcomeFile} says it wrote ${expected}, which cannot be read back: ${err.message}`);
  }
  if (ledger.generated !== outcome.generated) {
    throw new Error(
      `${GENERATOR} ${outcomeFile} reports a run generated ${outcome.generated} and ${expected} says ${ledger.generated}, so what is on disk is not what this run read.`,
    );
  }
  return ledger;
}

function main(argv) {
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(HELP);
    return 0;
  }
  if (argv.length !== 2) {
    console.error(HELP);
    return 2;
  }
  const [outcomeFile, ledgerFile] = argv;
  const outcome = readOutcome(outcomeFile);
  const counts = countsFor(outcome, outcomeFile);
  ledgerThatRunWrote(outcome, outcomeFile, ledgerFile);
  console.log(counts);
  return 0;
}

try {
  process.exitCode = main(process.argv.slice(2));
} catch (err) {
  console.error(err.message);
  process.exitCode = 1;
}
