import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(__dirname, "..");

const { documentsVendorReferralProgram, ourReferralLinkFor, TERMS_READ_LABEL } = await import("../dist/referral-surfaces.js");
const { offerRetired } = await import("../dist/retirement.js");
const { toSlug } = await import("../dist/vendor-slug.js");

const READ_ON = "2026-09-01";
const PROGRAM_PAGE = (name: string) => `https://programs.example/${name}`;

const catalogue = JSON.parse(readFileSync(path.join(REPO, "data", "index.json"), "utf-8"));
const rowsPerVendor = new Map<string, number>();
for (const o of catalogue.offers) rowsPerVendor.set(o.vendor, (rowsPerVendor.get(o.vendor) ?? 0) + 1);

const subjects = catalogue.offers
  .filter(
    (o: any) =>
      rowsPerVendor.get(o.vendor) === 1 &&
      !o.referral &&
      !offerRetired(o) &&
      ourReferralLinkFor(o.vendor, o) === null &&
      /^[A-Za-z][A-Za-z0-9 ]+$/.test(o.vendor)
  )
  .slice(0, 6);

const [answers, refused, gone, moved, unread, closed] = subjects;

const program = (name: string, over: Record<string, unknown> = {}) => ({
  available: true,
  referrer_benefit: `${name} referrer credit`,
  referee_benefit: `${name} referee credit`,
  program_url: PROGRAM_PAGE(name),
  type: "self-service",
  read_on: READ_ON,
  ...over,
});

const PLANTED = new Map<any, ReturnType<typeof program>>([
  [answers, program("answers")],
  [refused, program("refused")],
  [gone, program("gone")],
  [moved, program("moved")],
  [unread, program("unread", { read_on: undefined })],
  [closed, program("closed", { available: false })],
]);

const LINK_HEALTH = {
  generated_at: "2026-10-01",
  links: [
    { url: PROGRAM_PAGE("gone"), checked: "2026-10-01", outcome: "unreachable", detail: "GET 404", terminal: false, last_reachable: null, consecutive_unreachable: 1 },
    { url: PROGRAM_PAGE("moved"), checked: "2026-10-01", outcome: "reachable", detail: "HEAD 200", terminal: false, last_reachable: "2026-10-01", consecutive_unreachable: 0, redirected_to: "https://programs.example/" },
    { url: PROGRAM_PAGE("refused"), checked: "2026-10-01", outcome: "unknown", detail: "GET 403", terminal: false, last_reachable: null, consecutive_unreachable: 0 },
  ],
};

const PUBLISHED = [answers, refused];
const WITHHELD = [gone, moved, unread, closed];

let dir = "";
let proc: ChildProcess | null = null;
let port = 0;
const pages = new Map<string, string>();

function startServer(env: Record<string, string>): Promise<ChildProcess> {
  return new Promise((resolve, reject) => {
    const child = spawn("node", [path.join(REPO, "dist", "serve.js")], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, PORT: "0", BASE_URL: "http://localhost", ...env },
    });
    const timeout = setTimeout(() => { child.kill(); reject(new Error("Server startup timeout")); }, 30000);
    child.stderr!.on("data", (data: Buffer) => {
      const m = data.toString().match(/running on http:\/\/localhost:(\d+)/);
      if (m) { port = parseInt(m[1], 10); clearTimeout(timeout); resolve(child); }
    });
    child.on("error", (err) => { clearTimeout(timeout); reject(err); });
  });
}

async function page(route: string): Promise<string> {
  if (!pages.has(route)) {
    const res = await fetch(`http://localhost:${port}${route}`);
    assert.equal(res.status, 200, `${route} should answer 200`);
    pages.set(route, await res.text());
  }
  return pages.get(route)!;
}

