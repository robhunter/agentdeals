import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const TESTS = path.join(REPO, "test");

const READS_THE_CATALOGUE_OFF_DISK =
  /\bdata["'`]\s*,\s*["'`][a-z_]+\.json|loadOffers\(|loadDealChanges\(|loadIndex\(|loadCatalogue\(|readIndex\(|enrichOffers\(/;

const ABSENT = new Set(["false", "null", "undefined", "0"]);

const ASSERTIONS = new Set(["strictEqual", "deepStrictEqual", "equal", "deepEqual"]);

const BUILT_IN = new Set(["length", "size", "name", "message", "stack", "text", "html", "body", "status"]);

function textOf(node, source) {
  return source.text.slice(node.getStart(source), node.getEnd());
}

function identifiersIn(node, source) {
  const named = new Set();
  const walk = (at) => {
    if (ts.isPropertyAccessExpression(at)) {
      walk(at.expression);
      return;
    }
    if (ts.isPropertyAssignment(at) && !ts.isComputedPropertyName(at.name)) {
      walk(at.initializer);
      return;
    }
    if (ts.isIdentifier(at)) named.add(at.text);
    ts.forEachChild(at, walk);
  };
  walk(node);
  void source;
  return named;
}

function liveBindingsIn(source) {
  const live = new Set();
  const declarations = [];
  const collect = (node) => {
    if (ts.isVariableDeclaration(node) && node.initializer && ts.isIdentifier(node.name)) {
      declarations.push({
        name: node.name.text,
        reads: identifiersIn(node.initializer, source),
        text: textOf(node.initializer, source),
      });
    }
    ts.forEachChild(node, collect);
  };
  collect(source);

  let grew = true;
  while (grew) {
    grew = false;
    for (const declaration of declarations) {
      if (live.has(declaration.name)) continue;
      const fromDisk = READS_THE_CATALOGUE_OFF_DISK.test(declaration.text);
      const fromLive = [...declaration.reads].some((read) => live.has(read));
      if (!fromDisk && !fromLive) continue;
      live.add(declaration.name);
      grew = true;
    }
  }
  return live;
}

function namesALiveBinding(node, source, live) {
  return [...identifiersIn(node, source)].some((name) => live.has(name));
}

function enclosingTestName(node, source) {
  for (let at = node.parent; at; at = at.parent) {
    if (!ts.isCallExpression(at)) continue;
    const callee = textOf(at.expression, source);
    if (callee !== "it" && callee !== "test" && callee !== "describe") continue;
    const first = at.arguments[0];
    if (first && ts.isStringLiteralLike(first)) return first.text;
  }
  return "(unnamed)";
}

function pinnedAbsencesIn(file) {
  const source = ts.createSourceFile(
    file,
    fs.readFileSync(file, "utf-8"),
    ts.ScriptTarget.Latest,
    true,
  );
  const live = liveBindingsIn(source);
  if (live.size === 0) return { live, found: [] };

  const found = [];
  const inspect = (node, inLiveLoop) => {
    let loop = inLiveLoop;
    if (ts.isForOfStatement(node) && namesALiveBinding(node.expression, source, live)) {
      loop = true;
    }
    if (loop && ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const object = textOf(node.expression.expression, source);
      const member = node.expression.name.text;
      const args = node.arguments;
      const pinned =
        object === "assert" &&
        ((ASSERTIONS.has(member) &&
          args.length >= 2 &&
          (ABSENT.has(textOf(args[1], source)) || textOf(args[1], source) === "[]")) ||
          (member === "ok" &&
            args.length >= 1 &&
            ts.isPrefixUnaryExpression(args[0]) &&
            args[0].operator === ts.SyntaxKind.ExclamationToken));
      if (pinned) {
        const actual = textOf(args[0], source);
        const bare = actual.replace(/^!/, "");
        const callsAPredicate = /^[A-Za-z_$][\w$]*\s*\(/.test(bare);
        const read = bare.match(/^[A-Za-z_$][\w$]*(?:\[[^\]]*\])?!?\.([A-Za-z_$][\w$]*)(\s*\()?/);
        const field = read && !read[2] && !BUILT_IN.has(read[1]) ? read[1] : null;
        found.push({
          file: path.relative(REPO, file),
          line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
          test: enclosingTestName(node, source),
          actual: actual.replace(/\s+/g, " ").slice(0, 90),
          expected: member === "ok" ? "!(…)" : textOf(args[1], source),
          callsAPredicate,
          field: callsAPredicate ? null : field,
        });
      }
    }
    ts.forEachChild(node, (child) => inspect(child, loop));
  };
  inspect(source, false);
  return { live, found };
}

const files = fs
  .readdirSync(TESTS)
  .filter((name) => name.endsWith(".test.ts"))
  .map((name) => path.join(TESTS, name));

let withLiveData = 0;
const all = [];
for (const file of files) {
  const { live, found } = pinnedAbsencesIn(file);
  if (live.size > 0) withLiveData++;
  all.push(...found);
}

const writers = ["scripts", "src"]
  .flatMap((dir) =>
    fs
      .readdirSync(path.join(REPO, dir))
      .filter((name) => /\.(ts|js|mjs)$/.test(name))
      .map((name) => fs.readFileSync(path.join(REPO, dir, name), "utf-8")),
  )
  .join("\n");

const writesTheField = (field) =>
  field !== null &&
  new RegExp(`(?:^|[^\\w$.])${field}\\s*:(?!:)|\\.${field}\\s*=(?!=)|\\[["'\`]${field}["'\`]\\]\\s*=`).test(writers);

const callingAPredicate = all.filter((entry) => entry.callsAPredicate);
const pinningAWrittenField = all.filter((entry) => writesTheField(entry.field));
const inTheClass = [...callingAPredicate, ...pinningAWrittenField];
const byFile = new Map();
for (const entry of inTheClass) byFile.set(entry.file, (byFile.get(entry.file) ?? 0) + 1);

console.log(`test files: ${files.length}`);
console.log(`reading live catalogue data: ${withLiveData}`);
console.log(`per-record absence assertions over live data: ${all.length}`);
console.log(`  pinning a predicate the production path calls: ${callingAPredicate.length}`);
console.log(`  pinning a field a writer in src/ or scripts/ sets: ${pinningAWrittenField.length}`);
console.log(`the class: ${inTheClass.length}, spread over ${byFile.size} files\n`);

for (const entry of inTheClass.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line)) {
  console.log(`${entry.file}:${entry.line}  ${entry.expected}${entry.field ? `  (field ${entry.field})` : ""}`);
  console.log(`    ${entry.test}`);
  console.log(`    ${entry.actual}`);
}
