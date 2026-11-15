import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
type TS = typeof import("typescript");
type Node = import("typescript").Node;

export function floorCallsIn(source: string): Array<{ line: number; end: number; key: string }> {
  const ts: TS = require("typescript");
  const file = ts.createSourceFile("test.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const print = ts.createPrinter({ removeComments: true });
  const text = (node: Node) => print.printNode(ts.EmitHint.Unspecified, node, file);
  const declarations = new Map<string, Array<import("typescript").VariableDeclaration>>();
  const collect = (node: Node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
      declarations.set(node.name.text, [...(declarations.get(node.name.text) ?? []), node]);
    }
    ts.forEachChild(node, collect);
  };
  collect(file);
  const dependency = (node: Node, seen = new Set<string>()): string[] => {
    const found: string[] = [];
    const visit = (part: Node) => {
      if (ts.isIdentifier(part)
          && !(ts.isPropertyAccessExpression(part.parent) && part.parent.name === part)
          && !(ts.isPropertyAssignment(part.parent) && part.parent.name === part)) {
        const name = part.text;
        if (!seen.has(name)) {
          seen.add(name);
          const bindings = declarations.get(name) ?? [];
          if (bindings.length) {
            found.push(...bindings.map(text));
            for (const binding of bindings) if (binding.initializer) found.push(...dependency(binding.initializer, seen));
          } else if (name !== "Math") {
            found.push(`unresolved:${name}`);
          }
        }
      }
      ts.forEachChild(part, visit);
    };
    visit(node);
    return found.sort();
  };
  const calls: Array<{ line: number; end: number; key: string }> = [];
  const visit = (node: Node) => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "assertPopulationFloor"
        && node.arguments.length >= 3) {
      const context: string[] = [];
      for (let parent: Node | undefined = node.parent; parent; parent = parent.parent) {
        if (ts.isCallExpression(parent) && parent.arguments[0] && ts.isStringLiteralLike(parent.arguments[0])) {
          context.push(text(parent.arguments[0]));
        }
      }
      calls.push({
        line: file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1,
        end: file.getLineAndCharacterOfPosition(node.getEnd()).line + 1,
        key: JSON.stringify([context, node.arguments.map(text), dependency(node.arguments[1]!)]),
      });
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return calls;
}

export function floorCallWasPresent(source: string, previous: string, line: number): boolean {
  const calls = floorCallsIn(source);
  const current = calls.find(call => call.line <= line && call.end >= line);
  if (!current || current.key.includes("unresolved:")) return false;
  const ordinal = calls.filter(call => call.line <= current.line && call.key === current.key).length;
  return floorCallsIn(previous).filter(call => call.key === current.key).length >= ordinal;
}

const sources = new Map<string, string | null>();

export function unchangedPopulationFloor(site: string, base: string | null): boolean {
  if (!base) return false;
  const match = site.match(/^(.*):(\d+)$/);
  if (!match) return false;
  const file = path.resolve(match[1]!);
  const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const relative = path.relative(repo, file);
  if (relative.startsWith("..") || path.isAbsolute(relative)) return false;
  const key = `${base}:${relative}`;
  if (!sources.has(key)) {
    const result = spawnSync("git", ["show", `${base}:${relative}`], {
      cwd: repo, encoding: "utf8", maxBuffer: 8 * 1024 * 1024, timeout: 10_000,
    });
    sources.set(key, result.status === 0 ? result.stdout : null);
  }
  const previous = sources.get(key);
  return previous != null && floorCallWasPresent(readFileSync(file, "utf8"), previous, Number(match[2]));
}
