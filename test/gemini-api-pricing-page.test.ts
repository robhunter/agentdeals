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
    assert.ok(text.includes("and stop being used when the Prepay balance reaches $0. Prepaid credits expire 12 months after purchase and are non-refundable. "));
    assert.ok(text.includes(" When the balance reaches $0, every API key on the billing account stops working until you add credits."));
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
  it("says what cannot be undone, then the route that bills after use, what gemini-3.5-flash calls cost there, and the two models priced the same on both platforms", () => {
    const text = withoutTags(prepayParagraph(page));
    assert.ok(text.includes(
      "Google's billing FAQ states that accounts cannot switch from Prepay to Postpay. " +
      "To pay after use instead of prepaying, use Gemini Enterprise Agent Platform (formerly Vertex AI). " +
      "Google bills it on the standard Cloud charging cycle, not Prepay. " +
      "Calls to gemini-3.5-flash cost $1.50 input and $9.00 output per million tokens on Agent Platform, compared to $0.75 input and $3.75 output on the Gemini API, which routes to gemini-3.6-flash. " +
      "Change the model ID to gemini-3.6-flash or gemini-3.8-flash before moving; those two models cost the same on both platforms. " +
      "Agent Platform charges $0.75 input and $3.75 output per million tokens for Gemini 3.8 Flash and 3.6 Flash on the global endpoint through 2026-12-31, then $1.50 input and $7.50 output. " +
      "Non-global endpoints cost 10% more. " +
      "These match Gemini API paid-tier prices for gemini-3.6-flash and gemini-3.8-flash. " +
      "Accounts that use only the free tier need take no action.",
    ), text);
  });

  it("gives gemini-3.5-flash's Agent Platform prices in one sentence on the page, beside the Gemini API price of the model the listing routes it to", () => {
    const description = String(listing.description);
    const routedTo = description.match(/Requests to gemini-3\.5-flash are routed automatically to (gemini-[\d.]+-flash)\./);
    assert.ok(routedTo, "the Google Gemini API listing no longer says which model gemini-3.5-flash requests are routed to");
    assert.strictEqual(routedTo![1], "gemini-3.6-flash");
    const flash = description.match(/Gemini 3\.8 Flash \$([\d.]+)\/\$([\d.]+) until [\d-]+, [^(]*\(3\.6 Flash: the same prices and dates\)/);
    assert.ok(flash, "the Google Gemini API listing no longer prices 3.6 Flash as 3.8 Flash");
    const statingIt = readable(page)
      .split(/(?<=\.)\s+/)
      .filter((s) => /gemini-3\.5-flash(?!-lite)|Gemini 3\.5 Flash(?!-Lite)/.test(s) && /Agent Platform|Vertex AI/.test(s) && /\$\d/.test(s));
    assert.deepStrictEqual(statingIt, [
      `Calls to gemini-3.5-flash cost $1.50 input and $9.00 output per million tokens on Agent Platform, compared to $${flash![1]} input and $${flash![2]} output on the Gemini API, which routes to ${routedTo![1]}.`,
    ]);
  });

  it("says 3.6 Flash and 3.8 Flash cost the same on both platforms only while the Agent Platform prices it gives are the listing's Gemini API prices", () => {
    const flash = String(listing.description).match(/Gemini 3\.8 Flash \$([\d.]+)\/\$([\d.]+) until ([\d-]+), then \$([\d.]+) input and \$([\d.]+) output from [\d-]+ \(3\.6 Flash: the same prices and dates\)/);
    assert.ok(flash, "the Google Gemini API listing no longer gives 3.8 Flash's two prices with 3.6 Flash priced the same");
    const [, input, output, through, laterInput, laterOutput] = flash!;
    assert.ok(
      withoutTags(prepayParagraph(page)).includes(
        `Agent Platform charges $${input} input and $${output} output per million tokens for Gemini 3.8 Flash and 3.6 Flash on the global endpoint through ${through}, then $${laterInput} input and $${laterOutput} output. `,
      ),
      "the Agent Platform prices for 3.8 Flash and 3.6 Flash no longer match the listing's Gemini API prices",
    );
  });

  it("links the charging cycle to Google's billing doc and both prices to the Agent Platform pricing page", () => {
    const paragraph = prepayParagraph(page);
    assert.ok(paragraph.includes('Google <a href="https://ai.google.dev/gemini-api/docs/billing" target="_blank" rel="noopener">bills it on the standard Cloud charging cycle</a>, not Prepay.'), paragraph);
    assert.ok(paragraph.includes('Agent Platform charges <a href="https://cloud.google.com/gemini-enterprise-agent-platform/generative-ai/pricing" target="_blank" rel="noopener">$0.75 input and $3.75 output per million tokens for Gemini 3.8 Flash and 3.6 Flash on the global endpoint through 2026-12-31, then $1.50 input and $7.50 output</a>. Non-global endpoints cost 10% more.'), paragraph);
  });

  it("says usage can run past a $0 balance and that a negative balance comes off the next purchase", () => {
    assert.ok(withoutTags(prepayParagraph(page)).includes(
      "Usage can continue for approximately 10 minutes past a $0 balance due to billing latency. " +
      "Batch jobs and agents may consume credits beyond the balance. " +
      "A negative balance is deducted from the next credit purchase. ",
    ));
  });
});

