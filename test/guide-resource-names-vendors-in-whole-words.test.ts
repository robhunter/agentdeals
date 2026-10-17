import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const WHOLE_LOG = "2020-01-01";
const RELATED_CHANGES_SHOWN = 5;
const NAME_INSIDE_GUIDE_WORDS = "Gem";

type Change = { vendor: string; date: string; change_type: string; summary: string; resolution?: { state?: string } | null; current_state?: string };
type Guide = { slug: string; title: string };
type Listed = { uri: string };

const changeLog: Change[] = JSON.parse(readFileSync(path.join(REPO, "data", "deal_changes.json"), "utf-8")).changes;
const servedByDefault = (change: Change) => change.resolution?.state !== "retracted" && change.current_state !== "Removed from index";
const planted: Change = {
  ...changeLog.find(servedByDefault)!,
  vendor: NAME_INSIDE_GUIDE_WORDS,
  date: "2021-01-01",
  summary: "A record filed under a name that sits inside words of guide slugs",
};
const dir = mkdtempSync(path.join(tmpdir(), "guide-resource-names-vendors-in-whole-words-"));
const scratchChanges = path.join(dir, "deal_changes.json");
writeFileSync(scratchChanges, JSON.stringify({ changes: [...changeLog, planted] }));
process.env.AGENTDEALS_CHANGES_PATH = scratchChanges;

const { getGuideList, guideNamesVendor } = await import("../dist/guides.js");
const { loadDealChanges } = await import("../dist/data.js");

const guides = getGuideList() as Guide[];
const words = (text: string) => text.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
const holdsInOrder = (haystack: string[], run: string[]) =>
  run.length > 0 && haystack.some((_, start) => run.every((word, offset) => haystack[start + offset] === word));
const subjectOf = (slug: string) => slug.replace(/-alternatives$/, "").replace(/-vs-.*/, "");
const namedInWholeWords = (slug: string, vendor: string) =>
  holdsInOrder(words(slug), words(vendor)) || holdsInOrder(words(vendor), words(subjectOf(slug)));
const namedInLetters = (slug: string, vendor: string) => {
  const vendorSlug = vendor.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  return slug.includes(vendorSlug) || vendorSlug.includes(subjectOf(slug));
};
const relatedLine = (change: Change) => `- **${change.date}** | ${change.vendor} [${change.change_type}] ${change.summary}`;
const expectedLines = (slug: string, changes: Change[]) =>
  changes.filter(change => namedInWholeWords(slug, change.vendor)).slice(0, RELATED_CHANGES_SHOWN).map(relatedLine);
const relatedLinesIn = (text: string) => {
  const after = text.split("\n## Related Pricing Changes\n\n")[1];
  return after === undefined ? [] : after.split("\n## ")[0]!.split("\n").filter(line => line.startsWith("- **"));
};
const guidesWhereLettersAndWordsDisagree = (changes: Change[]) =>
  guides.filter(guide => changes.some(change => namedInLetters(guide.slug, change.vendor) !== namedInWholeWords(guide.slug, change.vendor)));

function startServer(): Promise<{ proc: ChildProcess; base: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn("node", [path.join(REPO, "dist", "serve.js")], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, PORT: "0", BASE_URL: "http://localhost", TZ: "UTC", AGENTDEALS_CHANGES_PATH: scratchChanges },
    });
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("server startup timeout")); }, 60000);
    child.stderr!.on("data", (buffer: Buffer) => {
      const found = buffer.toString().match(/running on http:\/\/localhost:(\d+)/);
      if (found) { clearTimeout(timer); resolve({ proc: child, base: `http://localhost:${found[1]}` }); }
    });
    child.on("error", (err) => { clearTimeout(timer); reject(err); });
  });
}

async function askTheHostedServer(base: string, requests: Array<{ method: string; params: unknown }>): Promise<unknown[]> {
  const post = async (body: unknown, sessionId?: string | null) => {
    const response = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...(sessionId ? { "mcp-session-id": sessionId } : {}) },
      body: JSON.stringify(body),
    });
    const text = await response.text();
    const data = text.match(/^data: (.*)$/m);
    return { sessionId: response.headers.get("mcp-session-id"), payload: text ? JSON.parse(data ? data[1]! : text) : null };
  };
  const opened = await post({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "guide-resource-names-vendors-in-whole-words", version: "1" } } });
  assert.ok(opened.sessionId, "the hosted MCP server opened no session");
  await post({ jsonrpc: "2.0", method: "notifications/initialized" }, opened.sessionId);
  const answers: unknown[] = [];
  for (const [index, request] of requests.entries()) {
    const { payload } = await post({ jsonrpc: "2.0", id: index + 2, ...request }, opened.sessionId);
    answers.push(payload);
  }
  return answers;
}