function tableRows(html: string): string[] {
  return [...html.matchAll(/<tr data-category="[^"]*">([\s\S]*?)<\/tr>/g)].map((m) => m[1]);
}

function rowFor(html: string, vendor: string): string | undefined {
  return tableRows(html).find((row) => row.includes(`>${vendor}<`));
}

before(async () => {
  assert.equal(subjects.length, 6, "expected six single-listing vendors with no referral link of ours to plant programs on");
  dir = mkdtempSync(path.join(tmpdir(), "program-pages-"));
  for (const offer of catalogue.offers) delete offer.referral_program;
  for (const [offer, planted] of PLANTED) offer.referral_program = JSON.parse(JSON.stringify(planted));
  writeFileSync(path.join(dir, "index.json"), JSON.stringify(catalogue));
  writeFileSync(path.join(dir, "link_health.json"), JSON.stringify(LINK_HEALTH));
  proc = await startServer({
    AGENTDEALS_INDEX_PATH: path.join(dir, "index.json"),
    AGENTDEALS_LINK_HEALTH_PATH: path.join(dir, "link_health.json"),
  });
});

after(() => {
  proc?.kill("SIGKILL");
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe("#1152 a referral program is published only while its page answers and we have read its terms there", () => {
  it("lists on /referral-programs the programs whose page answered or refused us, and none whose page is gone, moved or unread", async () => {
    const html = await page("/referral-programs");
    for (const offer of PUBLISHED) assert.ok(rowFor(html, offer.vendor), `${offer.vendor} should have a row`);
    for (const offer of WITHHELD) assert.equal(rowFor(html, offer.vendor), undefined, `${offer.vendor} must not have a row`);
    assert.equal(tableRows(html).length, PUBLISHED.length);
  });

  it("counts on /referral-programs only the programs it lists, in its text and its structured data", async () => {
    const html = await page("/referral-programs");
    assert.ok(html.includes(`${PUBLISHED.length} developer tools with active referral programs`));
    const itemList = [...html.matchAll(/<script type="application\/ld\+json">(.*?)<\/script>/g)]
      .map((m) => JSON.parse(m[1]))
      .find((d: any) => d["@type"] === "ItemList");
    const named = itemList.itemListElement.map((e: any) => e.item.name.replace(" Referral Program", "")).sort();
    assert.deepEqual(named, PUBLISHED.map((o: any) => o.vendor).sort());
  });

  it("returns from /api/referral-programs the same programs, each with the date we read its terms", async () => {
    const body = JSON.parse(await page("/api/referral-programs"));
    const byVendor = new Map(body.programs.map((p: any) => [p.vendor, p]));
    assert.deepEqual([...byVendor.keys()].sort(), PUBLISHED.map((o: any) => o.vendor).sort());
    for (const offer of PUBLISHED) assert.equal((byVendor.get(offer.vendor) as any).read_on, READ_ON);
  });

  it("shows the referral program card on the vendor page only for a published program", async () => {
    for (const offer of PUBLISHED) {
      const html = await page(`/vendor/${toSlug(offer.vendor)}`);
      assert.ok(html.includes("<h2>Referral Program</h2>"), `/vendor/${toSlug(offer.vendor)} should show its program`);
    }
    for (const offer of WITHHELD) {
      const html = await page(`/vendor/${toSlug(offer.vendor)}`);
      assert.ok(!html.includes("<h2>Referral Program</h2>"), `/vendor/${toSlug(offer.vendor)} must not show its program`);
      assert.ok(!html.includes(PLANTED.get(offer)!.referrer_benefit), `/vendor/${toSlug(offer.vendor)} must not print its program's terms`);
    }
  });

  it("counts on /disclosure only the vendors whose program it publishes", async () => {
    const html = await page("/disclosure");
    assert.ok(html.includes(`We also document ${PUBLISHED.length} vendors that run their own referral programs`));
  });
});

describe("#1152 a program whose read date is not a date we can print is not published", () => {
  it("publishes nothing for a read date that is not a calendar date", () => {
    for (const read_on of ["September 2026", "2026-9-1", "", undefined]) {
      const offer = { vendor: "Example Mail", referral_program: { ...program("unit"), read_on } };
      assert.equal(documentsVendorReferralProgram(offer), false, `read_on ${JSON.stringify(read_on)} must not publish`);
    }
    assert.equal(documentsVendorReferralProgram({ vendor: "Example Mail", referral_program: program("unit") }), true);
  });
});

describe("#1152 every published referral program says when we read its terms", () => {
  it("prints the read date in its own column on /referral-programs", async () => {
    const html = await page("/referral-programs");
    assert.ok(html.includes(`<th>${TERMS_READ_LABEL}</th>`));
    for (const offer of PUBLISHED) {
      assert.ok(rowFor(html, offer.vendor)!.includes(`<td class="read-cell">${READ_ON}</td>`), `${offer.vendor}'s row should print ${READ_ON}`);
    }
  });

  it("prints the read date on the vendor page's program card", async () => {
    for (const offer of PUBLISHED) {
      const html = await page(`/vendor/${toSlug(offer.vendor)}`);
      assert.ok(html.includes(`${TERMS_READ_LABEL} ${READ_ON}`), `/vendor/${toSlug(offer.vendor)} should print when we read the terms`);
    }
  });
});