describe(`${PAGE} on accounts charged monthly`, () => {
  it("follows the split between Prepay and Postpay with: being charged monthly exempts no account, self-serve accounts move, what an invoiced account is and who its holder asks about a cutover notice, and the route that bills after use on any account", () => {
    const text = withoutTags(prepayParagraph(page));
    assert.ok(text.includes(
      "Only Gemini API usage moves to Prepay; other Google Cloud services on the same billing account stay on Postpay. " +
      "Being charged monthly does not exempt an account. " +
      "Self-serve accounts, charged automatically to a card or bank account, move to Prepay. " +
      "Prepay is not available for invoiced (offline) accounts, which a business applies for (requirements include one year registered and $40,000 a year of expected spend) and pays by check or wire transfer; " +
      "Google does not say how the cutover treats them, so holders of one who received a cutover notice should ask Cloud Billing Support. " +
      "On any account, Gemini Enterprise Agent Platform (formerly Vertex AI) bills after use on the standard Cloud charging cycle. " +
      "If your Cloud Billing account has a Gemini API Prepay credit balance",
    ), text);
  });

  it("links Google's statement on invoiced accounts to its billing doc", () => {
    const paragraph = prepayParagraph(page);
    assert.ok(paragraph.includes('move to Prepay. <a href="https://ai.google.dev/gemini-api/docs/billing" target="_blank" rel="noopener">Prepay is not available for invoiced (offline) accounts</a>, which a business applies for'), paragraph);
  });

  it("states it once on the page", () => {
    assert.strictEqual(readable(page).match(/not available for invoiced/gi)?.length ?? 0, 1);
  });

  it("no longer opens it with a clause that every company paying monthly reads as its own case", () => {
    assert.ok(readable(page).includes("Being charged monthly does not exempt an account."), "the page no longer holds the sentence that replaced the clause");
    assert.doesNotMatch(page, /pays Google Cloud by monthly invoice/i);
    assert.doesNotMatch(readable(page), /pays Google Cloud by monthly invoice/i);
  });
});

describe(`${PAGE} on credits that still read as depleted after buying them`, () => {
  it("follows the negative balance with the depleted-credits error, that no manual billing sync exists, the checks to make, and where to report it", () => {
    assert.ok(withoutTags(prepayParagraph(page)).includes(
      "A negative balance is deducted from the next credit purchase. " +
      'After buying credits, calls may still fail with "Your prepayment credits are depleted". ' +
      "Google staff say there is no manual billing sync to request. " +
      "Check that the credits are a Prepay balance on the AI Studio Billing page, not a spend cap or funds in the Google Cloud billing account, and that the API key belongs to a project on that billing account. " +
      "Retry the calls; if the error continues, post the exact error message and request time on Google's AI developer forum. ",
    ));
  });

  it("links what Google staff say to their reply and the forum to Google's AI developer forum", () => {
    const paragraph = prepayParagraph(page);
    assert.ok(paragraph.includes('<a href="https://discuss.ai.google.dev/t/manual-sync-request-prepayment-credits-depleted-429-despite-funded-account/172183" target="_blank" rel="noopener">Google staff say</a> there is no manual billing sync'), paragraph);
    assert.ok(paragraph.includes('request time on <a href="https://discuss.ai.google.dev/" target="_blank" rel="noopener">Google\'s AI developer forum</a>.'), paragraph);
  });
});

describe(`${PAGE} on a billing account AI Studio calls inactive or unsupported`, () => {
  it("ends the paragraph with the message, what Google's billing FAQ says it means, where to check, what to do for a Free Trial or a Closed account, and that there is no sync to request", () => {
    assert.ok(withoutTags(prepayParagraph(page)).endsWith(
      "request time on Google's AI developer forum. " +
      'The AI Studio Billing page may show "The billing account type is inactive or unsupported". ' +
      "Google's billing FAQ says this means the billing account's type or status is not eligible for the Paid Tier. " +
      "Check the Cloud Console for the account's status. " +
      "For a Free Trial account, activate billing in AI Studio. " +
      "For a Closed account, reopen it. " +
      "There is no manual billing sync to request.",
    ));
  });

  it("links Google's billing FAQ to its answer on eligible accounts", () => {
    const paragraph = prepayParagraph(page);
    assert.ok(paragraph.includes('<a href="https://ai.google.dev/gemini-api/docs/billing#eligible-accounts" target="_blank" rel="noopener">Google\'s billing FAQ</a> says this means the billing account\'s type or status is not eligible for the Paid Tier.'), paragraph);
  });
});

