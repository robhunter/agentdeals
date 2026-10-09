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
    assert.ok(text.includes("and stop being used when the Prepay balance reaches $0. Prepaid credits expire 12 months after purchase and are non-refundable. When the balance reaches $0, every API key on the billing account stops working until you add credits."));
  });

  it("links the move to Prepay to Google's billing page and the reported cutover date to the article that reports it", () => {
    const prepaid = page.slice(page.indexOf('<h2 id="prepaid">'));
    assert.ok(prepaid.includes('<a href="https://ai.google.dev/gemini-api/docs/billing" target="_blank" rel="noopener">Google is moving existing paid accounts from Postpay to Prepay for Gemini API usage</a>: switch on the AI Studio Billing page'));
    assert.ok(prepaid.includes('in your account notice, <a href="https://www.watch.impress.co.jp/docs/news/2132505.html" target="_blank" rel="noopener">reported as October 12, 2026</a>, or the account'));
  });
});

function tierSection(html: string): string {
  const start = html.indexOf('<h2 id="new-tiers">');
  const end = html.indexOf('<h2 id="prepaid">');
  return start >= 0 && end > start ? html.slice(start, end) : "";
}

function keyConstraintByTier(html: string): Record<string, string> {
  const rows = [...tierSection(html).matchAll(/<tr>([\s\S]*?)<\/tr>/g)]
    .map(([, row]) => [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map(([, cell]) => readable(cell).trim()))
    .filter((cells) => cells.length > 0);
  return Object.fromEntries(rows.map((cells) => [cells[0], cells[cells.length - 1]]));
}

const SPEND_BASED_RATE_LIMIT =
  "Spend-based rate limit: paid tiers can also be limited to a maximum spend over any rolling 10 minutes: $10 on Tier 1, $50 on Tier 2 and $200 on Tier 3. Above it, the API returns a 429 RESOURCE_EXHAUSTED error. Google says whether this limit applies depends on the account's billing history. The Tier 2 and Tier 3 payment thresholds count all Google Cloud spending on the billing account, not only the Gemini API.";

const PREPAY_HEADING = '<h3 style="color:#d29922">Prepaid billing for all paid accounts</h3>';

function prepayParagraph(html: string): string {
  const card = html.slice(html.indexOf(PREPAY_HEADING));
  const match = card.match(/<p class="impact-desc">[\s\S]*?<\/p>/);
  return match ? match[0] : "";
}

const withoutTags = (html: string) => html.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();

describe(`${PAGE} on paying after use once Prepay starts`, () => {
  it("says what cannot be undone, then the route that bills after use, at the Gemini API's paid-tier prices", () => {
    const text = withoutTags(prepayParagraph(page));
    assert.ok(text.includes(
      "Google's billing FAQ states that accounts cannot switch from Prepay to Postpay, and Prepay is not available for invoiced accounts. " +
      "To pay after use instead of prepaying, use Gemini Enterprise Agent Platform (formerly Vertex AI). " +
      "Google bills it on the standard Cloud charging cycle, not Prepay. " +
      "Gemini 3.5 Flash costs $1.50 input and $9.00 output per million tokens on the global endpoint, the same as the Gemini API's paid tier. " +
      "Non-global endpoints cost 10% more. " +
      "Accounts that use only the free tier need take no action.",
    ), text);
  });

  it("links the charging cycle to Google's billing doc and both prices to the Agent Platform pricing page", () => {
    const paragraph = prepayParagraph(page);
    assert.ok(paragraph.includes('Google <a href="https://ai.google.dev/gemini-api/docs/billing" target="_blank" rel="noopener">bills it on the standard Cloud charging cycle</a>, not Prepay.'), paragraph);
    assert.ok(paragraph.includes('Gemini 3.5 Flash costs <a href="https://cloud.google.com/gemini-enterprise-agent-platform/generative-ai/pricing" target="_blank" rel="noopener">$1.50 input and $9.00 output per million tokens on the global endpoint</a>, the same as the Gemini API\'s paid tier.'), paragraph);
  });

  it("ends by saying usage can run past a $0 balance and that a negative balance comes off the next purchase", () => {
    assert.ok(withoutTags(prepayParagraph(page)).endsWith(
      "Usage can continue for approximately 10 minutes past a $0 balance due to billing latency. " +
      "Batch jobs and agents may consume credits beyond the balance. " +
      "A negative balance is deducted from the next credit purchase.",
    ));
  });
});

describe(`${PAGE} on a missed payment for another Google Cloud service`, () => {
  it("follows the split between Prepay and Postpay with the suspension a declined payment can cause whatever the Prepay balance, before what cannot be undone", () => {
    const text = withoutTags(prepayParagraph(page));
    assert.ok(text.includes(
      "Only Gemini API usage moves to Prepay; other Google Cloud services on the same billing account stay on Postpay. " +
      "If your Cloud Billing account has a Gemini API Prepay credit balance but your card expired or a payment for another Google Cloud service was declined, the Gemini API can still be suspended. " +
      "This happens with an overdue balance, a declined payment, or an invalid payment method. " +
      "Resolve the issue in the Google Cloud Billing console to restore service. " +
      "Google's billing FAQ states that accounts cannot switch from Prepay to Postpay",
    ), text);
  });

  it("links the suspension to the billing FAQ's answer on missed payments", () => {
    const paragraph = prepayParagraph(page);
    assert.ok(paragraph.includes('the Gemini API <a href="https://ai.google.dev/gemini-api/docs/billing#missed-payment" target="_blank" rel="noopener">can still be suspended</a>.'), paragraph);
  });
});

describe(`${PAGE} on buying credits by bank transfer`, () => {
  it("follows the $0 stop with how long a bank transfer can take to clear and when service resumes, before the usage that runs past $0", () => {
    const text = withoutTags(prepayParagraph(page));
    assert.ok(text.includes(
      "When the balance reaches $0, every API key on the billing account stops working until you add credits. " +
      "If you pay by bank transfer, some payments take several days to clear. " +
      "Most card payments are instant. " +
      "Gemini API service resumes only after the purchase is confirmed. " +
      "Usage can continue for approximately 10 minutes past a $0 balance",
    ), text);
  });

  it("links the clearing time to the billing doc's answer on processing times", () => {
    const paragraph = prepayParagraph(page);
    assert.ok(paragraph.includes('some payments take <a href="https://ai.google.dev/gemini-api/docs/billing#processing-times" target="_blank" rel="noopener">several days to clear</a>.'), paragraph);
  });
});

describe(`${PAGE} on how much a high-spend account can prepay`, () => {
  it("follows the $5 minimum with the $5,000 ceiling, what a monthly auto-reload limit does, and what stopping a switch halfway can cut off, before the move to Prepay", () => {
    const text = withoutTags(prepayParagraph(page));
    assert.ok(text.startsWith(
      "New users default to Prepay and buy at least $5 of credits to set up billing. " +
      "To keep a high-spend account running, you can prepay up to $5,000 in credits. " +
      "For amounts larger than $5,000 a month, use auto-reload to automatically add credits. " +
      "If you set a monthly auto-reload limit, auto-reload stops when reached. " +
      "Manual purchases still work. " +
      "Auto-reload resumes at the next billing cycle start. " +
      "If you start the switch to Prepay and stop before paying, other projects may lose service. " +
      "To restore service, complete the setup, or contact Cloud Billing Support to set the account back to Postpay. " +
      "Google is moving existing paid accounts from Postpay to Prepay for Gemini API usage:",
    ), text);
  });

  it("links the $5,000 ceiling to Google's billing doc", () => {
    const paragraph = prepayParagraph(page);
    assert.ok(paragraph.includes('To keep a high-spend account running, you can <a href="https://ai.google.dev/gemini-api/docs/billing" target="_blank" rel="noopener">prepay up to $5,000 in credits</a>.'), paragraph);
  });
});

describe(`${PAGE} on how a paid project moves up a tier`, () => {
  it("gives Google's rule for reaching each paid tier, and never says a project is upgraded at a spend threshold", () => {
    assert.deepStrictEqual(keyConstraintByTier(page), {
      "Free": "No free Pro model for new projects.",
      "Tier 1 (Pay-as-you-go)": "Starts when you link an active billing account. Requests pause at $250 aggregate spend",
      "Tier 2": "Automatic once $100 has been paid and 3 days have passed since the first successful payment",
      "Tier 3+": "Automatic once $1,000 has been paid and 30 days have passed since the first successful payment",
    });
    assert.doesNotMatch(readable(page), /Auto-upgraded at spend threshold/i);
  });

  it("states the spend-based rate limit of $10, $50 and $200 per rolling 10 minutes right after the spend-cap paragraph", () => {
    const section = readable(tierSection(page));
    const spendCap = section.indexOf('What "spend cap" means in practice:');
    const spendRate = section.indexOf(SPEND_BASED_RATE_LIMIT);
    assert.ok(spendCap >= 0, "the spend-cap paragraph is in section 4");
    assert.ok(spendRate > spendCap, "the spend-based rate limit follows the spend-cap paragraph in section 4");
    assert.match(
      tierSection(page),
      /What "spend cap" means in practice:<\/strong>(?:(?!<\/div>)[\s\S])*<\/div>\s*<div class="context-box">\s*<strong>Spend-based rate limit:<\/strong> paid tiers/,
    );
  });
});
