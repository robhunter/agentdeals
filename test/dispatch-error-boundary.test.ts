import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { assertPopulationFloor } from "./population-floor.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(__dirname, "..");

const ABSENT_FROM_THE_IMAGE = ["glama.json", "AGENTS.md"];
const THROWN_ROUTE = "/fault/thrown";
const REJECTED_ROUTE = "/fault/rejected";
const AFTER_HEAD_ROUTE = "/fault/after-head";
const DISPATCH_REACHES_ITS_FIRST_ROUTE = "    if (url.pathname === SIGNAL_PATH) {";
const FAULTS = `
    if (url.pathname === "${THROWN_ROUTE}") { throw new Error("fault injected by a test"); }
    if (url.pathname === "${REJECTED_ROUTE}") { await new Promise((resolve) => setImmediate(resolve)); throw new Error("fault injected by a test"); }
    if (url.pathname === "${AFTER_HEAD_ROUTE}") { res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }); throw new Error("fault injected by a test"); }
`;

function stageAnImageWithFaultRoutesAndWithoutTheAbsentFiles(): string {
  const root = mkdtempSync(path.join(tmpdir(), "dispatch-boundary-"));
  for (const entry of readdirSync(REPO)) {
    if (entry === "dist" || entry === ".git" || ABSENT_FROM_THE_IMAGE.includes(entry)) continue;
    symlinkSync(path.join(REPO, entry), path.join(root, entry));
  }
  cpSync(path.join(REPO, "dist"), path.join(root, "dist"), { recursive: true });

  const servePath = path.join(root, "dist", "serve.js");
  const compiled = readFileSync(servePath, "utf-8");
  assert.strictEqual(
    compiled.split(DISPATCH_REACHES_ITS_FIRST_ROUTE).length - 1,
    1,
    "the compiled dispatch no longer reaches its first route where this test injects faults",
  );
  writeFileSync(servePath, compiled.replace(DISPATCH_REACHES_ITS_FIRST_ROUTE, FAULTS + DISPATCH_REACHES_ITS_FIRST_ROUTE));
  return root;
}

function startServer(root: string): Promise<{ proc: ChildProcess; port: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn("node", [path.join(root, "dist", "serve.js")], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, PORT: "0", BASE_URL: "http://localhost" },
    });
    const timeout = setTimeout(() => { child.kill(); reject(new Error("Server startup timeout")); }, 60000);
    child.stderr!.on("data", (data: Buffer) => {
      const m = data.toString().match(/running on http:\/\/localhost:(\d+)/);
      if (m) { clearTimeout(timeout); resolve({ proc: child, port: parseInt(m[1], 10) }); }
    });
    child.on("error", (err) => { clearTimeout(timeout); reject(err); });
  });
}

function stderrOf(proc: ChildProcess): () => string {
  let seen = "";
  proc.stderr!.on("data", (data: Buffer) => { seen += data.toString(); });
  return () => seen;
}

async function statusOf(port: number, routePath: string): Promise<number> {
  const res = await fetch(`http://localhost:${port}${routePath}`, { redirect: "manual", signal: AbortSignal.timeout(30000) });
  await res.arrayBuffer();
  return res.status;
}

async function stillServing(port: number): Promise<boolean> {
  try {
    return await statusOf(port, "/health") === 200;
  } catch {
    return false;
  }
}

function routeLiteralsOfTheDispatch(): string[] {
  const source = ts.createSourceFile(
    "serve.ts",
    readFileSync(path.join(REPO, "src", "serve.ts"), "utf-8"),
    ts.ScriptTarget.ES2022,
    true,
  );
  const isRequestPath = (node: ts.Node): boolean =>
    ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression) &&
    node.expression.text === "url" && node.name.text === "pathname";

  const literals = new Set<string>();
  const collect = (node: ts.Node) => {
    if (ts.isStringLiteral(node) && node.text.startsWith("/")) literals.add(node.text);
  };
  const walk = (node: ts.Node) => {
    if (ts.isBinaryExpression(node)) {
      const compares = node.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken ||
        node.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsEqualsToken;
      if (compares && isRequestPath(node.left)) collect(node.right);
      if (compares && isRequestPath(node.right)) collect(node.left);
    }
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && isRequestPath(node.expression.expression)) {
      for (const argument of node.arguments) collect(argument);
    }
    ts.forEachChild(node, walk);
  };
  walk(source);
  return [...literals].sort();
}

function sweepTargets(literals: string[]): string[] {
  const targets = new Set<string>();
  for (const literal of literals) {
    targets.add(literal);
    targets.add(literal.endsWith("/") ? literal : `${literal}/`);
    targets.add(literal.slice(0, literal.lastIndexOf("/") + 1));
  }
  return [...targets].sort();
}

let repoServer: ChildProcess | null = null;
let repoPort = 0;
let repoStderr: () => string = () => "";
let stagedServer: ChildProcess | null = null;
let stagedPort = 0;
let stagedRoot = "";

