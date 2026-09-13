import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertPopulationFloor } from "./population-floor.ts";
import { changesByVendor, loadOffers } from "../dist/data.js";
import { supersedingChange } from "../dist/superseded-description.js";
import { unconfirmedTermsForOffer } from "../dist/vendor-verdict-input.js";
import { unconfirmedTermsSentence } from "../dist/vendor-verdict.js";
import { getGuideList } from "../dist/guides.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(__dirname, "..");

const STATED_IN_A_HAND_WRITTEN_BLOCK = new Set([
  "/free-startup-stack",
  "/free-ai-stack",
  "/free-frontend-stack",
  "/free-nextjs-stack",
  "/free-django-stack",
  "/free-fastapi-stack",
  "/free-go-stack",
  "/free-saas-stack",
  "/ai-coding-tools-pricing",
  "/llm-api-pricing",
]);

const asServed = (text: string) =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const readable = (html: string) => html
  .replace(/<script[\s\S]*?<\/script>/g, " ")
  .replace(/<datalist[\s\S]*?<\/datalist>/g, " ")
  .replace(/<select[\s\S]*?<\/select>/g, " ")
  .replace(/<style[\s\S]*?<\/style>/g, " ");

interface StatedTerms {
  vendor: string;
  tier: string;
  terms: string;
  sentence: string;
}

function termsWeCannotConfirm(): StatedTerms[] {
  const changes = changesByVendor();
  const stated: StatedTerms[] = [];
  for (const offer of loadOffers()) {
    if (supersedingChange(offer, changes.get(offer.vendor.toLowerCase()) ?? [])) continue;
    const unconfirmed = unconfirmedTermsForOffer(offer);
    if (!unconfirmed) continue;
    if (!offer.description || offer.description.length < 25) continue;
    stated.push({
      vendor: offer.vendor,
      tier: offer.tier,
      terms: asServed(offer.description),
      sentence: asServed(unconfirmedTermsSentence(unconfirmed)),
    });
  }
  return stated;
}

function startServer(): Promise<{ proc: ChildProcess; base: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn("node", [path.join(REPO, "dist", "serve.js")], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, PORT: "0", BASE_URL: "http://127.0.0.1" },
    });
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("the server did not start")); }, 120_000);
    child.stderr.on("data", (chunk: Buffer) => {
      const running = chunk.toString().match(/running on http:\/\/localhost:(\d+)/);
      if (running) { clearTimeout(timer); resolve({ proc: child, base: `http://127.0.0.1:${running[1]}` }); }
    });
    child.on("error", (err) => { clearTimeout(timer); reject(err); });
  });
}

describe("a guide that states terms we cannot confirm says so beside them", () => {
  let proc: ChildProcess | undefined;
  let refused = "";
  const pages = new Map<string, string>();
  const stated = termsWeCannotConfirm();

  before(async () => {
    try {
      const server = await startServer();
      proc = server.proc;
      for (const guide of getGuideList()) {
        const at = `/${guide.slug}`;
        const res = await fetch(`${server.base}${at}`, { redirect: "manual" });
        if (res.status !== 200) { refused = `${at} answered ${res.status}`; return; }
        pages.set(at, readable(await res.text()));
      }
    } catch (err) {
      refused = (err as Error).message;
    }
  });

  after(() => { proc?.kill("SIGKILL"); });

  const publishedBy = (html: string) => stated.filter((record) => html.includes(record.terms));

  it("reads every guide, and publishes terms it cannot confirm on more than a handful of them", () => {
    assert.strictEqual(refused, "", refused);
    assertPopulationFloor(pages.size, 60, "guides answered a read");
    const owing = [...pages.values()].filter((html) => publishedBy(html).length > 0);
    assertPopulationFloor(owing.length, 25, "guides publish terms we cannot confirm");
    assertPopulationFloor(
      [...pages.values()].reduce((total, html) => total + publishedBy(html).length, 0),
      400,
      "guide listings state terms we cannot confirm",
    );
  });

  it("closes each of those listings with the reason we cannot confirm them", () => {
    assert.strictEqual(refused, "", refused);
    const bare: string[] = [];
    for (const [at, html] of pages) {
      if (STATED_IN_A_HAND_WRITTEN_BLOCK.has(at)) continue;
      for (const record of publishedBy(html)) {
        if (!html.includes(record.sentence)) bare.push(`${at} — ${record.vendor} (${record.tier})`);
      }
    }
    assert.deepStrictEqual(bare, [], "these guides state terms our own vendor page says we cannot confirm, and say nothing beside them");
  });

  it("takes the sentence from the function the vendor page and the ranked card take it from", () => {
    assert.strictEqual(refused, "", refused);
    const carried = new Set<string>();
    for (const [at, html] of pages) {
      if (STATED_IN_A_HAND_WRITTEN_BLOCK.has(at)) continue;
      for (const record of publishedBy(html)) {
        if (html.includes(record.sentence)) carried.add(`${at}|${record.vendor}`);
      }
    }
    assertPopulationFloor(carried.size, 400, "guide listings carry the sentence unconfirmedTermsFrom builds");
  });

  it("holds the guides it leaves out to being guides this sweep still reads", () => {
    assert.strictEqual(refused, "", refused);
    assert.deepStrictEqual(
      [...STATED_IN_A_HAND_WRITTEN_BLOCK].filter((at) => !pages.has(at)),
      [],
      "a guide left out of the sweep above is no longer one of the guides being read, so leaving it out covers nothing",
    );
  });
});