function askTheStdioPackage(base: string, requests: Array<{ method: string; params: unknown }>): Promise<unknown[]> {
  const child = spawn("node", [path.join(REPO, "dist", "index.js")], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, AGENTDEALS_API_URL: base },
  });
  const answers = new Map<number, unknown>();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(new Error("stdio MCP timeout")); }, 120000);
    let buffer = "";
    child.stdout!.on("data", (chunk: Buffer) => {
      buffer += chunk.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        let payload: { id?: number };
        try { payload = JSON.parse(line); } catch { continue; }
        if (typeof payload.id !== "number" || payload.id < 2) continue;
        answers.set(payload.id, payload);
        if (answers.size === requests.length) {
          clearTimeout(timer);
          child.kill();
          resolve(requests.map((_, index) => answers.get(index + 2)));
        }
      }
    });
    child.on("error", (err) => { clearTimeout(timer); reject(err); });
    child.stdin!.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "guide-resource-names-vendors-in-whole-words", version: "1" } } })}\n`);
    child.stdin!.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
    requests.forEach((request, index) => child.stdin!.write(`${JSON.stringify({ jsonrpc: "2.0", id: index + 2, ...request })}\n`));
  });
}

type Ask = (base: string, requests: Array<{ method: string; params: unknown }>) => Promise<unknown[]>;

async function readEveryListedGuide(ask: Ask, base: string): Promise<Map<string, string>> {
  const [listing] = await ask(base, [{ method: "resources/list", params: {} }]) as Array<{ result: { resources: Listed[] } }>;
  const uris = listing!.result.resources.map(resource => resource.uri).filter(uri => uri.startsWith("agentdeals://guide/"));
  const answers = await ask(base, uris.map(uri => ({ method: "resources/read", params: { uri } }))) as Array<{ result?: { contents: Array<{ text: string }> }; error?: { message: string } }>;
  return new Map(uris.map((uri, index) => [uri, answers[index]!.result?.contents[0]!.text ?? `ERROR ${answers[index]!.error?.message}`]));
}

async function everyRecordTheApiServes(base: string): Promise<Change[]> {
  const { total } = await (await fetch(`${base}/api/changes?since=${WHOLE_LOG}&limit=0`)).json() as { total: number };
  return (await (await fetch(`${base}/api/changes?since=${WHOLE_LOG}&limit=${total}`)).json() as { changes: Change[] }).changes;
}

function guidesReadWrong(read: Map<string, string>): string[] {
  return guides
    .filter(guide => !read.get(`agentdeals://guide/${guide.slug}`)?.startsWith(`# ${guide.title}\n`))
    .map(guide => `${guide.slug}: ${(read.get(`agentdeals://guide/${guide.slug}`) ?? "not listed").split("\n")[0]}`);
}

function relatedChangesListedWrong(read: Map<string, string>, changes: Change[]): string[] {
  return guides
    .map(guide => ({ guide, listed: relatedLinesIn(read.get(`agentdeals://guide/${guide.slug}`) ?? ""), expected: expectedLines(guide.slug, changes) }))
    .filter(({ listed, expected }) => JSON.stringify(listed) !== JSON.stringify(expected))
    .map(({ guide, listed, expected }) => `${guide.slug}: lists ${listed.map(line => line.split(" [")[0]).join("; ") || "nothing"}, expected ${expected.map(line => line.split(" [")[0]).join("; ") || "nothing"}`);
}

describe("a guide resource relates the changes of vendors its slug names in whole words, and every listed guide can be read", () => {
  let server: { proc: ChildProcess; base: string };

  before(async () => {
    server = await startServer();
  });

  after(() => server?.proc.kill());

  it("names no guide for a vendor name with no letters or digits", () => {
    assert.deepStrictEqual(guides.filter(guide => guideNamesVendor(guide.slug, " — ")).map(guide => guide.slug), []);
  });

  it("relates to a comparison guide a vendor whose name holds its first subject as a word, and not one holding it inside a longer word", () => {
    const comparison = guides.find(guide => guide.slug.includes("-vs-"));
    assert.ok(comparison, "no guide compares two vendors");
    const subject = subjectOf(comparison.slug);
    assert.strictEqual(guideNamesVendor(comparison.slug, `${subject} Platform`), true);
    assert.strictEqual(guideNamesVendor(comparison.slug, `${subject}bot`), false);
  });

  it("lists on every hosted guide the first five records whose vendor the slug names in whole words", async () => {
    const changes = loadDealChanges() as Change[];
    assert.ok(
      changes.some(change => change.vendor === NAME_INSIDE_GUIDE_WORDS && change.summary === planted.summary),
      "the hosted server's change log does not hold the planted record",
    );
    assert.ok(
      guidesWhereLettersAndWordsDisagree(changes).length > 0,
      "no vendor's name sits inside a word of a guide's slug, so matching by letters would go unseen",
    );
    const read = await readEveryListedGuide(askTheHostedServer, server.base);
    assert.deepStrictEqual(relatedChangesListedWrong(read, changes), []);
  });

  it("lists on every stdio guide the first five served records whose vendor the slug names in whole words", async () => {
    const changes = await everyRecordTheApiServes(server.base);
    assert.ok(
      changes.some(change => change.vendor === NAME_INSIDE_GUIDE_WORDS && change.summary === planted.summary),
      "the API does not serve the planted record by default",
    );
    assert.ok(
      guidesWhereLettersAndWordsDisagree(changes).length > 0,
      "no served vendor's name sits inside a word of a guide's slug, so matching by letters would go unseen",
    );
    const read = await readEveryListedGuide(askTheStdioPackage, server.base);
    assert.deepStrictEqual(relatedChangesListedWrong(read, changes), []);
  });

  it("reads every guide resources/list gives, on the hosted server and through the stdio package", async () => {
    assert.ok(guides.some(guide => guide.slug.includes("/")), "no guide's slug holds a slash, so a template that stops at one would go unseen");
    assert.deepStrictEqual(guidesReadWrong(await readEveryListedGuide(askTheHostedServer, server.base)), []);
    assert.deepStrictEqual(guidesReadWrong(await readEveryListedGuide(askTheStdioPackage, server.base)), []);
  });
});
