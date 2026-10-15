import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const { REFERRAL_CONDITIONS_HEADING, referrerDisclosureSentence } = await import("../dist/referral-surfaces.js");
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
  const href = `href="${asPageText(code.referral_url)}" rel="nofollow noopener sponsored"`;
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

describe("/hetzner-pricing-2026 offers none of our referral links on its rows", () => {
  const servers: ChildProcess[] = [];
  let scratch = "";
  let page = "";
  let withNoCodes = "";
  const surfacesKeepingTheCodes = new Map<string, string>();

  const serverWith = async (env: Record<string, string>) => {
    const { child, port } = await spawnServer(env);
    servers.push(child);
    return async (route: string) => (await fetch(`http://localhost:${port}${route}`)).text();
  };

  before(async () => {
    scratch = mkdtempSync(path.join(tmpdir(), "guide-row-referral-"));
    const none = path.join(scratch, "none.json");
    writeFileSync(none, JSON.stringify({ platform_codes: [] }));

    const served = await serverWith({});
    page = await served("/hetzner-pricing-2026");
    for (const route of ["/vendor/railway", "/vendor/vultr", "/referral-programs", "/disclosure"]) {
      surfacesKeepingTheCodes.set(route, await served(route));
    }
    withNoCodes = await (await serverWith({ AGENTDEALS_PLATFORM_CODES_PATH: none }))("/hetzner-pricing-2026");
  });

  after(() => {
    for (const child of servers) child.kill();
    rmSync(scratch, { recursive: true, force: true });
  });

  it("prints no referral link, reader benefit or payment sentence of ours, though its rows name Railway and Vultr", () => {
    for (const vendor of ["Railway", "Vultr"]) {
      assert.ok(!rowNaming(page, vendor).includes("row-referral"), `the ${vendor} row should carry no referral block`);
      activeCodeFiledUnder(vendor);
    }
    for (const code of STORE.platform_codes.filter((c: any) => c.active)) {
      assert.ok(!page.includes(asPageText(code.referral_url)), `the page should not link ${code.referral_url}`);
    }
    assert.ok(!page.includes("via our referral link"), "the page should offer no referral benefit");
    for (const compensation of ["commission", "credit", "none", null]) {
      const sentence = referrerDisclosureSentence(compensation);
      assert.ok(!page.includes(asPageText(sentence)), `the page should not say: ${sentence}`);
    }
    assert.doesNotMatch(page, /class="row-referral"|rel="[^"]*\bsponsored\b/);
  });

  it("serves the same rows, in the same order, with or without our codes", () => {
    const rows = sectionSixRows(page);
    assert.ok(rows.length >= 2, "section 6 should hold the alternatives rows");
    assert.deepStrictEqual(sectionSixRows(withNoCodes), rows);
  });

  it("keeps the Railway and Vultr codes on their vendor pages, /referral-programs and /disclosure", () => {
    for (const [vendor, vendorPage] of [["Railway", "/vendor/railway"], ["Vultr", "/vendor/vultr"]]) {
      const code = activeCodeFiledUnder(vendor);
      const url = asPageText(code.referral_url);
      assert.ok(surfacesKeepingTheCodes.get(vendorPage)!.includes(url), `${vendorPage} should link ${code.referral_url}`);
      assert.ok(surfacesKeepingTheCodes.get("/referral-programs")!.includes(url), `/referral-programs should link ${code.referral_url}`);
      const partner = `<a href="${vendorPage}">${vendor}</a>: ${asPageText(code.referee_benefit)}`;
      assert.ok(surfacesKeepingTheCodes.get("/disclosure")!.includes(partner), `/disclosure should list ${vendor} as a partner`);
    }
  });
});

const GUIDE_TABLES_NAMING_A_CODE_HOLDER = [
  { route: "/aws-free-tier-2026", from: '<h2 id="alternatives">', to: '<h2 id="changes">', linked: { Railway: "Railway" } },
  { route: "/gcp-free-tier-2026", from: '<h2 id="alternatives">', to: '<h2 id="changes">', linked: { Railway: "Railway" } },
  { route: "/azure-free-tier-2026", from: '<h2 id="alternatives">', to: '<h2 id="startups">', linked: { Railway: "Railway" } },
  { route: "/digitalocean-free-tier-2026", from: '<h2 id="alternatives">', to: '<h2 id="startups">', linked: { Railway: "Railway", Vultr: "Vultr" } },
  { route: "/google-developer-program-2026", from: '<h2 id="cloud-alts">', to: '<h2 id="ai-alts">', linked: { Railway: "Railway" } },
  { route: "/hosting-free-tier-comparison-2026", from: '<h2 id="main-comparison">', to: '<h2 id="frontend-jamstack">', linked: { Railway: "Railway" } },
] as const;

