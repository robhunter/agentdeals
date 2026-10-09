import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { changesToStartupProgrammes, listingCountsByVendor, STARTUP_PROGRAMME_LISTINGS } from "../dist/startup-programme-changes.js";
import { changesTheVendorMade, loadDealChanges, loadOffers } from "../dist/data.js";

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

const CATALOGUE = [
  "AWS Activate", "AWS", "AWS",
  "DigitalOcean", "DigitalOcean",
  "Cloudflare for Startups", "Cloudflare",
  "Google for Startups Cloud Program", "Google",
  "Microsoft for Startups",
  "Stripe Atlas", "Stripe",
  "Amazon Kiro (AWS Startups)", "Kiro",
  "Segment Startup Program",
  "PostHog", "PostHog", "PostHog",
].map((vendor) => ({ vendor }));

function kept(changes: { vendor: string; tier?: string | null }[]): string[] {
  return changesToStartupProgrammes(changes, CATALOGUE).map((change: { vendor: string; tier?: string | null }) => `${change.vendor}/${change.tier ?? "-"}`);
}

describe("a startup programme's changes are the records about its own catalogue listing", () => {
  it("keeps a record filed under the programme listing's vendor", () => {
    assert.deepStrictEqual(kept([{ vendor: "AWS Activate" }, { vendor: "Amazon Kiro (AWS Startups)", tier: "AWS Startups" }]), ["AWS Activate/-", "Amazon Kiro (AWS Startups)/AWS Startups"]);
  });

  it("leaves out records about the same company's other products", () => {
    assert.deepStrictEqual(kept([{ vendor: "AWS" }, { vendor: "Google" }, { vendor: "Cloudflare" }, { vendor: "Stripe" }, { vendor: "Kiro" }]), []);
  });

  it("matches the listing's vendor exactly, not as part of a longer or shorter name", () => {
    assert.deepStrictEqual(kept([{ vendor: "Cloudflare Startup Program" }, { vendor: "Google Cloud Run" }, { vendor: "Microsoft" }]), []);
  });

  it("where the vendor has several listings, keeps only the records on the programme's tier", () => {
    assert.deepStrictEqual(kept([{ vendor: "DigitalOcean", tier: "Startup Credits" }, { vendor: "DigitalOcean", tier: "Droplets" }, { vendor: "DigitalOcean" }]), ["DigitalOcean/Startup Credits"]);
  });

  it("keeps the records of programmes the page no longer lists, so their ending shows", () => {
    assert.deepStrictEqual(kept([{ vendor: "Segment Startup Program" }, { vendor: "Segment" }]), ["Segment Startup Program/-"]);
  });

  it("keeps the records of PostHog's programme listings and none of its free tier's", () => {
    assert.deepStrictEqual(kept([{ vendor: "PostHog", tier: "Startup Credits" }, { vendor: "PostHog", tier: "Free" }]), ["PostHog/Startup Credits"]);
  });

  it("keeps the records of Microsoft for Startups, the one Microsoft programme listing", () => {
    assert.deepStrictEqual(kept([{ vendor: "Microsoft for Startups" }]), ["Microsoft for Startups/-"]);
  });

  it("names a catalogue vendor for every programme it selects on, and one of its listings' tiers where the vendor holds several", () => {
    const offers: { vendor: string; tier: string }[] = loadOffers();
    const listed = new Set(offers.map((offer) => `${offer.vendor}/${offer.tier}`));
    const counts = listingCountsByVendor(offers);
    const unmatched = STARTUP_PROGRAMME_LISTINGS.filter(({ vendor, tier }) => {
      const held = counts.get(vendor) ?? 0;
      return held === 0 || (held > 1 && !listed.has(`${vendor}/${tier}`));
    });
    assert.deepStrictEqual(unmatched.map(({ vendor, tier }) => `${vendor}/${tier}`), []);
  });
});

let server: ChildProcess;
let base = "";

function recentChangeVendors(html: string): string[] {
  const table = html.split('<h2 id="changes">')[1]?.split("</table>")[0] ?? "";
  return [...table.matchAll(/<tr>\s*<td[^>]*>[^<]*<\/td>\s*<td[^>]*>([^<]*)<\/td>/g)].map(([, vendor]) => vendor);
}

describe("the startup credits guide and its API list only the programmes' own changes", () => {
  before(async () => {
    server = spawn("node", [path.join(REPO, "dist", "serve.js")], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, PORT: "0", BASE_URL: "http://localhost", TZ: "UTC" },
    });
    base = await new Promise<string>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Server startup timeout")), 30000);
      server.stderr!.on("data", (data: Buffer) => {
        const match = data.toString().match(/running on http:\/\/localhost:(\d+)/);
        if (match) {
          clearTimeout(timeout);
          resolve(`http://localhost:${match[1]}`);
        }
      });
      server.on("error", (err) => {
        clearTimeout(timeout);
        reject(err);
      });
    });
  });
  after(() => {
    server?.kill();
  });

  it("shows in Recent Changes every record the store holds about a programme listing, and nothing else", async () => {
    const vendors = recentChangeVendors(await (await fetch(`${base}/startup-credits`)).text());
    const expected = changesToStartupProgrammes(changesTheVendorMade(loadDealChanges()), loadOffers());
    assert.ok(expected.length > 0, "the store holds no record about a programme listing");
    const programmeVendors = new Set(STARTUP_PROGRAMME_LISTINGS.map(({ vendor }) => vendor));
    assert.deepStrictEqual(vendors.filter((vendor) => !programmeVendors.has(vendor)), []);
    assert.strictEqual(vendors.length, expected.length);
  });

  it("returns from /api/startup-credits the records about programme listings and no others", async () => {
    const { changes } = await (await fetch(`${base}/api/startup-credits`)).json();
    const expected = changesToStartupProgrammes(loadDealChanges(), loadOffers());
    const key = (change: { vendor: string; date: string; change_type: string }) => `${change.vendor} ${change.date} ${change.change_type}`;
    assert.deepStrictEqual(changes.map(key).sort(), expected.map(key).sort());
  });
});
