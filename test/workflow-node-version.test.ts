import { describe, it } from "node:test";
import assert from "node:assert";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname, resolve, relative } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = join(__dirname, "..");
const WORKFLOWS = join(REPO, ".github", "workflows");

const TYPE_STRIPPING_MAJOR = 22;

function workflowFiles(): string[] {
  return readdirSync(WORKFLOWS).filter(f => /\.ya?ml$/.test(f)).sort();
}

function nodeMajorOf(source: string): number | null {
  const declared = [...source.matchAll(/node-version:\s*"?([0-9]+)(?:\.[0-9.]+)?"?/g)].map(m => Number(m[1]));
  if (declared.length === 0) return null;
  return Math.min(...declared);
}

function invokedScripts(source: string): string[] {
  const direct = [...source.matchAll(/node\s+(scripts\/[A-Za-z0-9._-]+\.m?js)/g)].map(m => m[1]);
  const viaNpm = [...source.matchAll(/npm\s+run\s+([A-Za-z0-9:_-]+)/g)].map(m => m[1]);
  const pkg = JSON.parse(readFileSync(join(REPO, "package.json"), "utf8")) as { scripts: Record<string, string> };
  for (const name of viaNpm) {
    for (const m of (pkg.scripts[name] ?? "").matchAll(/(scripts\/[A-Za-z0-9._-]+\.m?js)/g)) direct.push(m[1]);
  }
  return [...new Set(direct)];
}

function resolveSpecifier(fromFile: string, specifier: string): string | null {
  if (!specifier.startsWith(".")) return null;
  const target = resolve(dirname(fromFile), specifier);
  if (existsSync(target)) return target;
  const swapped = target.replace(/\.js$/, ".ts");
  return existsSync(swapped) ? swapped : null;
}

function strippedTypeImports(entry: string): string[] {
  const seen = new Set<string>();
  const needsStripping: string[] = [];
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.shift()!;
    if (seen.has(file)) continue;
    seen.add(file);
    if (!existsSync(file)) continue;
    const source = readFileSync(file, "utf8");
    for (const m of source.matchAll(/(?:from|import)\s*\(?\s*["']([^"']+)["']/g)) {
      const target = resolveSpecifier(file, m[1]);
      if (!target) continue;
      if (target.endsWith(".ts")) needsStripping.push(`${relative(REPO, file)} imports ${relative(REPO, target)}`);
      queue.push(target);
    }
  }
  return needsStripping;
}

describe("#1198 a scheduled workflow cannot be pinned below the Node its scripts need", () => {
  it("reads the workflows, so the assertions below have subjects", () => {
    const files = workflowFiles();
    assert.ok(files.length > 3, `this test needs workflows to check, found ${files.length}`);
    const withScripts = files.filter(f => invokedScripts(readFileSync(join(WORKFLOWS, f), "utf8")).length > 0);
    assert.ok(withScripts.length > 0, "no workflow runs a script, so the assertion below checks nothing");
  });

  it("runs every workflow's scripts on a Node that can load their imports", () => {
    const offenders: string[] = [];
    let scriptsWalked = 0;
    for (const file of workflowFiles()) {
      const source = readFileSync(join(WORKFLOWS, file), "utf8");
      const major = nodeMajorOf(source);
      if (major === null) continue;
      for (const script of invokedScripts(source)) {
        scriptsWalked += 1;
        const stripped = strippedTypeImports(join(REPO, script));
        if (stripped.length > 0 && major < TYPE_STRIPPING_MAJOR) {
          offenders.push(`${file} pins Node ${major} and runs ${script}, where ${stripped[0]}`);
        }
      }
    }
    assert.ok(scriptsWalked > 3, `the sweep must actually walk scripts, walked ${scriptsWalked}`);
    assert.deepStrictEqual(offenders, [], `these jobs fail at import on every run: ${offenders.join("; ")}`);
  });
});
