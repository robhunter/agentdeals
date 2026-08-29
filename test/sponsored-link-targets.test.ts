import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(__dirname, "..");
const PLATFORM_CODES_PATH = path.join(REPO, "data", "platform_codes.json");

const { anchorsIn, isSponsored, offersAReaderBenefit, sponsoredAnchorsIn } = await import("../dist/referral-anchors.js");
const { ourReferralLinkFor, allOurReferralLinks, REFERRAL_CONDITIONS_HEADING } = await import("../dist/referral-surfaces.js");
const { resetPlatformCodesCache } = await import("../dist/platform-codes.js");
const { loadOffers } = await import("../dist/data.js");

const offers = loadOffers();
const railwayOffer = offers.find((o: any) => o.vendor === "Railway");
const RAILWAY_REFERRAL_URL = "https://railway.com?referralCode=7RZL9q";
const RAILWAY_PROGRAM_URL = "https://railway.com/affiliate-program";
const COMMISSION_SENTENCE = "We may earn a commission if you sign up through this link.";

function startServer(env: Record<string, string> = {}): Promise<{ proc: ChildProcess; port: number }> {
  return new Promise((resolve, reject) => {
    const proc = spawn("node", [path.join(REPO, "dist", "serve.js")], {
      cwd: REPO,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, PORT: "0", BASE_URL: "http://127.0.0.1", ...env },
    });
    const timeout = setTimeout(() => { proc.kill("SIGKILL"); reject(new Error("Server startup timeout")); }, 30000);
    proc.stderr!.on("data", (b: Buffer) => {
      const m = b.toString().match(/running on http:\/\/localhost:(\d+)/);
      if (m) { clearTimeout(timeout); resolve({ proc, port: parseInt(m[1], 10) }); }
    });
    proc.on("error", (e) => { clearTimeout(timeout); reject(e); });
  });
}

const stripHost = (u: string) => u.replace(/^https?:\/\/[^/]+/, "");

async function everyPublishedPath(base: string): Promise<string[]> {
  const index = await (await fetch(`${base}/sitemap.xml`)).text();
  const paths: string[] = [];
  for (const m of index.matchAll(/<loc>([^<]+)<\/loc>/g)) {
    const xml = await (await fetch(`${base}${stripHost(m[1])}`)).text();
    for (const loc of xml.matchAll(/<loc>([^<]+)<\/loc>/g)) paths.push(stripHost(loc[1]));
  }
  for (const extra of ["/", "/hosting-pricing", "/disclosure", "/referral-programs", "/marketplace"]) {
    if (!paths.includes(extra)) paths.push(extra);
  }
  return [...new Set(paths)];
}

async function fetchAll(base: string, paths: string[], concurrency = 12): Promise<Map<string, string>> {
  const bodies = new Map<string, string>();
  let cursor = 0;
  const worker = async () => {
    while (cursor < paths.length) {
      const p = paths[cursor++];
      bodies.set(p, await (await fetch(`${base}${p}`)).text());
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));
  return bodies;
}

describe("reading a rendered anchor", () => {
  it("reports the target and the words the reader clicks", () => {
    const anchors = anchorsIn('<a href="https://example.com/?ref=X" rel="noopener sponsored" target="_blank">Get $20 in credits &rarr;</a>');
    assert.strictEqual(anchors.length, 1);
    assert.strictEqual(anchors[0].href, "https://example.com/?ref=X");
    assert.strictEqual(anchors[0].label, "Get $20 in credits");
    assert.ok(isSponsored(anchors[0]));
  });

  it("does not mistake a rel that merely contains the letters for the sponsored token", () => {
    assert.ok(!isSponsored(anchorsIn('<a href="/x" rel="nosponsoredlink">y</a>')[0]));
    assert.ok(isSponsored(anchorsIn('<a href="/x" rel="sponsored">y</a>')[0]));
  });

  it("reads the label through nested markup", () => {
    const anchors = anchorsIn('<a href="/x" rel="sponsored"><span>Claim</span> your $20 credit</a>');
    assert.strictEqual(anchors[0].label, "Claim your $20 credit");
  });

  it("separates a label that promises the reader something from one that describes a page", () => {
    for (const label of ["Claim your credits", "Redeem now", "Unlock the free tier", "Sign up free"]) {
      assert.ok(offersAReaderBenefit(label), `"${label}" opens by telling the reader to take something`);
    }
    for (const label of ["View program details", "View", "Read the terms", "Full profile", "How the program works"]) {
      assert.ok(!offersAReaderBenefit(label), `"${label}" only describes what is on the other end`);
    }
  });

  it("reads the instruction the label opens with, not a verb buried in a description", () => {
    for (const label of ["How to get a referral code", "Read how we get paid", "Where to claim it, explained"]) {
      assert.ok(!offersAReaderBenefit(label), `"${label}" describes a claim rather than making one`);
    }
    assert.ok(offersAReaderBenefit("Get a referral code"), "the same verb in the first position is an instruction");
  });

  it("treats a stated amount as an offer whatever verb introduces it", () => {
    for (const label of ["$20 in credits", "20% off your first year", "Referral bonus: $300"]) {
      assert.ok(offersAReaderBenefit(label), `"${label}" quotes the reader a figure`);
    }
    assert.ok(!offersAReaderBenefit("Program details"), "a label with neither a figure nor an instruction is a description");
  });
});