const PREPAY_BALANCE_THREAD = "https://discuss.ai.google.dev/t/trapped-prepay-balance-14-73-api-blocked-and-gcp-billing-account-split-disconnect/182319";

describe(`${PAGE} on Prepay credits when a project moves or the billing account closes`, () => {
  it("follows the 12-month expiry with the credits staying on the account they were bought on, no transfer between accounts and the forfeit on closing, before the $0 stop", () => {
    const text = withoutTags(prepayParagraph(page));
    assert.ok(text.includes(
      "Prepaid credits expire 12 months after purchase and are non-refundable. " +
      "Prepay credits remain with the Cloud Billing account they were purchased on, so a project moving to another account will not use them. " +
      "Google staff state funds cannot be transferred between billing accounts, and closing the account forfeits any remaining credits. " +
      "When the balance reaches $0, every API key on the billing account stops working until you add credits.",
    ), text);
  });

  it("links what Google staff state to their reply", () => {
    const paragraph = prepayParagraph(page);
    assert.ok(paragraph.includes(`<a href="${PREPAY_BALANCE_THREAD}" target="_blank" rel="noopener">Google staff state</a> funds cannot be transferred between billing accounts`), paragraph);
  });
});

describe(`${PAGE} on a missed payment for another Google Cloud service`, () => {
  it("follows the route that bills after use on any account with the suspension a declined payment can cause whatever the Prepay balance, before what cannot be undone", () => {
    const text = withoutTags(prepayParagraph(page));
    assert.ok(text.includes(
      "On any account, Gemini Enterprise Agent Platform (formerly Vertex AI) bills after use on the standard Cloud charging cycle. " +
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

const DENIED_ACCESS_THREAD = "https://discuss.ai.google.dev/t/get-v1beta-models-returns-200-ok-but-generatecontent-returns-http-403-your-project-has-been-denied-access/187288";

describe(`${PAGE} on an account that missed its cutover date`, () => {
  it("follows the interruption with the switch that stays open, the billing FAQ that says so, and when paid service resumes, before the split between Prepay and Postpay", () => {
    const text = withoutTags(prepayParagraph(page));
    assert.ok(text.includes(
      "or the account's paid Gemini API service is interrupted. " +
      "An account that missed its cutover date can still switch. " +
      "Google's billing FAQ says an existing Postpay account can transition to Prepay on the AI Studio Billing page. " +
      "The doc gives no deadline for the switch. " +
      "Paid Gemini API service resumes only after the credit purchase is confirmed. " +
      "Only Gemini API usage moves to Prepay;",
    ), text);
  });

  it("links the transition to Google's billing doc", () => {
    const paragraph = prepayParagraph(page);
    assert.ok(paragraph.includes('<a href="https://ai.google.dev/gemini-api/docs/billing" target="_blank" rel="noopener">Google\'s billing FAQ says an existing Postpay account can transition to Prepay</a> on the AI Studio Billing page.'), paragraph);
  });
});

describe(`${PAGE} on a free-tier project denied access`, () => {
  it("follows the $0 stop with what a 403 is not, what Google staff say it means, and their steps for a free-tier project", () => {
    const text = withoutTags(prepayParagraph(page));
    assert.ok(text.includes(
      "When the balance reaches $0, every API key on the billing account stops working until you add credits. " +
      'Calls failing with HTTP 403 "Your project has been denied access" are not from a $0 Prepay balance, which returns 402. ' +
      'Google staff say 403 or "Unavailable" in AI Studio means a flag is on the account. ' +
      "For free-tier projects, complete age verification in your Google Account, then retry or create a new API key. " +
      "If access is still denied, staff suggest adding Prepay credits, which ends your free tier quota. " +
      "If you pay by bank transfer,",
    ), text);
  });

  it("links what Google staff say to their reply", () => {
    const paragraph = prepayParagraph(page);
    assert.ok(paragraph.includes(`<a href="${DENIED_ACCESS_THREAD}" target="_blank" rel="noopener">Google staff say</a> 403 or "Unavailable" in AI Studio`), paragraph);
  });
});

describe(`${PAGE} on buying credits by bank transfer`, () => {
  it("follows the steps for a project denied access with how long a bank transfer can take to clear and when service resumes, before the usage that runs past $0", () => {
    const text = withoutTags(prepayParagraph(page));
    assert.ok(text.includes(
      "If access is still denied, staff suggest adding Prepay credits, which ends your free tier quota. " +
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
