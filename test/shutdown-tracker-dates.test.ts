import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { countsDownTo, shutdownDeadlineHtml } from "../dist/shutdown-deadline.js";
import { FIGURE_SOURCE_CLASS } from "../dist/source-citation.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(__dirname, "..");

function textOf(html: string): string {
  return html.replace(/<[^>]+>/g, " ").replace(/&[a-z]+;|&#\d+;/g, " ").replace(/\s+/g, " ").trim();
}

function printedDeadline(cardHtml: string): string | undefined {
  return cardHtml.match(/<div class="shutdown-deadline"[^>]*>\s*<span class="deadline-icon">[^<]*<\/span>\s*<span>([^<]*)<\/span>/)?.[1];
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

  it("cites beside every date the vendor page it comes from", () => {
    const uncited = cards
      .filter((c) => {
        const deadline = c.html.match(/<div class="shutdown-deadline"[\s\S]*?<\/div>/)?.[0] ?? "";
        return !new RegExp(`<a href="https?://[^"]+"[^>]*class="${FIGURE_SOURCE_CLASS}"`).test(deadline);
      })
      .map((c) => c.title);
    assert.deepStrictEqual(uncited, []);
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
  });

  it("dates Lambda's Node.js 20 blocks to AWS's July 29 and August 31, 2027, and sorts the card by the first", () => {
    const lambda = cards.find((c) => /Node\.js 20 AWS Lambda/.test(c.title));
    assert.ok(lambda, "the Node.js 20 Lambda entry is missing");
    assert.strictEqual(printedDeadline(lambda!.html), "July 29, 2027");
    assert.ok(lambda!.text.includes("Lambda blocks creating functions on nodejs20.x from 2027-07-29 and updating them from 2027-08-31."), lambda!.text);
    const section = page.split("<h2").find((html) => html.includes("Node.js 20 AWS Lambda Runtime</a></h3>"))!;
    const deadlines = section.split('<div class="shutdown-card"').slice(1).map((html) => Date.parse(`${printedDeadline(html)} UTC`));
    assert.ok(deadlines.length >= 2 && deadlines.every((at) => !Number.isNaN(at)), `the Lambda card's section holds no other dated card: ${deadlines}`);
    assert.deepStrictEqual(deadlines, [...deadlines].sort((a, b) => a - b), "the Lambda card's section is not in deadline order");
  });

  it("states that Proton's deployed stacks keep running", () => {
    const proton = cards.find((c) => /AWS Proton/.test(c.title));
    assert.ok(proton, "the AWS Proton entry is missing");
    assert.ok(!/will stop working/i.test(proton!.text), proton!.text);
    assert.ok(proton!.text.includes("Deployed CloudFormation stacks and the resources they manage keep running"), proton!.text);
  });

  it("dates WorkSpaces Thin Client to AWS's end of support, and says existing customers can still buy devices until then", () => {
    const thinClient = cards.find((c) => /WorkSpaces Thin Client/.test(c.title));
    assert.ok(thinClient, "the WorkSpaces Thin Client entry is missing");
    assert.ok(thinClient!.text.includes("March 31, 2027"), thinClient!.text);
    assert.ok(!/continue working|continues to function|Cannot purchase/i.test(thinClient!.text), thinClient!.text);
    assert.ok(thinClient!.text.includes("can still buy devices"), thinClient!.text);
  });

  it("states that only the Tenor API ended, in the past tense", () => {
    const tenor = cards.find((c) => /Tenor API/.test(c.title));
    assert.ok(tenor, "the Tenor API entry is missing");
    assert.ok(!/will stop working|Complete API shutdown|service discontinued/i.test(tenor!.text), tenor!.text);
    assert.ok(tenor!.text.includes("Only the API ended"), tenor!.text);
  });

  it("states that existing App Runner customers can still create services", () => {
    const appRunner = cards.find((c) => /App Runner/.test(c.title));
    assert.ok(appRunner, "the App Runner entry is missing");
    assert.ok(!/Cannot create new App Runner services/i.test(appRunner!.text), appRunner!.text);
    assert.ok(appRunner!.text.includes("including creating new services"), appRunner!.text);
  });
});

describe("a date on the shutdown tracker", () => {
  const esc = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const shown = { date: "June 30, 2026", color: "#f85149", countdown: "5 days left" };

  it("counts down only beside a date that cites the vendor page it comes from", () => {
    const cited = shutdownDeadlineHtml({ deadline: "2026-06-30", dateSource: "https://example.com/notice" }, shown, esc);
    const uncited = shutdownDeadlineHtml({ deadline: "2026-06-30" }, shown, esc);
    assert.match(cited, /class="days-badge"/);
    assert.match(cited, new RegExp(`<a href="https://example\\.com/notice"[^>]*class="${FIGURE_SOURCE_CLASS}"`));
    assert.doesNotMatch(uncited, /class="days-badge"/);
    assert.doesNotMatch(uncited, new RegExp(FIGURE_SOURCE_CLASS));
    assert.match(uncited, /June 30, 2026/);
  });

  it("takes only a web address as the page a date comes from", () => {
    assert.strictEqual(countsDownTo({ deadline: "2026-06-30", dateSource: "https://example.com/notice" }), true);
    assert.strictEqual(countsDownTo({ deadline: "2026-06-30" }), false);
    assert.strictEqual(countsDownTo({ deadline: "2026-06-30", dateSource: "" }), false);
    assert.strictEqual(countsDownTo({ deadline: "2026-06-30", dateSource: "AWS announcement" }), false);
  });
});
