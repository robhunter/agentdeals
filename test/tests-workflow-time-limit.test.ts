import { describe, it } from "node:test";
import assert from "node:assert";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const workflow = readFileSync(path.join(__dirname, "..", ".github", "workflows", "tests.yml"), "utf-8");

function minutesSetBy(pattern: RegExp, what: string): number {
  const found = workflow.match(pattern);
  assert.ok(found, `tests.yml sets ${what}`);
  return Number(found![1]);
}

describe("the Tests workflow reports a suite that runs out of time as a failure", () => {
  it("runs npm test under its own time limit", () => {
    assert.match(workflow, /timeout --kill-after=\d+m "\$\{SUITE_TIME_LIMIT_MINUTES\}m" npm test\n/);
    assert.match(workflow, /::error title=Tests timed out::/);
  });

  it("stops the suite before GitHub cancels the job, which would report no result", () => {
    const jobLimit = minutesSetBy(/^ {4}timeout-minutes: (\d+)$/m, "the job's timeout-minutes");
    const suiteLimit = minutesSetBy(/^ {10}SUITE_TIME_LIMIT_MINUTES: (\d+)$/m, "SUITE_TIME_LIMIT_MINUTES");
    const killGrace = minutesSetBy(/timeout --kill-after=(\d+)m /, "the kill grace");
    const setupAllowance = 3;
    assert.ok(
      suiteLimit + killGrace + setupAllowance <= jobLimit,
      `a suite stopped at ${suiteLimit} minutes plus ${killGrace} of grace must end before the job's ${jobLimit}-minute timeout, with ${setupAllowance} to spare for install and build`
    );
  });
});
