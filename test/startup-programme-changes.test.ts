import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { changeEntryLongDateLabel } from "../dist/change-dates.js";
import { STARTUP_PROGRAMS } from "../dist/startup-programmes.js";
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

function escaped(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function changeRows(html: string, anchor: string): string[] {
  const section = html.split(`<h2 id="${anchor}">`)[1]?.split("<h2 ")[0] ?? "";
  const body = section.split("<tbody>")[1]?.split("</tbody>")[0] ?? "";
  return [...body.matchAll(/<tr>([\s\S]*?)<\/tr>/g)].map(([, row]) => {
    const cells = [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map(([, cell]) => cell.split("<")[0].trim());
    assert.strictEqual(cells.length, 4);
    return JSON.stringify(cells.slice(0, 3));
  }).sort();
}

function assertProgrammeTables(html: string, records: ReturnType<typeof loadDealChanges>, today: string): void {
  for (const [anchor, upcoming] of [["changes", false], ["upcoming-changes", true]] as const) {
    const expected = records.filter((record) => (record.date > today) === upcoming)
      .map((record) => JSON.stringify([escaped(changeEntryLongDateLabel(record)), escaped(record.vendor), escaped(record.summary)])).sort();
    assert.deepStrictEqual(changeRows(html, anchor), expected, anchor);
  }
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

  it("shows every programme record in the Recent or Upcoming table for its effective date, and nothing else", async () => {
    const expected = changesToStartupProgrammes(changesTheVendorMade(loadDealChanges()), loadOffers());
    const today = new Date().toISOString().slice(0, 10);
    const response = await fetch(`${base}/startup-credits`, { redirect: "error" });
    assert.strictEqual(response.status, 200);
    assertProgrammeTables(await response.text(), expected, today);
  });

  it("keeps Cloudflare's bootstrapped amount consistent with Tier 3", () => {
    const programme = STARTUP_PROGRAMS.find(({ slug }) => slug === "cloudflare-startup-program")!;
    assert.match(programme.hiddenConstraints!, /bootstrapped startups get \$10K\./);
    assert.doesNotMatch(programme.hiddenConstraints!, /\$5K/);
  });

  it("places past and current records in Recent Changes and future records in Upcoming Changes without losing siblings", async () => {
    const today = new Date().toISOString().slice(0, 10);
    const day = (offset: number) => new Date(Date.parse(today) + offset * 86400000).toISOString().slice(0, 10);
    const record = (offset: number, summary: string) => ({
      vendor: "Cloudflare for Startups", date: day(offset), date_source: "vendor_page" as const,
      change_type: "limits_reduced" as const, summary, previous_state: "Previous fixture terms.",
      current_state: "Current fixture terms.", impact: "medium" as const,
      source_url: "https://www.cloudflare.com/startups/", category: "Startup Programs",
      recorded_date: today, alternatives: [],
    });
    const fixtures = [record(-1, "Past programme fixture."), record(0, "Current programme fixture."),
      record(19, "Future programme fixture A."), record(19, "Future programme fixture B.")];
    const unrelated = { ...record(19, "Other product fixture."), vendor: "Cloudflare" };
    const dir = mkdtempSync(path.join(tmpdir(), "startup-programme-changes-"));
    const changesPath = path.join(dir, "changes.json");
    writeFileSync(changesPath, JSON.stringify({ changes: [...fixtures, unrelated] }));
    const proc = spawn("node", [path.join(REPO, "dist", "serve.js")], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, PORT: "0", BASE_URL: "http://localhost", TZ: "UTC", AGENTDEALS_CHANGES_PATH: changesPath },
    });
    try {
      const fixtureBase = await new Promise<string>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("Fixture server startup timeout")), 30000);
        proc.stderr!.on("data", (data: Buffer) => {
          const match = data.toString().match(/running on http:\/\/localhost:(\d+)/);
          if (match) { clearTimeout(timeout); resolve(`http://localhost:${match[1]}`); }
        });
        proc.on("error", (err) => { clearTimeout(timeout); reject(err); });
      });
      const response = await fetch(`${fixtureBase}/startup-credits`, { redirect: "error" });
      assert.strictEqual(response.status, 200);
      const html = await response.text();
      assertProgrammeTables(html, fixtures, today);
      assert.strictEqual(changeRows(html, "changes").length, 2);
      assert.strictEqual(changeRows(html, "upcoming-changes").length, 2);
    } finally {
      proc.kill();
      await new Promise<void>((resolve) => proc.exitCode !== null ? resolve() : proc.once("exit", () => resolve()));
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns from /api/startup-credits the records about programme listings and no others", async () => {
    const { changes } = await (await fetch(`${base}/api/startup-credits`)).json();
    const expected = changesToStartupProgrammes(loadDealChanges(), loadOffers());
    const key = (change: { vendor: string; date: string; change_type: string }) => `${change.vendor} ${change.date} ${change.change_type}`;
    assert.deepStrictEqual(changes.map(key).sort(), expected.map(key).sort());
  });
});
