import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(__dirname, "..");

function textOf(html: string): string {
  return html.replace(/<[^>]+>/g, " ").replace(/&[a-z]+;|&#\d+;/g, " ").replace(/\s+/g, " ").trim();
}

describe("the shutdown tracker counts down only to dates a vendor set", () => {
  let proc: ChildProcess | null = null;
  let cards: { title: string; html: string; text: string }[] = [];
  let page = "";

  before(async () => {
    const child = spawn("node", [path.join(REPO, "dist", "serve.js")], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, PORT: "0", BASE_URL: "http://localhost", TZ: "UTC" },
    });
    proc = child;
    const port = await new Promise<number>((resolve, reject) => {
      const timeout = setTimeout(() => { child.kill(); reject(new Error("Server startup timeout")); }, 30000);
      child.stderr!.on("data", (data: Buffer) => {
        const m = data.toString().match(/running on http:\/\/localhost:(\d+)/);
        if (m) { clearTimeout(timeout); resolve(parseInt(m[1], 10)); }
      });
    });
    page = await (await fetch(`http://localhost:${port}/shutdowns`)).text();
    cards = page.split('<div class="shutdown-card"').slice(1).map((html) => ({
      title: textOf(html.match(/<h3[^>]*>([\s\S]*?)<\/h3>/)?.[1] ?? ""),
      html,
      text: textOf(html),
    }));
  });

  after(() => { proc?.kill(); });

  it("reads a card for every entry it lists", () => {
    assert.ok(cards.length >= 1, "the tracker lists no entry, so nothing below proves anything");
    for (const card of cards) assert.ok(card.title.length > 0, card.html.slice(0, 200));
  });

  it("never counts down to a date the entry itself says was not announced", () => {
    const contradicted = cards
      .filter((c) => /no\b[^.]{0,40}\bdate\b[^.]{0,20}\bannounced/i.test(c.text) && c.html.includes('class="days-badge"'))
      .map((c) => c.title);
    assert.deepStrictEqual(contradicted, []);
  });

  it("gives CodeCommit and Cloud9 no countdown, since AWS set no end date for either", () => {
    const counted = cards
      .filter((c) => /CodeCommit|Cloud9/.test(c.title) && c.html.includes('class="days-badge"'))
      .map((c) => c.title);
    assert.deepStrictEqual(counted, []);
    assert.ok(!/(CodeCommit|Cloud9)[^<]{0,400}December 31, 2026/.test(page), "a 2026-12-31 deadline is still printed beside CodeCommit or Cloud9");
  });

  it("states that Lambda keeps invoking functions on a deprecated runtime", () => {
    assert.ok(!/no invocations/i.test(textOf(page)));
    const lambda = cards.find((c) => /Node\.js 20 AWS Lambda/.test(c.title));
    assert.ok(lambda, "the Node.js 20 Lambda entry is missing");
    assert.ok(lambda!.text.includes("AWS never blocks invocations"), lambda!.text);
    assert.ok(lambda!.text.includes("February 1, 2027"), lambda!.text);
  });

  it("states that Proton's deployed stacks keep running", () => {
    const proton = cards.find((c) => /AWS Proton/.test(c.title));
    assert.ok(proton, "the AWS Proton entry is missing");
    assert.ok(!/will stop working/i.test(proton!.text), proton!.text);
    assert.ok(proton!.text.includes("Deployed CloudFormation stacks and the resources they manage keep running"), proton!.text);
  });
});
