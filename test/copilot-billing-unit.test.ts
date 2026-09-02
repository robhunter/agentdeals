import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(__dirname, "..");

const AI_CODING_PAGES = ["/ai-coding-pricing-2026", "/ai-coding-tools-pricing"];
const PREMIUM_REQUEST_QUANTITY = /\b\d[\d,]*\s+premium[ -]requests?\b/gi;

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

const get = async (p: string) => (await fetch(`http://localhost:${serverPort}${p}`)).text();

const rowsOf = (body: string) => body.match(/<tr[^>]*>[\s\S]*?<\/tr>/g) ?? [];
const isChangeRow = (row: string) => /<td[^>]*>[A-Z][a-z]{2} \d{1,2}, \d{4}<\/td>/.test(row);
const withoutChangeRows = (body: string) =>
  rowsOf(body).filter(isChangeRow).reduce((rest, row) => rest.replace(row, ""), body);

const sentencesOf = (body: string) =>
  body.replace(/<[^>]*>/g, "\n").split(/(?<=[.;!?])\s+|\n+/).map(s => s.trim()).filter(Boolean);

describe("GitHub Copilot is priced in the unit GitHub bills in", () => {
  it("states no premium-request quantity in any page literal", () => {
    const source = readFileSync(path.join(REPO, "src", "serve.ts"), "utf-8");
    assert.deepStrictEqual(source.match(PREMIUM_REQUEST_QUANTITY) ?? [], []);
  });

  it("holds a catalogue record for Copilot Free that states its allowance in AI credits", () => {
    const offers: Array<{ vendor: string; tier: string; description: string }> = JSON.parse(
      readFileSync(path.join(REPO, "data", "index.json"), "utf-8")
    ).offers;
    const free = offers.find(o => o.vendor === "GitHub Copilot" && o.tier === "Free");
    assert.ok(free, "the catalogue holds GitHub Copilot's free tier");
    assert.match(free!.description, /AI Credits/i);
    assert.doesNotMatch(free!.description, PREMIUM_REQUEST_QUANTITY);
  });
});

describe("the AI coding pages carry Copilot's current plan ladder", () => {
  before(async () => { proc = await startServer(); });
  after(() => { proc?.kill(); });

  it("names Max as the top individual plan on both pages", async () => {
    for (const page of AI_CODING_PAGES) {
      assert.match(await get(page), /\$100\/mo \(Max\)/, `${page} omits Copilot Max`);
    }
  });

  it("names the AI-credit unit and its price on both pages", async () => {
    for (const page of AI_CODING_PAGES) {
      const body = await get(page);
      assert.match(body, /AI Credits at \$0\.01/i, `${page} states no price for an AI credit`);
      assert.doesNotMatch(body, /Tier \+ premium requests/i, `${page} bills Copilot in the retired unit`);
    }
  });

  it("states the retired unit only as retired, outside the change log", async () => {
    for (const page of AI_CODING_PAGES) {
      const currentFacts = withoutChangeRows(await get(page));
      const stated = sentencesOf(currentFacts)
        .filter(s => /premium[ -]requests?/i.test(s))
        .filter(s => !/retired|legacy/i.test(s))
        .filter(s => !/\bno\b[^.]*premium[ -]request/i.test(s));
      assert.deepStrictEqual(stated, [], `${page} states the premium-request unit as a current fact`);
    }
  });

  it("shows the whole hidden-cost note, not a truncation of it", async () => {
    const body = await get("/ai-coding-tools-pricing");
    assert.doesNotMatch(body, /monthly a\.\.\./, "the hidden-cost cell is cut mid-word");
    assert.match(body, /the \$0\.04 per-request overage are retired/, "the hidden-cost cell stops before the correction");
  });

  it("prices Cursor's paid ladder at the figures its pricing page publishes", async () => {
    for (const page of AI_CODING_PAGES) {
      const body = await get(page);
      assert.match(body, /\$200\/mo \(Ultra\)/, `${page} omits Cursor Ultra's price`);
      assert.match(body, /Pro\+ \$60\/mo/, `${page} omits Cursor Pro\\+'s price`);
    }
  });
});