type GuideTable = (typeof GUIDE_TABLES_NAMING_A_CODE_HOLDER)[number];

const tableRowsOf = (page: string, table: GuideTable) => {
  const from = page.indexOf(table.from);
  const to = page.indexOf(table.to, from);
  assert.ok(from > -1 && to > from, `${table.route} should hold the section from ${table.from} to ${table.to}`);
  return [...page.slice(from, to).matchAll(/<tr[\s>][\s\S]*?<\/tr>/g)].map(([row]) => row).filter(row => row.includes("<td"));
};

const vendorNamedBy = (row: string) => {
  const firstCell = row.match(/<td[^>]*>([\s\S]*?)<\/td>/)?.[1] ?? "";
  return (firstCell.match(/<(a|span)\b[^>]*>([^<]*)<\/\1>/)?.[2] ?? firstCell.replace(/<[^>]+>/g, "")).trim();
};

const rowOf = (page: string, table: GuideTable, vendor: string) => {
  const rows = tableRowsOf(page, table).filter(row => vendorNamedBy(row) === vendor);
  assert.strictEqual(rows.length, 1, `${table.route} should hold one ${vendor} row in its table`);
  return rows[0];
};

const withTheMarkupDropped = (html: string) => ` ${html.replace(/<[^>]+>/g, "").replace(/\s+/g, " ")} `;

