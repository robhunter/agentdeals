import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PLATFORM_CODES_PATH = path.join(__dirname, "..", "data", "platform_codes.json");

const { referrerDisclosureSentence, ourReferralLinkFor } = await import("../dist/referral-surfaces.js");
const { getBestReferralCode, listAllReferralCodes, referrerCompensationOf, restrictionsOf, resetPlatformCodesCache } = await import("../dist/platform-codes.js");
const { getVendorReferral, loadOffers } = await import("../dist/data.js");

const offers = loadOffers();
const offerFor = (vendor: string) => offers.find((o: any) => o.vendor === vendor);

const PROTON_VENDORS = ["Proton Mail", "Proton VPN", "Proton Pass", "Proton Drive"];
const PROTON_SLUGS = ["proton-mail", "proton-vpn", "proton-pass", "proton-drive"];

const COMMISSION_SENTENCE = "We may earn a commission if you sign up through this link.";

function startServer(env: Record<string, string> = {}): Promise<{ proc: ChildProcess; port: number }> {
  return new Promise((resolve, reject) => {
    const serverPath = path.join(__dirname, "..", "dist", "serve.js");
    const proc = spawn("node", [serverPath], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, PORT: "0", BASE_URL: "http://localhost", ...env },
    });
    const timeout = setTimeout(() => {
      proc.kill();
      reject(new Error("Server startup timeout"));
    }, 15000);
    proc.stderr!.on("data", (data: Buffer) => {
      const match = data.toString().match(/running on http:\/\/localhost:(\d+)/);
      if (match) {
        clearTimeout(timeout);
        resolve({ proc, port: parseInt(match[1], 10) });
      }
    });
    proc.on("error", (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });
}

describe("every published code states what it pays us and what the reader must do", () => {
  const store = JSON.parse(fs.readFileSync(PLATFORM_CODES_PATH, "utf-8"));

  it("declares a recognized compensation on every active row", () => {
    for (const code of store.platform_codes.filter((c: any) => c.active)) {
      assert.notStrictEqual(
        referrerCompensationOf(code),
        null,
        `${code.vendor} must state referrer_compensation as one of commission, credit or none`
      );
    }
  });

  it("declares a restrictions list on every active row", () => {
    for (const code of store.platform_codes.filter((c: any) => c.active)) {
      assert.ok(Array.isArray(code.restrictions), `${code.vendor} must carry a restrictions array, empty if there are none`);
      assert.deepStrictEqual(restrictionsOf(code), code.restrictions, `${code.vendor}: every restriction must be a non-empty string`);
    }
  });

  it("keeps the commission sentence for a record that says commission", () => {
    assert.strictEqual(referrerDisclosureSentence("commission"), COMMISSION_SENTENCE);
  });

  it("says credit rather than commission for a record paid in credit", () => {
    const sentence = referrerDisclosureSentence("credit");
    assert.ok(sentence.includes("vendor credit, not cash"), sentence);
    assert.ok(!sentence.includes("commission"), "a credit-only program must not be described as a commission");
  });

  it("says we are paid nothing for a record that earns us nothing", () => {
    const sentence = referrerDisclosureSentence("none");
    assert.ok(sentence.includes("paid nothing"), sentence);
    assert.ok(!sentence.includes("commission"), sentence);
  });

  it("claims no payment at all for a record that does not say", () => {
    const sentence = referrerDisclosureSentence(null);
    assert.ok(!sentence.includes("commission"), "an unstated arrangement must not be published as a commission");
    assert.ok(sentence.includes("not recorded"), sentence);
  });

  it("reads the arrangement off the record rather than off the benefit wording", () => {
    assert.strictEqual(referrerCompensationOf({ referrer_benefit: "15% commission", referrer_compensation: "credit" }), "credit");
    assert.strictEqual(referrerCompensationOf({ referrer_benefit: "15% commission" }), null);
    assert.strictEqual(referrerCompensationOf({ referrer_compensation: "cash" }), null);
    assert.strictEqual(referrerCompensationOf(null), null);
  });

  it("drops restrictions that carry no readable text", () => {
    assert.deepStrictEqual(restrictionsOf({ restrictions: ["A card must be linked", "  ", 7, null] }), ["A card must be linked"]);
    assert.deepStrictEqual(restrictionsOf({ restrictions: "A card must be linked" }), []);
    assert.deepStrictEqual(restrictionsOf({}), []);
  });
});

