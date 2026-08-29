import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const { loadOffers } = await import("../dist/data.js");
const { allOurReferralLinks, ourReferralLinkFor, hasOurReferralLink, hasAnyReferralSurface, documentsVendorReferralProgram, referralLinkCountClause } = await import("../dist/referral-surfaces.js");
const { getAllPlatformCodes, resetPlatformCodesCache } = await import("../dist/platform-codes.js");

const offers = loadOffers();
const offerFor = (vendor: string) => offers.find((o: any) => o.vendor === vendor);

const PLATFORM_CODES_PATH = path.join(__dirname, "..", "data", "platform_codes.json");

function startServer(): Promise<{ proc: ChildProcess; port: number }> {
  return new Promise((resolve, reject) => {
    const serverPath = path.join(__dirname, "..", "dist", "serve.js");
    const proc = spawn("node", [serverPath], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, PORT: "0", BASE_URL: "http://localhost" },
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

function sectionAfter(html: string, heading: string, nextHeading: string): string {
  const start = html.indexOf(heading);
  assert.notStrictEqual(start, -1, `expected the page to contain "${heading}"`);
  const end = nextHeading ? html.indexOf(nextHeading, start + heading.length) : -1;
  return end === -1 ? html.slice(start) : html.slice(start, end);
}

describe("one predicate decides whether we hold a referral link for a vendor", () => {
  it("a vendor held only in the platform code store still counts as one of ours", () => {
    const link = ourReferralLinkFor("Proton Mail", offerFor("Proton Mail"));
    assert.ok(link, "Proton Mail is in data/platform_codes.json and should resolve to a referral link");
    assert.strictEqual(link!.source, "platform_code");
    assert.ok(link!.url.length > 0);
  });

  it("a vendor that documents its own program is a referral surface but not a link of ours", () => {
    const vercel = offerFor("Vercel");
    assert.ok(vercel, "Vercel should be in the index");
    assert.ok(documentsVendorReferralProgram(vercel), "Vercel documents its own referral program");
    assert.strictEqual(ourReferralLinkFor("Vercel", vercel), null, "we hold no code for Vercel");
    assert.strictEqual(hasAnyReferralSurface("Vercel", vercel), true, "the program section is still a referral surface");
  });

  it("a vendor with no program and no code of ours has no referral surface at all", () => {
    const plain = offers.find((o: any) => !o.referral && !o.referral_program?.available && !hasOurReferralLink(o.vendor, o));
    assert.ok(plain, "expected at least one offer with no referral surface");
    assert.strictEqual(hasAnyReferralSurface(plain.vendor, plain), false);
  });

  it("a vendor held in both stores resolves once, keeping the program terms link", () => {
    const railway = offerFor("Railway");
    const link = ourReferralLinkFor("Railway", railway);
    assert.ok(link);
    assert.strictEqual(link!.source, "platform_code");
    assert.strictEqual(link!.termsUrl, railway.referral.terms_url);
    const railwayEntries = allOurReferralLinks(offers).filter((l: any) => l.vendor === "Railway");
    assert.strictEqual(railwayEntries.length, 1, "Railway is in both stores and should be listed once");
  });

  it("resolves a vendor whose only referral link sits in the offer index", () => {
    const offerOnly = {
      vendor: "Example Storage",
      referral: { url: "https://example.com/ref/STORAGE", referee_value: "$5 credit", terms_url: "https://example.com/terms" },
    };
    const link = ourReferralLinkFor(offerOnly.vendor, offerOnly as any);
    assert.ok(link, "an offer-level referral is a referral link of ours even with no platform code");
    assert.strictEqual(link!.source, "offer_referral");
    assert.strictEqual(link!.refereeBenefit, "$5 credit");
    assert.strictEqual(link!.termsUrl, "https://example.com/terms");
  });

  it("lists a vendor held only in the offer index alongside the platform ones", () => {
    const offerOnly = { vendor: "Example Storage", referral: { url: "https://example.com/ref/STORAGE", referee_value: "$5 credit" } };
    const links = allOurReferralLinks([...offers, offerOnly] as any);
    const added = links.filter((l: any) => l.vendor === "Example Storage");
    assert.strictEqual(added.length, 1, "an offer-level referral should be listed once");
    assert.strictEqual(links.length, allOurReferralLinks(offers).length + 1);
  });

  it("counts a single partner in the singular, whatever today's total is", () => {
    assert.strictEqual(referralLinkCountClause(1), "only 1 currently has a referral link of ours");
    assert.strictEqual(referralLinkCountClause(0), "only 0 currently have a referral link of ours");
    assert.strictEqual(referralLinkCountClause(5), "only 5 currently have a referral link of ours");
  });

  it("every active platform code is one of the links we list", () => {
    const listed = new Set(allOurReferralLinks(offers).map((l: any) => l.vendor));
    for (const code of getAllPlatformCodes()) {
      assert.ok(listed.has(code.vendor), `${code.vendor} has an active platform code and should be listed`);
    }
  });
});

describe("the affiliate disclosure counts what the site renders", () => {
  let serverProc: ChildProcess | null = null;
  let port = 0;
  let html = "";

  before(async () => {
    const started = await startServer();
    serverProc = started.proc;
    port = started.port;
    html = await (await fetch(`http://localhost:${port}/disclosure`)).text();
  });

  after(() => {
    serverProc?.kill();
  });

  it("names every vendor we hold a referral link for", () => {
    const partners = sectionAfter(html, "Current Referral Partners", "class=\"updated\"");
    for (const link of allOurReferralLinks(offers)) {
      assert.ok(partners.includes(link.vendor), `${link.vendor} has a referral link of ours and should be named as a partner`);
    }
  });

  it("states a count equal to the number of links it lists", () => {
    const expected = allOurReferralLinks(offers).length;
    const stated = html.match(/only (\d+) currently have a referral link of ours/) ?? html.match(/only (1) currently has a referral link of ours/);
    assert.ok(stated, "expected the page to state how many vendors have a referral link of ours");
    assert.strictEqual(parseInt(stated[1], 10), expected);
  });

  it("agrees with itself on singular and plural", () => {
    const count = allOurReferralLinks(offers).length;
    if (count === 1) {
      assert.ok(html.includes("only 1 currently has a referral link of ours"));
      assert.ok(!html.includes("only 1 currently have"));
    } else {
      assert.ok(html.includes(`only ${count} currently have a referral link of ours`));
    }
  });

  it("separates vendors running their own programs from partners of ours", () => {
    const ours = new Set(allOurReferralLinks(offers).map((l: any) => l.vendor.toLowerCase()));
    const theirs = new Set(
      offers.filter((o: any) => o.referral_program?.available === true && !ours.has(o.vendor.toLowerCase())).map((o: any) => o.vendor)
    );
    assert.ok(theirs.size > 0, "expected vendors that run their own program without a code of ours");
    assert.ok(html.includes(`We also document ${theirs.size} vendors that run their own referral programs`));
    assert.ok(html.includes("We hold no code and earn nothing from those"));
  });

  it("does not promise a revenue split for agent-submitted codes while none exist", async () => {
    const listed = await (await fetch(`http://localhost:${port}/api/referral-codes?source=agent-submitted`)).json();
    assert.strictEqual(listed.total, 0, "this expectation only holds while no agent has a code with us");
    assert.ok(!html.includes("Agent-Submitted Referral Codes"), "no agent has submitted a code, so the section describes nothing");
    assert.ok(!html.includes("split between the submitting agent"));
  });

  it("names exactly the vendors whose pages render a referral link", async () => {
    for (const link of allOurReferralLinks(offers)) {
      const slug = link.vendor.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
      const page = await (await fetch(`http://localhost:${port}/vendor/${slug}`)).text();
      assert.ok(page.includes("Sign up via our referral link"), `/vendor/${slug} is listed as a partner and should render the referral link`);
    }
    const vercel = await (await fetch(`http://localhost:${port}/vendor/vercel`)).text();
    assert.ok(!vercel.includes("Sign up via our referral link"), "we hold no code for Vercel, so its page must not offer one");
  });
});

describe("the referral programs directory labels our commercial relationships", () => {
  let serverProc: ChildProcess | null = null;
  let html = "";

  const jsonLdOfType = (type: string) =>
    [...html.matchAll(/<script type="application\/ld\+json">(.*?)<\/script>/g)]
      .map((m) => JSON.parse(m[1]))
      .find((d: any) => d["@type"] === type);

  const inventoryRotation = async () => {
    const { rotateListing } = await import("../src/ranking.ts");
    const seen = new Set<string>();
    const sourceOrder: string[] = [];
    for (const o of offers) {
      if (o.referral_program?.available && !seen.has(o.vendor)) {
        seen.add(o.vendor);
        sourceOrder.push(o.vendor);
      }
    }
    return rotateListing(sourceOrder, "referral-programs:inventory");
  };

  before(async () => {
    const started = await startServer();
    serverProc = started.proc;
    html = await (await fetch(`http://localhost:${started.port}/referral-programs`)).text();
  });

  after(() => {
    serverProc?.kill();
  });

  it("puts every vendor we hold a code for in the section that says we may be paid", () => {
    const paid = sectionAfter(html, "Programs we have a referral link for", "Programs we don");
    const withProgram = offers.filter((o: any) => o.referral_program?.available === true);
    for (const offer of withProgram) {
      if (!hasOurReferralLink(offer.vendor, offer)) continue;
      assert.ok(paid.includes(`>${offer.vendor}<`), `${offer.vendor} has a referral link of ours and belongs in the paid section`);
    }
  });

  it("claims to earn nothing only from vendors we hold no code for", () => {
    const unpaid = sectionAfter(html, "Programs we don", "agent-cta");
    assert.ok(unpaid.includes("We earn nothing from these"));
    for (const offer of offers) {
      if (!hasOurReferralLink(offer.vendor, offer)) continue;
      assert.ok(!unpaid.includes(`>${offer.vendor}<`), `${offer.vendor} pays us and must not sit under "We earn nothing from these"`);
    }
  });

  it("orders its structured data over the whole inventory, not paid vendors first", async () => {
    const itemList = jsonLdOfType("ItemList");
    const listed = itemList.itemListElement.map((e: any) => e.item.name.replace(" Referral Program", ""));
    assert.deepStrictEqual(listed, await inventoryRotation());
  });

  it("draws its worked examples from that same order", async () => {
    const answer = jsonLdOfType("FAQPage").mainEntity[0].acceptedAnswer.text;
    const expected = (await inventoryRotation()).slice(0, 5);
    assert.ok(answer.includes(expected.join(", ")), `expected the first five of the inventory order, got: ${answer}`);
  });

  it("offers our own code rather than a submission form for vendors we hold one for", () => {
    const paid = sectionAfter(html, "Programs we have a referral link for", "Programs we don");
    for (const link of allOurReferralLinks(offers)) {
      const offer = offerFor(link.vendor);
      if (!offer?.referral_program?.available) continue;
      assert.ok(paid.includes(link.url), `${link.vendor}'s row should link to the code we hold`);
    }
  });
});

describe("a new row in the platform code store is disclosed on its own", () => {
  let serverProc: ChildProcess | null = null;
  let originalFile = "";
  let html = "";
  let quietVendorPage = "";
  const addedVendor = "Example Cloud";
  const quietVendor = offers.find((o: any) => !hasAnyReferralSurface(o.vendor, o))!.vendor;

  const syntheticRow = (vendor: string) => ({
    vendor,
    code: "EXAMPLECODE",
    referral_url: "https://example.com/ref/EXAMPLECODE",
    referrer_benefit: "$1 credit",
    referee_benefit: "$1 credit",
    source: "platform",
    active: true,
    added_at: "2026-08-29",
  });

  before(async () => {
    originalFile = fs.readFileSync(PLATFORM_CODES_PATH, "utf-8");
    const data = JSON.parse(originalFile);
    data.platform_codes.push(syntheticRow(addedVendor), syntheticRow(quietVendor));
    fs.writeFileSync(PLATFORM_CODES_PATH, JSON.stringify(data, null, 2), "utf-8");
    resetPlatformCodesCache();
    const started = await startServer();
    serverProc = started.proc;
    html = await (await fetch(`http://localhost:${started.port}/disclosure`)).text();
    const slug = quietVendor.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    quietVendorPage = await (await fetch(`http://localhost:${started.port}/vendor/${slug}`)).text();
  });

  after(() => {
    serverProc?.kill();
    fs.writeFileSync(PLATFORM_CODES_PATH, originalFile, "utf-8");
    resetPlatformCodesCache();
  });

  it("appears as a referral partner without any change to the offer index", () => {
    const partners = sectionAfter(html, "Current Referral Partners", "class=\"updated\"");
    assert.ok(partners.includes(addedVendor), "a platform code row alone should name the vendor as a partner");
    assert.ok(!offers.some((o: any) => o.vendor === addedVendor), "the offer index was not touched");
  });

  it("is included in the stated count", () => {
    const withAddedRows = allOurReferralLinks(offers).length;
    const withoutAddedRows = JSON.parse(originalFile).platform_codes.filter((c: any) => c.active).length;
    assert.strictEqual(withAddedRows, withoutAddedRows + 2, "the added rows should be the only new links");
    assert.ok(html.includes(referralLinkCountClause(withAddedRows)));
  });

  it("turns a page that was asking for a code into one that offers ours", () => {
    assert.ok(quietVendorPage.includes("Sign up via our referral link"), "the code row alone should render the referral link");
    assert.ok(!quietVendorPage.includes("marketplace-solicitation"), "a page that now has a code of ours must stop asking for one");
  });
});
