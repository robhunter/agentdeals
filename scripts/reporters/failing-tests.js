import { relative } from "node:path";
import { driftedGuardOf } from "../../dist/data-push-gate.js";

const SUITE_HOLDING_A_FAILING_TEST = "subtestsFailed";

export default async function* failingTests(source) {
  const lines = [];
  for await (const event of source) {
    if (event.type !== "test:fail") continue;
    const error = event.data?.details?.error;
    if (error?.failureType === SUITE_HOLDING_A_FAILING_TEST) continue;
    const file = event.data?.file;
    if (typeof file !== "string" || file.length === 0) continue;
    const failure = { file: relative(process.cwd(), file), name: event.data?.name ?? "" };
    const drifted = driftedGuardOf(error);
    if (drifted) failure.drifted = drifted;
    lines.push(`${JSON.stringify(failure)}\n`);
  }
  yield lines.join("");
}
