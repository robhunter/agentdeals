import { describe, it } from "node:test";
import assert from "node:assert";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SOURCES = ["src/serve.ts", "src/signal-copy.ts", "src/openapi.ts"];

const CLOCK_EXPRESSION = /new Date\(\)/;

const DATE_CLAIM = /dateModified|datePublished|Last updated|Last verified|&middot; Updated |class="updated"|class="pub-date"/;

function readSource(relative: string): string[] {
  return readFileSync(path.join(__dirname, "..", relative), "utf-8").split("\n");
}

function clockValuedLocals(lines: string[]): Set<string> {
  const names = new Set<string>();
  const declaration = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*new Date\(\)\.toISOString\(\)/;
  for (const line of lines) {
    const m = line.match(declaration);
    if (m) names.add(m[1]);
  }
  return names;
}

interface Scope {
  name: string;
  from: number;
  to: number;
  clockNames: string[];
}

function scopesOf(lines: string[]): Scope[] {
  const starts: Array<{ name: string; at: number }> = [];
  lines.forEach((line, i) => {
    const m = line.match(/^(?:export )?(?:async )?function ([A-Za-z0-9_$]+)/);
    if (m) starts.push({ name: m[1], at: i });
  });
  const scopes: Scope[] = [];
  starts.forEach((start, i) => {
    const to = i + 1 < starts.length ? starts[i + 1].at : lines.length;
    scopes.push({ name: start.name, from: start.at, to, clockNames: [...clockValuedLocals(lines.slice(start.at, to))] });
  });
  return scopes;
}

function claimsFromAClockVariable(lines: string[], source: string): string[] {
  const offenders: string[] = [];
  for (const scope of scopesOf(lines)) {
    if (scope.clockNames.length === 0) continue;
    for (let i = scope.from; i < scope.to; i++) {
      const line = lines[i];
      if (!DATE_CLAIM.test(line)) continue;
      if (scope.clockNames.some(name => usesSymbol(line, name))) {
        offenders.push(`${source}:${i + 1} ${line.trim().slice(0, 120)}`);
      }
    }
  }
  return offenders;
}

function usesSymbol(line: string, name: string): boolean {
  return new RegExp(`(^|[^\\w$.])${name}([^\\w$]|$)`).test(line);
}

describe("#1061 a published date names an event, never the clock", () => {
  it("finds the functions holding a clock-valued local that it is meant to police", () => {
    const scoped = scopesOf(readSource("src/serve.ts")).filter(s => s.clockNames.length > 0);
    assert.ok(scoped.length >= 5, `found only ${scoped.length} such functions — the scan is not reading the source`);
  });

  it("recognises a date claim when it sees one", () => {
    assert.ok(DATE_CLAIM.test('    dateModified: new Date().toISOString().split("T")[0],'));
    assert.ok(DATE_CLAIM.test('  <p class="pub-date">Published ${pubDate}</p>'));
    assert.ok(!DATE_CLAIM.test("  const todayMs = new Date(today).getTime();"));
  });

  for (const source of SOURCES) {
    it(`renders no date claim in ${source} straight from the clock`, () => {
      const lines = readSource(source);
      const offenders = lines
        .map((line, i) => ({ line, n: i + 1 }))
        .filter(({ line }) => DATE_CLAIM.test(line) && CLOCK_EXPRESSION.test(line))
        .map(({ line, n }) => `${source}:${n} ${line.trim().slice(0, 120)}`);
      assert.deepStrictEqual(offenders, []);
    });

    it(`renders no date claim in ${source} from a variable holding the clock`, () => {
      assert.deepStrictEqual(claimsFromAClockVariable(readSource(source), source), []);
    });
  }

  it("would catch the indirection that got past the first sweep", () => {
    const fixture = [
      "function buildStateOfFreeTiersPage(): string {",
      '  const now = new Date().toISOString().split("T")[0];',
      '  <p class="page-meta">The ratio tells the story. Last updated ${now}.</p>',
      "    dateModified: now,",
    ];
    assert.strictEqual(claimsFromAClockVariable(fixture, "fixture").length, 2);
  });

  it("does not fire on a clock-valued local used for arithmetic", () => {
    const fixture = [
      "function buildExpiringPage(): string {",
      '  const today = new Date().toISOString().slice(0, 10);',
      '  const todayMs = new Date(today + "T00:00:00Z").getTime();',
      "  const isPast = event.endDate < today;",
    ];
    assert.deepStrictEqual(claimsFromAClockVariable(fixture, "fixture"), []);
  });

  it("does not read a clock variable out of a function that never declared one", () => {
    const fixture = [
      "function buildOne(): string {",
      '  const now = new Date().toISOString().slice(0, 10);',
      "function buildTwo(): string {",
      '  <p class="pub-date">Published ${pubDate}, and Vercel now includes analytics</p>',
    ];
    assert.deepStrictEqual(claimsFromAClockVariable(fixture, "fixture"), []);
  });
});