describe("our referral links on the guide rows that name Railway or Vultr", () => {
  const servers: ChildProcess[] = [];
  let scratch = "";
  const served = new Map<string, string>();
  const servedWithRailwayRemovedAndVultrInactive = new Map<string, string>();
  const servedWithNoCodes = new Map<string, string>();
  const servedWithVultrFiledUnderItsDnsListing = new Map<string, string>();

  const serveEveryRoute = async (env: Record<string, string>, into: Map<string, string>) => {
    const { child, port } = await spawnServer(env);
    servers.push(child);
    for (const { route } of GUIDE_TABLES_NAMING_A_CODE_HOLDER) {
      into.set(route, await (await fetch(`http://localhost:${port}${route}`)).text());
    }
  };

  before(async () => {
    scratch = mkdtempSync(path.join(tmpdir(), "guide-row-referral-guides-"));
    const removedOrInactive = path.join(scratch, "removed-or-inactive.json");
    writeFileSync(removedOrInactive, JSON.stringify({
      platform_codes: STORE.platform_codes
        .filter((c: any) => c.vendor !== "Railway")
        .map((c: any) => (c.vendor === "Vultr" ? { ...c, active: false } : c)),
    }));
    const none = path.join(scratch, "none.json");
    writeFileSync(none, JSON.stringify({ platform_codes: [] }));
    const filedUnderTheDnsListing = path.join(scratch, "filed-under-the-dns-listing.json");
    writeFileSync(filedUnderTheDnsListing, JSON.stringify({
      platform_codes: STORE.platform_codes.map((c: any) => (c.vendor === "Vultr" ? { ...c, vendor: "Vultr DNS" } : c)),
    }));

    await serveEveryRoute({}, served);
    await serveEveryRoute({ AGENTDEALS_PLATFORM_CODES_PATH: removedOrInactive }, servedWithRailwayRemovedAndVultrInactive);
    await serveEveryRoute({ AGENTDEALS_PLATFORM_CODES_PATH: none }, servedWithNoCodes);
    await serveEveryRoute({ AGENTDEALS_PLATFORM_CODES_PATH: filedUnderTheDnsListing }, servedWithVultrFiledUnderItsDnsListing);
  });

  after(() => {
    for (const child of servers) child.kill();
    rmSync(scratch, { recursive: true, force: true });
  });

  it("links each Railway and Vultr row with the benefit, conditions and disclosure its code states", () => {
    for (const table of GUIDE_TABLES_NAMING_A_CODE_HOLDER) {
      for (const [vendor, filedUnder] of Object.entries(table.linked)) {
        const row = rowOf(served.get(table.route)!, table, vendor);
        assert.ok(row.includes('class="row-referral"'), `${table.route}: the ${vendor} row should carry our referral link`);
        assertRowCarriesCode(row, activeCodeFiledUnder(filedUnder));
      }
    }
  });

  it("still links the Vultr row when the vultr.com sign-up code is filed under another Vultr listing", () => {
    const code = activeCodeFiledUnder("Vultr");
    assert.strictEqual(new URL(code.referral_url).hostname, "www.vultr.com");
    const tablesNamingVultr = GUIDE_TABLES_NAMING_A_CODE_HOLDER.filter(table => "Vultr" in table.linked);
    assert.ok(tablesNamingVultr.length > 0, "some guide table should name Vultr");
    for (const table of tablesNamingVultr) {
      assertRowCarriesCode(rowOf(servedWithVultrFiledUnderItsDnsListing.get(table.route)!, table, "Vultr"), code);
    }
  });

  it("links no other row of those tables", () => {
    for (const table of GUIDE_TABLES_NAMING_A_CODE_HOLDER) {
      for (const row of tableRowsOf(served.get(table.route)!, table)) {
        if (Object.keys(table.linked).includes(vendorNamedBy(row))) continue;
        assert.ok(!row.includes("row-referral"), `${table.route}: ${vendorNamedBy(row)} should carry no referral link`);
      }
    }
  });

  it("drops the links when Railway's code is removed and Vultr's are inactive, and never prints an inactive code", () => {
    const inactiveUrls = STORE.platform_codes.filter((c: any) => !c.active).map((c: any) => asPageText(c.referral_url));
    for (const table of GUIDE_TABLES_NAMING_A_CODE_HOLDER) {
      const page = servedWithRailwayRemovedAndVultrInactive.get(table.route)!;
      for (const row of tableRowsOf(page, table)) {
        assert.ok(!row.includes("row-referral"), `${table.route}: ${vendorNamedBy(row)} should carry no link`);
        assert.ok(!row.includes('sponsored'), `${table.route}: ${vendorNamedBy(row)} should carry no sponsored link`);
      }
      for (const url of inactiveUrls) assert.ok(!served.get(table.route)!.includes(url), `${table.route} prints ${url}, which is inactive`);
    }
  });

  it("keeps each table's rows and their order with or without platform codes", () => {
    for (const table of GUIDE_TABLES_NAMING_A_CODE_HOLDER) {
      const vendors = tableRowsOf(served.get(table.route)!, table).map(vendorNamedBy);
      assert.ok(Object.keys(table.linked).every(vendor => vendors.includes(vendor)), `${table.route}'s table should name ${Object.keys(table.linked).join(" and ")}`);
      assert.deepStrictEqual(tableRowsOf(servedWithNoCodes.get(table.route)!, table).map(vendorNamedBy), vendors, table.route);
      assert.deepStrictEqual(tableRowsOf(servedWithRailwayRemovedAndVultrInactive.get(table.route)!, table).map(vendorNamedBy), vendors, table.route);
    }
  });

  it("leaves the sponsored blocks out of each page's table figure count", () => {
    for (const { route } of GUIDE_TABLES_NAMING_A_CODE_HOLDER) {
      const withCodes = served.get(route)!;
      const withoutCodes = servedWithNoCodes.get(route)!;
      assert.deepStrictEqual(censusTableFigures(withCodes, withCodes), censusTableFigures(withoutCodes, withoutCodes), route);
    }
  });

  it("separates each part of the block by whitespace, so a reader that drops the markup does not run them together", () => {
    const linkedRows = [
      ...GUIDE_TABLES_NAMING_A_CODE_HOLDER.flatMap(table =>
        Object.entries(table.linked).map(([vendor, filedUnder]) => ({ row: rowOf(served.get(table.route)!, table, vendor), code: activeCodeFiledUnder(filedUnder) }))),
    ];
    for (const { row, code } of linkedRows) {
      assert.ok(row.includes('class="row-referral"'), `${vendorNamedBy(row)}'s row should carry our referral link`);
      const text = withTheMarkupDropped(row);
      const parts = [
        `Sign up via our referral link and get ${asPageText(code.referee_benefit)}`,
        ...(code.restrictions.length > 0 ? [REFERRAL_CONDITIONS_HEADING, ...code.restrictions.map(asPageText)] : []),
        `Get ${asPageText(code.referee_benefit)} &rarr;`,
      ];
      for (const part of parts) assert.ok(text.includes(` ${part} `), `${vendorNamedBy(row)}: "${part}" should stand apart in: ${text}`);
    }
  });
});
