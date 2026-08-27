import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MCP_INSTRUCTIONS } from "../dist/mcp-instructions.js";
import { MCP_SIGNAL_INSTRUCTIONS, PRIVACY_SCOPE } from "../dist/signal-copy.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(__dirname, "..");

let serverPort = 0;
let proc: ChildProcess | null = null;

function startServer(): Promise<ChildProcess> {
  return new Promise((resolve, reject) => {
    const child = spawn("node", [path.join(REPO, "dist", "serve.js")], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, PORT: "0", BASE_URL: "http://localhost" },
    });
    const timeout = setTimeout(() => { child.kill(); reject(new Error("Server startup timeout")); }, 20000);
    child.stderr!.on("data", (data: Buffer) => {
      const m = data.toString().match(/running on http:\/\/localhost:(\d+)/);
      if (m) { serverPort = parseInt(m[1], 10); clearTimeout(timeout); resolve(child); }
    });
    child.on("error", (err) => { clearTimeout(timeout); reject(err); });
  });
}

const text = async (p: string) => (await fetch(`http://localhost:${serverPort}${p}`)).text();

const SHARING_NOTICE = "verbatim with the vendor you name";
const POLICY_PROMISE = "You are told this at the point of submission";

before(async () => { proc = await startServer(); });
after(() => { if (proc) proc.kill(); });

describe("#1043 the privacy policy describes the service that actually runs", () => {
  it("permits sharing what senders submit with the vendor they name", async () => {
    const body = await text("/privacy");
    assert.match(body, /we may share that report/i);
    assert.match(body, /with the vendor it names/i);
  });

  it("does not deny collecting the things the service collects", async () => {
    const body = await text("/privacy");
    for (const denial of [
      "we do not collect data to share",
      "does not collect, store, or process any personal data",
      "Do not track individual users or sessions",
      "Does not collect or transmit data about the client or user",
      "Filter out known bot traffic",
    ]) {
      assert.ok(!body.includes(denial), `/privacy still carries a claim production contradicts: ${denial}`);
    }
  });

  it("does not promise the absence of something the service reserves the right to use", async () => {
    const body = await text("/privacy");
    const readable = body.replace(/<[^>]+>/g, " ");
    assert.ok(!/\bno cookies\b/i.test(readable), "/privacy promises no cookies while reserving their use");
  });
});

describe("#1043 the promise the policy makes about the intake surfaces holds", () => {
  it("states that a sender is told at the point of submission", async () => {
    const body = await text("/privacy");
    assert.ok(body.includes(POLICY_PROMISE), "the rest of this suite has no subject without this sentence");
  });

  it("tells the sender on the signal documentation page, where the note field is described", async () => {
    const body = await text("/signal");
    const fieldList = body.split("</p>").find((p) => p.includes("<code>note</code>"));
    assert.ok(fieldList, "the note field must be documented for this assertion to have a subject");
    assert.ok(fieldList.includes(SHARING_NOTICE), "/signal describes the note field without saying where a note can go");
    assert.ok(!fieldList.includes("never published"), "/signal tells a sender that a note stays with us");
  });

  it("tells the sender in llms.txt", async () => {
    const body = await text("/llms.txt");
    assert.ok(body.includes(SHARING_NOTICE), "llms.txt invites a note without saying where it can go");
  });

  it("tells the sender in the JSON block returned beside a recommendation", async () => {
    const body = await text("/api/details/Neon");
    const parsed = JSON.parse(body) as { _agent?: Record<string, string> };
    assert.ok(parsed._agent, "the details endpoint must carry the agent block for this assertion to have a subject");
    assert.ok(
      JSON.stringify(parsed._agent).includes(SHARING_NOTICE),
      "the agent block enumerates what a signal records without saying where a note can go",
    );
  });

  it("tells the sender in the response header that advertises the endpoint", async () => {
    const res = await fetch(`http://localhost:${serverPort}/vendor/neon`);
    const header = res.headers.get("x-agent-signal");
    assert.ok(header, "a 2xx page must carry the header for this assertion to have a subject");
    assert.ok(header.includes(SHARING_NOTICE), "the header advertises the endpoint without saying where a note can go");
  });

  it("tells the sender on both MCP surfaces", () => {
    assert.ok(MCP_INSTRUCTIONS.includes(SHARING_NOTICE), "the server instructions invite a note without saying where it can go");
    assert.ok(MCP_SIGNAL_INSTRUCTIONS.includes(SHARING_NOTICE), "the MCP invitation omits where a note can go");
  });

  it("enumerates the note wherever it enumerates what a signal records", () => {
    assert.ok(PRIVACY_SCOPE.includes("note"), "the scoped sentence lists what a signal records and omits the note");
  });
});
