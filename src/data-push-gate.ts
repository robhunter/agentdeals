import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export interface NonBlockingTest {
  file: string;
  reason: string;
}

export interface NonBlockingTests {
  version: number;
  rule: string;
  tests: NonBlockingTest[];
}

export function nonBlockingTestsPath(): string {
  return (
    process.env.AGENTDEALS_NON_BLOCKING_TESTS_PATH ||
    path.join(__dirname, "..", "scripts", "gate-non-blocking-tests.json")
  );
}

export function normalizeTestPath(file: string): string {
  return file.trim().replace(/^\.\//, "").replace(/\\/g, "/");
}

export function parseNonBlockingTests(text: string, source: string): NonBlockingTests {
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
  const tests: NonBlockingTest[] = [];
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

export function readNonBlockingTests(file: string = nonBlockingTestsPath()): NonBlockingTests {
  return parseNonBlockingTests(fs.readFileSync(file, "utf-8"), file);
}

export type GateDecision = "push" | "quarantine";

export interface GateVerdict {
  decision: GateDecision;
  blocking: string[];
  excused: NonBlockingTest[];
  reason: string;
}

export function gateVerdict(failingFiles: string[], allowed: NonBlockingTests): GateVerdict {
  const failing = [...new Set(failingFiles.map(normalizeTestPath).filter(f => f.length > 0))].sort();
  if (failing.length === 0) {
    return {
      decision: "quarantine",
      blocking: [],
      excused: [],
      reason: "the suite is red and named no test file, so what failed is unknown",
    };
  }
  const byFile = new Map(allowed.tests.map(t => [t.file, t]));
  const blocking = failing.filter(f => !byFile.has(f));
  const excused = failing.filter(f => byFile.has(f)).map(f => byFile.get(f)!);
  if (blocking.length > 0) {
    return {
      decision: "quarantine",
      blocking,
      excused,
      reason: `${blocking.length} failing test file(s) hold the commit: ${blocking.join(", ")}`,
    };
  }
  return {
    decision: "push",
    blocking,
    excused,
    reason: `every failing test file reports on how current our own reading is, not on whether the data is right: ${excused
      .map(t => t.file)
      .join(", ")}`,
  };
}

export function readFailingFiles(file: string): string[] {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf-8").split("\n").map(normalizeTestPath).filter(f => f.length > 0);
}