before(async () => {
  const repo = await startServer(REPO);
  repoServer = repo.proc;
  repoPort = repo.port;
  repoStderr = stderrOf(repo.proc);

  stagedRoot = stageAnImageWithFaultRoutesAndWithoutTheAbsentFiles();
  const staged = await startServer(stagedRoot);
  stagedServer = staged.proc;
  stagedPort = staged.port;
});

function stopped(proc: ChildProcess | null): Promise<void> {
  if (!proc || proc.exitCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    const giveUp = setTimeout(() => resolve(), 10000);
    proc.once("exit", () => { clearTimeout(giveUp); resolve(); });
    proc.kill();
  });
}

after(async () => {
  await Promise.all([stopped(repoServer), stopped(stagedServer)]);
  if (stagedRoot) rmSync(stagedRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe("#1576 a throw in a route handler is answered, not fatal", () => {
  it("answers 500 to the request that threw and keeps serving every other one", async () => {
    assert.strictEqual(await statusOf(stagedPort, THROWN_ROUTE), 500);
    assert.ok(await stillServing(stagedPort), "the server stopped answering after a route handler threw");
    assert.strictEqual(await statusOf(stagedPort, "/api/details/stripe"), 200);
  });

  it("answers a rejection raised after an await the same way", async () => {
    assert.strictEqual(await statusOf(stagedPort, REJECTED_ROUTE), 500);
    assert.ok(await stillServing(stagedPort), "the server stopped answering after an async route handler rejected");
  });

  it("answers 500 even where a handler had already written a 200 the page wrappers were holding", async () => {
    assert.strictEqual(await statusOf(stagedPort, AFTER_HEAD_ROUTE), 500);
    assert.ok(await stillServing(stagedPort), "the server stopped answering after a handler threw between its status and its body");
  });

  it("answers 500 to a path whose escape sequence cannot be decoded", async () => {
    assert.strictEqual(await statusOf(repoPort, "/api/details/%"), 500);
    assert.strictEqual(await statusOf(repoPort, "/api/vendor-risk/%"), 500);
    assert.strictEqual(await statusOf(repoPort, "/api/referral/%"), 500);
    assert.ok(await stillServing(repoPort), "the server stopped answering after a path it could not decode");
  });

  it("names the route and the error in the log, so a defect that no longer stops the server still announces itself", async () => {
    await statusOf(repoPort, "/api/details/%");
    await new Promise((resolve) => setTimeout(resolve, 200));
    const logged = repoStderr();
    assert.match(logged, /500 GET \/api\/details\/%/);
    assert.match(logged, /URIError/);
  });
});

describe("#1576 a file the image happens to carry is not what keeps a route from being fatal", () => {
  it("answers 404 for the connector card when it is absent", async () => {
    assert.strictEqual(await statusOf(stagedPort, "/.well-known/glama.json"), 404);
    assert.ok(await stillServing(stagedPort), "the server stopped answering after a request for an absent connector card");
  });

  it("answers 404 for the agent guide when it is absent", async () => {
    assert.strictEqual(await statusOf(stagedPort, "/AGENTS.md"), 404);
    assert.ok(await stillServing(stagedPort), "the server stopped answering after a request for an absent agent guide");
  });

  it("serves both of them from the repository, so the absence above is the only difference", async () => {
    assert.strictEqual(await statusOf(repoPort, "/.well-known/glama.json"), 200);
    assert.strictEqual(await statusOf(repoPort, "/AGENTS.md"), 200);
  });
});

describe("#1576 every route answers, including its trailing-slash and empty-segment forms", () => {
  it("reads the route literals out of the dispatch rather than a hand-written list", () => {
    const literals = routeLiteralsOfTheDispatch();
    assertPopulationFloor(literals.length, 150, "route literals read out of the dispatch");
    for (const expected of ["/health", "/mcp", "/api/docs/", "/.well-known/glama.json", "/AGENTS.md"]) {
      assert.ok(literals.includes(expected), `${expected} is served but was not read out of the dispatch`);
    }
  });

  it("answers every form of every route and is still serving at the end", async () => {
    const targets = sweepTargets(routeLiteralsOfTheDispatch());
    const unanswered: string[] = [];
    for (let i = 0; i < targets.length; i += 8) {
      await Promise.all(targets.slice(i, i + 8).map(async (target) => {
        try {
          const status = await statusOf(repoPort, target);
          if (!Number.isInteger(status)) unanswered.push(`${target} answered ${String(status)}`);
        } catch (err) {
          unanswered.push(`${target} — ${(err as Error).message}`);
        }
      }));
    }
    assert.deepStrictEqual(unanswered, [], `${unanswered.length} of ${targets.length} requests got no response`);
    assert.ok(await stillServing(repoPort), "the server stopped answering during the sweep");
  });
});
