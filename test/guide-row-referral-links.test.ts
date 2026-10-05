import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const { referrerDisclosureSentence } = await import("../dist/referral-surfaces.js");
const { censusTableFigures } = await import("../dist/table-figures.js");

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(__dirname, "..");
const STORE = JSON.parse(readFileSync(path.join(REPO, "data", "platform_codes.json"), "utf8"));

function spawnServer(env: Record<string, string> = {}): Promise<{ child: ChildProcess; port: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn("node", [path.join(REPO, "dist", "serve.js")], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, PORT: "0", BASE_URL: "http://localhost", ...env },
    });
    const timeout = setTimeout(() => { child.kill(); reject(new Error("Server startup timeout")); }, 30000);
    child.stderr!.on("data", (data: Buffer) => {
      const m = data.toString().match(/running on http:\/\/localhost:(\d+)/);
      if (m) { clearTimeout(timeout); resolve({ child, port: parseInt(m[1], 10) }); }
    });
    child.on("error", (err) => { clearTimeout(timeout); reject(err); });
  });
}

const asPageText = (text: string) =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const sectionSixRows = (page: string) => {
  const section = page.slice(page.indexOf('<h2 id="alternatives">'), page.indexOf('<h2 id="industry">'));
  return [...section.matchAll(/<tr[\s>][\s\S]*?<\/tr>/g)].map(([row]) => row).filter(row => row.includes("<td"));
};

const providerOf = (row: string) => (row.match(/<td[^>]*>([\s\S]*?)<\/td>/)?.[1] ?? "").replace(/<[^>]+>/g, "").trim();

const rowNaming = (page: string, provider: string) => {
  const rows = sectionSixRows(page).filter(row => providerOf(row) === provider);
  assert.strictEqual(rows.length, 1, `section 6 should hold one ${provider} row`);
  return rows[0];
};

const activeCodeFiledUnder = (vendor: string) => {
  const code = STORE.platform_codes.find((c: any) => c.vendor === vendor && c.active);
  assert.ok(code, `data/platform_codes.json should hold an active code filed under ${vendor}`);
  return code;
};

function assertRowCarriesCode(row: string, code: any) {
  const href = `href="${asPageText(code.referral_url)}" rel="noopener sponsored"`;
  assert.ok(row.includes(href), `the row should link ${code.referral_url}`);
  assert.ok(row.includes(`Sign up via our referral link and get ${asPageText(code.referee_benefit)}`), "the row should name the reader's benefit");
  assert.strictEqual(row.includes("referral-conditions"), code.restrictions.length > 0, "a conditions block exactly when the record states a restriction");
  for (const restriction of code.restrictions) {
    const at = row.indexOf(asPageText(restriction));
    assert.ok(at > -1, `the row should state: ${restriction}`);
    assert.ok(at < row.indexOf(href), "each condition comes before the link");
  }
  assert.ok(row.includes(asPageText(referrerDisclosureSentence(code.referrer_compensation))), "the row should say what the link pays us");
  assert.ok(row.includes('<a href="/disclosure">'), "the row should link the disclosure");
}

describe("our referral links on the /hetzner-pricing-2026 rows that name the vendor", () => {
  const servers: ChildProcess[] = [];
  let scratch = "";
  let page = "";
  let withRailwayRemovedAndVultrInactive = "";
  let withNoCodes = "";

  const pageServedWith = async (env: Record<string, string>) => {
    const { child, port } = await spawnServer(env);
    servers.push(child);
    return (await fetch(`http://localhost:${port}/hetzner-pricing-2026`)).text();
  };

  before(async () => {
    scratch = mkdtempSync(path.join(tmpdir(), "guide-row-referral-"));
    const removedOrInactive = path.join(scratch, "removed-or-inactive.json");
    writeFileSync(removedOrInactive, JSON.stringify({
      platform_codes: STORE.platform_codes
        .filter((c: any) => c.vendor !== "Railway")
        .map((c: any) => (c.vendor === "Vultr DNS" ? { ...c, active: false } : c)),
    }));
    const none = path.join(scratch, "none.json");
    writeFileSync(none, JSON.stringify({ platform_codes: [] }));

    page = await pageServedWith({});
    withRailwayRemovedAndVultrInactive = await pageServedWith({ AGENTDEALS_PLATFORM_CODES_PATH: removedOrInactive });
    withNoCodes = await pageServedWith({ AGENTDEALS_PLATFORM_CODES_PATH: none });
  });

  after(() => {
    for (const child of servers) child.kill();
    rmSync(scratch, { recursive: true, force: true });
  });

  it("links the Railway row with the benefit and conditions Railway's code states", () => {
    assertRowCarriesCode(rowNaming(page, "Railway"), activeCodeFiledUnder("Railway"));
  });

  it("links the Vultr row with the vultr.com sign-up code filed under Vultr DNS", () => {
    const code = activeCodeFiledUnder("Vultr DNS");
    assert.strictEqual(new URL(code.referral_url).hostname, "www.vultr.com");
    assertRowCarriesCode(rowNaming(page, "Vultr"), code);
  });

  it("links no row that names a vendor without a code of ours", () => {
    for (const row of sectionSixRows(page)) {
      if (["Railway", "Vultr"].includes(providerOf(row))) continue;
      assert.ok(!row.includes("row-referral"), `${providerOf(row)} should carry no referral link`);
    }
  });

  it("drops the link from a row whose code is removed or inactive", () => {
    for (const provider of ["Railway", "Vultr"]) {
      const row = rowNaming(withRailwayRemovedAndVultrInactive, provider);
      assert.ok(!row.includes("row-referral"), `${provider}'s row should carry no link`);
      assert.ok(!row.includes('rel="noopener sponsored"'), `${provider}'s row should carry no sponsored link`);
    }
  });

  it("never prints an inactive code", () => {
    const inactiveUrls = STORE.platform_codes.filter((c: any) => !c.active).map((c: any) => c.referral_url);
    const vultrUrls = STORE.platform_codes.filter((c: any) => c.vendor === "Vultr DNS").map((c: any) => c.referral_url);
    for (const url of inactiveUrls) assert.ok(!page.includes(asPageText(url)), `${url} is inactive`);
    for (const url of vultrUrls) assert.ok(!withRailwayRemovedAndVultrInactive.includes(asPageText(url)), `${url} was made inactive`);
  });

  it("leaves the sponsored blocks out of the table's figure count", () => {
    const sectionSixCensus = (served: string) =>
      censusTableFigures(served, served).tables.find((table: any) => table.label === "6. Alternatives Comparison");
    assert.ok(sectionSixCensus(page), "section 6's table should be measured");
    assert.deepStrictEqual(sectionSixCensus(page), sectionSixCensus(withNoCodes));
  });

  it("keeps the table's rows and their order with or without platform codes", () => {
    const providers = sectionSixRows(page).map(providerOf);
    assert.ok(providers.length >= 2);
    assert.deepStrictEqual(sectionSixRows(withNoCodes).map(providerOf), providers);
    assert.deepStrictEqual(sectionSixRows(withRailwayRemovedAndVultrInactive).map(providerOf), providers);
    assert.ok(sectionSixRows(withNoCodes).every(row => !row.includes("row-referral")));
  });
});
