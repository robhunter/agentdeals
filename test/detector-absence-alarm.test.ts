import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { absenceIssueBody } from "../scripts/detector-absence-issue-body.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = join(__dirname, "..");
const SIGNAL = join(REPO, "scripts", "signal-detector-absence.sh");
const WORKFLOW = join(REPO, ".github", "workflows", "reverify.yml");
const MARKER = "reverify-detector-not-scheduled";

describe("#1716 the absence alarm finds itself by its marker, not by a search over the marker's words", () => {
  let bin = "";

  before(() => {
    bin = mkdtempSync(join(tmpdir(), "absence-alarm-gh-"));
    writeFileSync(
      join(bin, "gh"),
      [
        "#!/usr/bin/env bash",
        "set -euo pipefail",
        'if [ "$1 $2" = "issue list" ]; then',
        '  EXPR=""',
        '  FROM="$GH_OPEN_ISSUES"',
        '  while [ "$#" -gt 0 ]; do',
        '    if [ "$1" = "--jq" ]; then EXPR="$2"; fi',
        '    if [ "$1" = "--search" ]; then FROM="$GH_INDEX_RETURNS"; fi',
        "    shift",
        "  done",
        '  jq -r "$EXPR" <"$FROM"',
        "  exit 0",
        "fi",
        'if [ "$1 $2" = "issue create" ]; then',
        '  while [ "$#" -gt 0 ]; do',
        '    if [ "$1" = "--body-file" ]; then cp "$2" "$GH_CREATED_BODY"; fi',
        "    shift",
        "  done",
        '  echo "create" >>"$GH_ACTIONS"',
        "  exit 0",
        "fi",
        'echo "unexpected gh call: $*" >&2; exit 3',
      ].join("\n"),
      { mode: 0o755 },
    );
  });

  after(() => {
    if (bin && existsSync(bin)) rmSync(bin, { recursive: true, force: true });
  });

  function signal(
    openIssues: Array<{ number: number; body: string }>,
    indexReturns: Array<{ number: number; body: string }> = openIssues,
  ): { actions: string[]; stdout: string; createdBody: string } {
    const issues = join(bin, "issues.json");
    const indexed = join(bin, "indexed.json");
    const actions = join(bin, "actions.txt");
    const created = join(bin, "created-body.md");
    writeFileSync(issues, JSON.stringify(openIssues));
    writeFileSync(indexed, JSON.stringify(indexReturns));
    writeFileSync(actions, "");
    writeFileSync(created, "");
    const run = spawnSync("bash", [SIGNAL, MARKER], {
      cwd: REPO,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        GH_OPEN_ISSUES: issues,
        GH_INDEX_RETURNS: indexed,
        GH_ACTIONS: actions,
        GH_CREATED_BODY: created,
      },
    });
    assert.strictEqual(run.status, 0, `${run.stdout}${run.stderr}`);
    return {
      actions: readFileSync(actions, "utf8").split("\n").filter(Boolean),
      stdout: run.stdout,
      createdBody: readFileSync(created, "utf8"),
    };
  }

  const carrying = (n: number) => ({ number: n, body: `A run said this.\n\n<!-- ${MARKER} -->` });
  const quoting = (n: number) => ({
    number: n,
    body: `The lookup runs \`gh issue list --search "${MARKER} in:body"\`, which matches the words.`,
  });

  it("opens the alarm when no open issue carries the marker", () => {
    assert.deepStrictEqual(signal([]).actions, ["create"]);
  });

  it("declines to open a second alarm when one carrying the marker is open, and says which", () => {
    const already = signal([carrying(900)]);
    assert.deepStrictEqual(already.actions, []);
    assert.match(already.stdout, /Absence already signalled by issue #900 — not opening another\./);
  });

  it("opens the alarm over an issue that only writes the marker out in prose", () => {
    assert.deepStrictEqual(signal([quoting(1716)]).actions, ["create"]);
  });

  it("returns the issue carrying the marker and not the one merely holding its words", () => {
    const both = [quoting(1716), carrying(1900)];
    const declined = signal(both);
    assert.deepStrictEqual(declined.actions, []);
    assert.match(declined.stdout, /issue #1900/);
    assert.doesNotMatch(declined.stdout, /issue #1716/);
  });

  it("reads the open issues rather than a search engine's hits", () => {
    const missedByTheIndex = signal([carrying(900)], []);
    assert.deepStrictEqual(missedByTheIndex.actions, []);
    assert.match(missedByTheIndex.stdout, /issue #900/);
  });

  it("picks the same issue every run when more than one carries the marker", () => {
    const carriers = [carrying(400), carrying(120)];
    assert.match(signal(carriers).stdout, /issue #120/);
    assert.match(signal([...carriers].reverse()).stdout, /issue #120/);
  });

  it("writes a body carrying the marker the next run looks it up by", () => {
    const opened = signal([]);
    assert.deepStrictEqual(opened.actions, ["create"]);
    assert.ok(opened.createdBody.includes(`<!-- ${MARKER} -->`), opened.createdBody);
    assert.deepStrictEqual(signal([{ number: 950, body: opened.createdBody }]).actions, []);
  });

  it("states the marker as a comment, so an issue describing the alarm does not silence it", () => {
    const body = absenceIssueBody(MARKER);
    assert.ok(body.includes(`<!-- ${MARKER} -->`), body);
  });

  it("leaves the lookup in a script, where a mutant can reach it", () => {
    const workflow = readFileSync(WORKFLOW, "utf8");
    assert.match(workflow, /bash scripts\/signal-detector-absence\.sh reverify-detector-not-scheduled/);
    assert.doesNotMatch(
      workflow,
      /gh issue (list|create)/,
      "an alarm spelled out in YAML is outside every surface the mutants run against",
    );
  });

  it("looks the issue up by the literal marker rather than by a search over its words", () => {
    const source = readFileSync(SIGNAL, "utf8");
    assert.doesNotMatch(
      source,
      /gh issue list[^\n]*--search/,
      "a marker passed to --search is split into words, so any open issue holding them silences this",
    );
    assert.match(source, /--jq[^\n]*contains\(/);
  });
});