describe("the four Proton products offer no code of ours", () => {
  let serverProc: ChildProcess | null = null;
  let port = 0;

  before(async () => {
    const started = await startServer();
    serverProc = started.proc;
    port = started.port;
  });

  after(() => {
    serverProc?.kill();
  });

  it("renders no referral banner and no referral button", async () => {
    for (const slug of PROTON_SLUGS) {
      const page = await (await fetch(`http://localhost:${port}/vendor/${slug}`)).text();
      assert.ok(page.includes("<h1"), `/vendor/${slug} should render`);
      assert.ok(!page.includes("Sign up via our referral link"), `/vendor/${slug} must not offer a referral link`);
      assert.ok(!page.includes("sponsored"), `/vendor/${slug} must not render a sponsored link`);
      assert.ok(!page.includes(COMMISSION_SENTENCE), `/vendor/${slug} must not claim a commission`);
      assert.ok(!page.includes("60QXGJSB"), `/vendor/${slug} must not carry the removed code`);
    }
  });

  it("resolves to nothing over MCP and over the code endpoint", async () => {
    for (const vendor of PROTON_VENDORS) {
      assert.strictEqual(getVendorReferral(vendor), null, `get_referral_code must find nothing for ${vendor}`);
      assert.strictEqual(getBestReferralCode(vendor), null, `no code should be offered for ${vendor}`);
      const res = await fetch(`http://localhost:${port}/api/referral-codes/${encodeURIComponent(vendor)}`);
      assert.strictEqual(res.status, 404, `/api/referral-codes/${vendor} should report no code`);
    }
  });

  it("leaves Railway resolving exactly as before", async () => {
    const referral = getVendorReferral("Railway");
    assert.ok(referral, "get_referral_code must still resolve Railway");
    assert.strictEqual(referral.referral.code, "7RZL9q");

    const best = getBestReferralCode("Railway");
    assert.strictEqual(best!.code, "7RZL9q");
    assert.strictEqual(best!.referee_benefit, "$20 in credits");
    assert.deepStrictEqual(best!.restrictions, []);

    const page = await (await fetch(`http://localhost:${port}/vendor/railway`)).text();
    assert.ok(page.includes("Sign up via our referral link and get $20 in credits"));
    assert.ok(page.includes("https://railway.com?referralCode=7RZL9q"));
    assert.ok(page.includes(COMMISSION_SENTENCE));
    assert.ok(!page.includes("referral-conditions"), "Railway records no conditions, so none should be rendered");
  });

  it("carries the restrictions list alongside every benefit the code endpoint publishes", async () => {
    const listing = await (await fetch(`http://localhost:${port}/api/referral-codes`)).json();
    assert.ok(listing.codes.length > 0);
    for (const code of listing.codes) {
      assert.ok(Array.isArray(code.restrictions), `${code.vendor} should publish a restrictions array beside its benefit`);
    }
    for (const code of listAllReferralCodes()) {
      assert.ok(Array.isArray(code.restrictions));
    }
  });
});

