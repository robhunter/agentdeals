import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

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

const MONTHS = ["January","February","March","April","May","June","July","August","September","October","November","December"];

before(async () => { proc = await startServer(); });
after(() => { if (proc) proc.kill(); });

describe("#1043 the privacy policy's own freshness claim", () => {
  it("does not tell a search engine the document changed today", async () => {
    const body = await (await fetch(`http://localhost:${serverPort}/privacy`)).text();

    const jsonLd = body.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)?.[1];
    assert.ok(jsonLd, "/privacy must carry JSON-LD for this assertion to have a subject");
    const { dateModified } = JSON.parse(jsonLd);
    assert.ok(dateModified, "the JSON-LD must carry a dateModified");

    const today = new Date().toISOString().slice(0, 10);
    assert.notStrictEqual(
      dateModified,
      today,
      "dateModified equals today, which is what an automatic new Date() produces on a document nobody edited",
    );
  });

  it("publishes the same date to a search engine and to a reader", async () => {
    const body = await (await fetch(`http://localhost:${serverPort}/privacy`)).text();

    const jsonLd = body.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)?.[1];
    const { dateModified } = JSON.parse(jsonLd!);

    const visible = body.match(/class="updated">Last updated: ([A-Z][a-z]+) (\d{1,2}), (\d{4})</);
    assert.ok(visible, "/privacy must render a visible last-updated line for this assertion to have a subject");

    const month = String(MONTHS.indexOf(visible[1]) + 1).padStart(2, "0");
    assert.notStrictEqual(month, "00", `unrecognised month ${visible[1]}`);
    const rendered = `${visible[3]}-${month}-${visible[2].padStart(2, "0")}`;

    assert.strictEqual(dateModified, rendered, "the structured data and the visible text disagree about when this policy last changed");
  });
});