describe("every link we mark sponsored is a referral link we hold", () => {
  let serverProc: ChildProcess | null = null;
  let bodies = new Map<string, string>();
  let paths: string[] = [];

  before(async () => {
    const started = await startServer();
    serverProc = started.proc;
    const base = `http://127.0.0.1:${started.port}`;
    paths = await everyPublishedPath(base);
    bodies = await fetchAll(base, paths);
  });

  after(() => { serverProc?.kill("SIGKILL"); });

  it("sweeps the whole published surface rather than a chosen sample", () => {
    assert.ok(paths.length > 3000, `expected the sitemap to enumerate the site, saw ${paths.length} paths`);
    const sponsored = [...bodies.values()].flatMap(sponsoredAnchorsIn);
    assert.ok(sponsored.length > 50, `expected the sweep to find the sponsored links we publish, saw ${sponsored.length}`);
  });

  it("points every sponsored link at a URL that attributes the signup to us", () => {
    const ours = new Set(allOurReferralLinks(offers).map((l: any) => l.url));
    assert.ok(ours.has(RAILWAY_REFERRAL_URL));
    const strays: string[] = [];
    for (const [p, body] of bodies) {
      for (const anchor of sponsoredAnchorsIn(body)) {
        if (!ours.has(anchor.href)) strays.push(`${p} -> ${anchor.href} ("${anchor.label}")`);
      }
    }
    assert.deepStrictEqual(strays, [], `a sponsored link that is not one of ours pays nobody:\n${strays.join("\n")}`);
  });

  it("never offers the reader a benefit at a vendor's own program page", () => {
    const programUrls = new Set(
      offers.map((o: any) => o.referral_program?.program_url).filter((u: unknown): u is string => typeof u === "string")
    );
    assert.ok(programUrls.has(RAILWAY_PROGRAM_URL));
    const misdirected: string[] = [];
    for (const [p, body] of bodies) {
      for (const anchor of anchorsIn(body)) {
        if (!programUrls.has(anchor.href)) continue;
        if (isSponsored(anchor) || offersAReaderBenefit(anchor.label)) {
          misdirected.push(`${p} -> ${anchor.href} ("${anchor.label}")`);
        }
      }
    }
    assert.deepStrictEqual(misdirected, [], `a program page is where you read about a program, not where a reward is claimed:\n${misdirected.join("\n")}`);
  });
});

describe("the hosting comparison offers the code we hold on the terms its record states", () => {
  let serverProc: ChildProcess | null = null;
  let page = "";

  before(async () => {
    const started = await startServer();
    serverProc = started.proc;
    page = await (await fetch(`http://127.0.0.1:${started.port}/hosting-pricing`)).text();
  });

  after(() => { serverProc?.kill("SIGKILL"); });

  it("sends the reader to our referral URL and not to the program page", () => {
    const sponsored = sponsoredAnchorsIn(page);
    assert.strictEqual(sponsored.length, 1, "the page offers exactly one referral");
    assert.strictEqual(sponsored[0].href, RAILWAY_REFERRAL_URL);
    assert.ok(!page.includes(RAILWAY_PROGRAM_URL), "the affiliate signup page is not an offer to the reader");
  });

  it("takes the URL, the benefit and the compensation from the same resolver the vendor page uses", () => {
    const ourLink = ourReferralLinkFor("Railway", railwayOffer);
    assert.ok(ourLink);
    assert.strictEqual(sponsoredAnchorsIn(page)[0].href, ourLink.url);
    assert.ok(page.includes(`Get ${ourLink.refereeBenefit}`), "the button names the benefit the record states");
    assert.ok(page.includes(`Railway — ${ourLink.refereeBenefit} with our referral`), "the heading names the benefit the record states");
    assert.ok(page.includes(COMMISSION_SENTENCE), "the page states what the link pays us");
  });

  it("makes no claim about Railway that no record backs", () => {
    assert.ok(!page.includes("top pick"), "we publish no ranking that awards a top pick");
    assert.ok(!page.includes("trial credit)"), "the comparison against a $5 trial credit was sourced from nothing");
    assert.ok(!page.includes("4x the standard"));
  });
});