describe("a code whose reward is conditional says so beside the button", () => {
  let serverProc: ChildProcess | null = null;
  let originalFile = "";
  let conditionalPage = "";
  let creditPage = "";
  let unpaidPage = "";
  let silentPage = "";
  let disclosure = "";
  let vendorCodeResponse: any = null;

  const CONDITIONS = [
    "A credit card or PayPal account must be linked before the credit is granted",
    "Unused credit expires after 30 days",
  ];

  const quiet = offers.filter((o: any) => !o.referral && !o.referral_program?.available && !ourReferralLinkFor(o.vendor, o));
  const conditionalVendor = quiet[0].vendor;
  const creditVendor = quiet[1].vendor;
  const unpaidVendor = quiet[2].vendor;
  const silentVendor = quiet[3].vendor;

  const slugOf = (vendor: string) => vendor.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

  before(async () => {
    originalFile = fs.readFileSync(PLATFORM_CODES_PATH, "utf-8");
    const data = JSON.parse(originalFile);
    data.platform_codes.push(
      {
        vendor: conditionalVendor,
        code: "CONDITIONAL",
        referral_url: "https://example.com/?ref=CONDITIONAL",
        referrer_benefit: "$100 cash per verified paid signup",
        referrer_compensation: "commission",
        referee_benefit: "$300 in credit",
        restrictions: CONDITIONS,
        source: "platform",
        active: true,
        added_at: "2026-08-29",
      },
      {
        vendor: creditVendor,
        code: "CREDITONLY",
        referral_url: "https://example.com/?ref=CREDITONLY",
        referrer_benefit: "$20 credit",
        referrer_compensation: "credit",
        referee_benefit: "$20 credit",
        restrictions: ["The credit arrives only after a paid plan is held for a month"],
        source: "platform",
        active: true,
        added_at: "2026-08-29",
      },
      {
        vendor: unpaidVendor,
        code: "NOTHINGFORUS",
        referral_url: "https://example.com/?ref=NOTHINGFORUS",
        referrer_benefit: "Nothing",
        referrer_compensation: "none",
        referee_benefit: "$10 in credit",
        restrictions: [],
        source: "platform",
        active: true,
        added_at: "2026-08-29",
      },
      {
        vendor: silentVendor,
        code: "UNSTATED",
        referral_url: "https://example.com/?ref=UNSTATED",
        referrer_benefit: "Unknown",
        referee_benefit: "$5 in credit",
        source: "platform",
        active: true,
        added_at: "2026-08-29",
      }
    );
    fs.writeFileSync(PLATFORM_CODES_PATH, JSON.stringify(data, null, 2), "utf-8");
    resetPlatformCodesCache();

    const started = await startServer();
    serverProc = started.proc;
    conditionalPage = await (await fetch(`http://localhost:${started.port}/vendor/${slugOf(conditionalVendor)}`)).text();
    creditPage = await (await fetch(`http://localhost:${started.port}/vendor/${slugOf(creditVendor)}`)).text();
    unpaidPage = await (await fetch(`http://localhost:${started.port}/vendor/${slugOf(unpaidVendor)}`)).text();
    silentPage = await (await fetch(`http://localhost:${started.port}/vendor/${slugOf(silentVendor)}`)).text();
    disclosure = await (await fetch(`http://localhost:${started.port}/disclosure`)).text();
    vendorCodeResponse = await (await fetch(`http://localhost:${started.port}/api/referral-codes/${encodeURIComponent(conditionalVendor)}`)).json();
  });

  after(() => {
    serverProc?.kill();
    fs.writeFileSync(PLATFORM_CODES_PATH, originalFile, "utf-8");
    resetPlatformCodesCache();
  });

  it("prints every condition on the page that offers the reward", () => {
    assert.ok(conditionalPage.includes("Sign up via our referral link and get $300 in credit"));
    for (const condition of CONDITIONS) {
      assert.ok(conditionalPage.includes(condition), `the page should state: ${condition}`);
    }
  });

  it("prints them before the reader can click through", () => {
    const conditionAt = conditionalPage.indexOf(CONDITIONS[0]);
    const buttonAt = conditionalPage.indexOf("https://example.com/?ref=CONDITIONAL\" rel=\"noopener sponsored\"");
    assert.ok(conditionAt > -1 && buttonAt > -1);
    assert.ok(conditionAt < buttonAt, "the conditions must come before the button, not after it");
  });

  it("repeats them on the disclosure page that lists the partner", () => {
    for (const condition of CONDITIONS) {
      assert.ok(disclosure.includes(condition), `/disclosure should state: ${condition}`);
    }
  });

  it("describes a credit-only arrangement as credit on the page itself", () => {
    assert.ok(creditPage.includes("Sign up via our referral link and get $20 credit"));
    assert.ok(creditPage.includes("vendor credit, not cash"));
    assert.ok(!creditPage.includes(COMMISSION_SENTENCE), "a program that pays us in credit must not claim a commission");
    assert.ok(creditPage.includes("The credit arrives only after a paid plan is held for a month"));
  });

  it("says we are paid nothing when the record says so", () => {
    assert.ok(unpaidPage.includes("Sign up via our referral link and get $10 in credit"));
    assert.ok(unpaidPage.includes("paid nothing"));
    assert.ok(!unpaidPage.includes(COMMISSION_SENTENCE));
  });

  it("claims nothing for a record that never states the arrangement", () => {
    assert.ok(silentPage.includes("Sign up via our referral link and get $5 in credit"));
    assert.ok(!silentPage.includes(COMMISSION_SENTENCE), "an unstated arrangement must not be published as a commission");
    assert.ok(silentPage.includes("not recorded"));
    assert.ok(!silentPage.includes("referral-conditions"), "a record with no restrictions field should assert no conditions either way");
  });

  it("hands the conditions to an agent asking for the code", async () => {
    const code = getBestReferralCode(conditionalVendor);
    assert.deepStrictEqual(code!.restrictions, CONDITIONS);
    const listed = listAllReferralCodes().find((c: any) => c.vendor === conditionalVendor);
    assert.deepStrictEqual(listed!.restrictions, CONDITIONS);
  });

  it("serves them on the endpoint that answers for one vendor", () => {
    assert.strictEqual(vendorCodeResponse.referee_benefit, "$300 in credit");
    assert.deepStrictEqual(vendorCodeResponse.restrictions, CONDITIONS, "the by-vendor endpoint must publish the conditions beside the benefit");
  });
});

