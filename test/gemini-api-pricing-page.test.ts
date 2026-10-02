import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { changesByVendor, loadOffers } from "../dist/data.js";
import { supersedingChange } from "../dist/superseded-description.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");

const PAGE = "/gemini-api-pricing-2026";
const VENDOR_PAGE = "/vendor/google-gemini-api";

let server: ChildProcess;
let base = "";

function startServer(): Promise<ChildProcess> {
  return new Promise((resolve, reject) => {
    const proc = spawn("node", [path.join(root, "dist", "serve.js")], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, PORT: "0", BASE_URL: "http://localhost", TZ: "UTC" },
    });
    const timeout = setTimeout(() => {
      proc.kill();
      reject(new Error("Server startup timeout"));
    }, 20000);
    proc.stderr!.on("data", (data: Buffer) => {
      const match = data.toString().match(/running on http:\/\/localhost:(\d+)/);
      if (match) {
        base = `http://localhost:${match[1]}`;
        clearTimeout(timeout);
        resolve(proc);
      }
    });
    proc.on("error", (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });
}

const asServed = (text: string) =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const readable = (html: string) =>
  html
    .replace(/<script[\s\S]*?<\/script>/g, " ")
    .replace(/<style[\s\S]*?<\/style>/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ");

function listingBlock(html: string): string {
  const match = html.match(/<div class="context-box listing-in-full">[\s\S]*?\n  <\/div>/);
  return match ? match[0] : "";
}

function sourceLine(html: string): string {
  const match = html.match(/<p class="free-tier-source-line"[^>]*>[\s\S]*?<\/p>/);
  return match ? match[0] : "";
}

const listing = loadOffers().find((o) => o.vendor === "Google Gemini API")!;

let page = "";
let vendorPage = "";

before(async () => {
  server = await startServer();
  for (const [route, store] of [[PAGE, (html: string) => (page = html)], [VENDOR_PAGE, (html: string) => (vendorPage = html)]] as const) {
    const res = await fetch(base + route);
    assert.strictEqual(res.status, 200, route);
    store(await res.text());
  }
});

after(() => {
  server?.kill();
});

describe(`${PAGE} states the Google Gemini API listing`, () => {
  it("in full, with every free model, paid rate and credit condition the listing holds, unless a change record supersedes it", () => {
    assert.ok(listing, "the catalogue holds a Google Gemini API listing");
    const block = listingBlock(page);
    assert.notStrictEqual(block, "");
    const superseded = supersedingChange(listing, changesByVendor().get(listing.vendor.toLowerCase()) ?? []);
    if (superseded) {
      assert.ok(!block.includes(asServed(listing.description)));
      return;
    }
    assert.ok(block.includes(asServed(listing.description)), block);
  });

  it("with the read date and the pricing page link the vendor page gives for it", () => {
    assert.strictEqual(sourceLine(listingBlock(page)), sourceLine(vendorPage));
  });
});

describe(`${PAGE} on long prompts and prepaid credits`, () => {
  it("gives the Flash models' input token limit and does not call Gemini the largest free option", () => {
    const text = readable(page);
    assert.ok(!text.includes("largest free option"));
    assert.ok(text.includes("For long context: Gemini's Flash models accept up to 1,048,576 input tokens. Google no longer publishes free-tier token limits, so check your project's limits in AI Studio before relying on long prompts at no cost."));
  });

  it("says prepaid credits expire after 12 months and that a $0 balance stops every API key on the billing account", () => {
    const text = readable(page);
    assert.ok(text.includes("others choose between Prepay and Postpay. Prepaid credits expire 12 months after purchase and are non-refundable. When the balance reaches $0, every API key on the billing account stops working until you add credits."));
  });
});