describe("the hosting referral box answers the record it renders", () => {
  let serverProc: ChildProcess | null = null;
  let originalCodes = "";
  let conditionalPage = "";
  let noCodePage = "";

  const CONDITIONS = [
    "The credit is granted only after a payment method is linked",
    "Unused credit expires after 30 days",
  ];
  const CODE_URL = "https://railway.com?referralCode=CURATEDCODE";

  before(async () => {
    originalCodes = fs.readFileSync(PLATFORM_CODES_PATH, "utf-8");
    const withConditions = JSON.parse(originalCodes);
    for (const code of withConditions.platform_codes) {
      if (code.vendor !== "Railway") continue;
      code.restrictions = CONDITIONS;
      code.referral_url = CODE_URL;
      code.referee_benefit = "$45 in credits";
      code.referrer_compensation = "credit";
    }
    fs.writeFileSync(PLATFORM_CODES_PATH, JSON.stringify(withConditions, null, 2), "utf-8");
    resetPlatformCodesCache();
    const conditional = await startServer();
    conditionalPage = await (await fetch(`http://127.0.0.1:${conditional.port}/hosting-pricing`)).text();
    conditional.proc.kill("SIGKILL");

    const emptyCodes = JSON.parse(originalCodes);
    emptyCodes.platform_codes = [];
    fs.writeFileSync(PLATFORM_CODES_PATH, JSON.stringify(emptyCodes, null, 2), "utf-8");
    resetPlatformCodesCache();

    const withoutRailwayReferral = offers.map((o: any) => o.vendor === "Railway" ? { ...o, referral: undefined } : o);
    const indexDir = fs.mkdtempSync(path.join(os.tmpdir(), "hosting-referral-"));
    const indexPath = path.join(indexDir, "index.json");
    fs.writeFileSync(indexPath, JSON.stringify({ offers: withoutRailwayReferral }), "utf-8");
    const started = await startServer({ AGENTDEALS_INDEX_PATH: indexPath });
    serverProc = started.proc;
    noCodePage = await (await fetch(`http://127.0.0.1:${started.port}/hosting-pricing`)).text();
  });

  after(() => {
    serverProc?.kill("SIGKILL");
    fs.writeFileSync(PLATFORM_CODES_PATH, originalCodes, "utf-8");
    resetPlatformCodesCache();
  });

  it("prefers the curated code over the offer store, as the vendor page does", () => {
    const sponsored = sponsoredAnchorsIn(conditionalPage);
    assert.strictEqual(sponsored.length, 1);
    assert.strictEqual(sponsored[0].href, CODE_URL, "the box must resolve the link the same way every other referral surface does");
    assert.ok(!conditionalPage.includes(RAILWAY_REFERRAL_URL), "the offer store's URL is not the one we hold for this vendor");
    assert.ok(conditionalPage.includes("$45 in credits"), "the benefit comes from the record the link came from");
    assert.ok(!conditionalPage.includes("$20 in credits"), "no part of the box restates a benefit from elsewhere");
  });

  it("says what this link pays us rather than what the last one did", () => {
    assert.ok(
      conditionalPage.includes("We are paid in vendor credit, not cash, if you sign up through this link."),
      "a code paid in credit must not be disclosed as a commission"
    );
    assert.ok(!conditionalPage.includes(COMMISSION_SENTENCE));
  });

  it("states what a conditional reward costs the reader above the button", () => {
    assert.ok(conditionalPage.includes(REFERRAL_CONDITIONS_HEADING), "the conditions are introduced as conditions");
    for (const condition of CONDITIONS) assert.ok(conditionalPage.includes(condition), condition);
    const heading = conditionalPage.indexOf(REFERRAL_CONDITIONS_HEADING);
    const button = conditionalPage.indexOf('rel="noopener sponsored"');
    assert.ok(heading > 0 && heading < button, "a condition stated after the click is stated too late");
  });

  it("drops the box entirely when we hold no link for the vendor, program or not", () => {
    assert.ok(noCodePage.includes("Cloud Hosting"), "the rest of the page still renders");
    assert.ok(!noCodePage.includes('<div class="referral-box">'), "there is nothing to offer");
    assert.deepStrictEqual(sponsoredAnchorsIn(noCodePage), [], "there is nothing to disclose");
    assert.ok(!noCodePage.includes("with our referral"));
  });
});