describe("a referral link held only in the offer index reaches the page too", () => {
  let serverProc: ChildProcess | null = null;
  let page = "";
  let indexPath = "";

  const quiet = offers.find((o: any) => !o.referral && !o.referral_program?.available && !ourReferralLinkFor(o.vendor, o));
  const RESTRICTION = "The credit is granted only after the first invoice is paid";

  before(async () => {
    const seeded = offers.map((o: any) =>
      o.vendor === quiet.vendor
        ? {
            ...o,
            referral: {
              url: "https://example.com/?ref=OFFERSTORE",
              referee_value: "$40 in credits",
              referrer_value: "Vendor credit only",
              referrer_compensation: "credit",
              type: "dual-sided",
              source: "curated",
              verified_date: "2026-08-29",
              restrictions: [RESTRICTION],
              phase1_eligible: true,
            },
          }
        : o
    );
    indexPath = path.join(fs.mkdtempSync(path.join(__dirname, "..", "data", "tmp-offer-store-")), "index.json");
    fs.writeFileSync(indexPath, JSON.stringify({ offers: seeded }), "utf-8");

    const started = await startServer({ AGENTDEALS_INDEX_PATH: indexPath });
    serverProc = started.proc;
    const slug = quiet.vendor.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    page = await (await fetch(`http://localhost:${started.port}/vendor/${slug}`)).text();
  });

  after(() => {
    serverProc?.kill();
    fs.rmSync(path.dirname(indexPath), { recursive: true, force: true });
  });

  it("renders the offer store's link, benefit and conditions", () => {
    assert.ok(page.includes("Sign up via our referral link and get $40 in credits"), "an offer-level referral should render the CTA");
    assert.ok(page.includes("https://example.com/?ref=OFFERSTORE"));
    assert.ok(page.includes(RESTRICTION));
    assert.ok(page.includes("vendor credit, not cash"));
    assert.ok(!page.includes(COMMISSION_SENTENCE));
  });
});
