import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export interface DataGatingTest {
  file: string;
  reason: string;
}

export interface DataGatingTests {
  version: number;
  rule: string;
  tests: DataGatingTest[];
}

export interface ReportedFailure {
  file: string;
  reason: string;
}

export function dataGatingTestsPath(): string {
  return (
    process.env.AGENTDEALS_DATA_GATING_TESTS_PATH ||
    path.join(__dirname, "..", "scripts", "gate-blocking-tests.json")
  );
}

export function normalizeTestPath(file: string): string {
  return file.trim().replace(/^\.\//, "").replace(/\\/g, "/");
}

export function parseDataGatingTests(text: string, source: string): DataGatingTests {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new Error(`${source} is not valid JSON: ${(err as Error).message}`);
  }
  const file = raw as { version?: unknown; rule?: unknown; tests?: unknown };
  if (file.version !== 1) throw new Error(`${source} has version ${String(file.version)}, expected 1`);
  if (typeof file.rule !== "string" || file.rule.length === 0) {
    throw new Error(`${source} states no rule for what may be listed in it`);
  }
  if (!Array.isArray(file.tests)) throw new Error(`${source} has no tests array`);
  const tests: DataGatingTest[] = [];
  for (const entry of file.tests) {
    const e = entry as { file?: unknown; reason?: unknown };
    if (typeof e.file !== "string" || !e.file.startsWith("test/")) {
      throw new Error(`${source} lists ${JSON.stringify(e.file)}, which is not a path under test/`);
    }
    if (typeof e.reason !== "string" || e.reason.length === 0) {
      throw new Error(`${source} lists ${e.file} with no reason`);
    }
    tests.push({ file: normalizeTestPath(e.file), reason: e.reason });
  }
  const seen = new Set<string>();
  for (const t of tests) {
    if (seen.has(t.file)) throw new Error(`${source} lists ${t.file} twice`);
    seen.add(t.file);
  }
  return { version: 1, rule: file.rule, tests };
}

export function readDataGatingTests(file: string = dataGatingTestsPath()): DataGatingTests {
  return parseDataGatingTests(fs.readFileSync(file, "utf-8"), file);
}

export type GateDecision = "push" | "quarantine";

export interface DriftedGuard {
  site: string;
  subject: string;
  stated: string;
  measured: string;
  clearsAt: string;
}

export interface TestFailure {
  file: string;
  name: string;
  drifted?: DriftedGuard;
}

export const DRIFTED_GUARD = "driftedGuard";

const DRIFTED_GUARD_FIELDS = ["site", "subject", "stated", "measured", "clearsAt"] as const;

function driftedGuardCarriedBy(carrier: unknown): DriftedGuard | undefined {
  if (typeof carrier !== "object" || carrier === null) return undefined;
  const guard = (carrier as Record<string, unknown>)[DRIFTED_GUARD];
  if (typeof guard !== "object" || guard === null) return undefined;
  const fields = guard as Record<string, unknown>;
  if (DRIFTED_GUARD_FIELDS.some(field => typeof fields[field] !== "string")) return undefined;
  return guard as DriftedGuard;
}

export function driftedGuardOf(error: unknown): DriftedGuard | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  return driftedGuardCarriedBy(error) ?? driftedGuardCarriedBy((error as { cause?: unknown }).cause);
}

export interface GateVerdict {
  decision: GateDecision;
  blocking: string[];
  reported: ReportedFailure[];
  drifted: DriftedGuard[];
  files: string[];
  reason: string;
}

export function reasonNotHeldBy(file: string, gating: DataGatingTests, source: string): string {
  const declared = gating.tests.find(t => t.file === file);
  if (!declared) {
    return `${source} does not name it, so its failure is not a statement that the data this run produced is wrong`;
  }
  return `${source} names it, and every assertion of its that failed states only that a floor has drifted into the headroom it declares`;
}

export function gateVerdict(
  failures: TestFailure[],
  gating: DataGatingTests,
  source: string = dataGatingTestsPath(),
): GateVerdict {
  const failing = failures
    .map(failure => ({ ...failure, file: normalizeTestPath(failure.file) }))
    .filter(failure => failure.file.length > 0);
  const files = [...new Set(failing.map(failure => failure.file))].sort();
  const drifted = failing.map(f => f.drifted).filter((d): d is DriftedGuard => d !== undefined);
  if (files.length === 0) {
    return {
      decision: "quarantine",
      blocking: [],
      reported: [],
      drifted,
      files,
      reason: "the suite is red and named no test file, so what failed is unknown",
    };
  }
  const gatingFiles = new Set(gating.tests.map(t => t.file));
  const held = failing.filter(f => gatingFiles.has(f.file) && f.drifted === undefined);
  const blocking = [...new Set(held.map(f => f.file))].sort();
  const reported = files
    .filter(f => !blocking.includes(f))
    .map(f => ({ file: f, reason: reasonNotHeldBy(f, gating, source) }));
  if (blocking.length > 0) {
    return {
      decision: "quarantine",
      blocking,
      reported,
      drifted,
      files,
      reason: `${blocking.length} failing test file(s) hold the commit: ${blocking.join(", ")}`,
    };
  }
  const why = [
    `no failing test file is named in ${source}, so nothing that went red says the data this run produced is wrong: ${files.join(", ")}`,
    drifted.length > 0
      ? `${drifted.length} failing assertion(s) name no record and no vendor, and state only that a guard has drifted into the headroom it declares: ${drifted
          .map(d => d.site)
          .join(", ")}`
      : "",
  ].filter(part => part.length > 0);
  return { decision: "push", blocking, reported, drifted, files, reason: why.join("; ") };
}

export function parseFailures(text: string, source: string): TestFailure[] {
  const failures: TestFailure[] = [];
  for (const line of text.split("\n")) {
    if (line.trim().length === 0) continue;
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch (err) {
      throw new Error(`${source} holds a line that is not valid JSON: ${(err as Error).message}`);
    }
    const entry = raw as { file?: unknown; name?: unknown; drifted?: unknown };
    if (typeof entry.file !== "string" || entry.file.length === 0) {
      throw new Error(`${source} holds a failure that names no test file: ${line}`);
    }
    failures.push({
      file: normalizeTestPath(entry.file),
      name: typeof entry.name === "string" ? entry.name : "",
      drifted: driftedGuardCarriedBy({ [DRIFTED_GUARD]: entry.drifted }),
    });
  }
  return failures;
}

export function readFailures(file: string): TestFailure[] {
  if (!fs.existsSync(file)) return [];
  return parseFailures(fs.readFileSync(file, "utf-8"), file);
}

export function driftedGuardsMarkdown(drifted: DriftedGuard[]): string {
  return [
    "| assertion | states | measured | clears at | subject |",
    "|---|---|---|---|---|",
    ...drifted.map(d => `| \`${d.site}\` | ${d.stated} | ${d.measured} | ${d.clearsAt} | ${d.subject} |`),
  ].join("\n");
}
