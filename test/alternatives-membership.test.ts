import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Offer } from "../src/types.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(__dirname, "..");

const offers: Offer[] = JSON.parse(readFileSync(path.join(REPO, "data", "index.json"), "utf-8")).offers;

const SUBJECT = "Neon";
const GATED_ADDON = "Prisma Accelerate";
const GATED_LOCAL = "DynamoDB Local";

function slugOf(vendor: string): string {
  return vendor.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

let serverPort = 0;
let proc: ChildProcess | null = null;

function startServer(): Promise<ChildProcess> {
  return new Promise((resolve, reject) => {
    const child = spawn("node", [path.join(REPO, "dist", "serve.js")], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, PORT: "0", BASE_URL: "http://localhost" },
    });
    const timeout = setTimeout(() => { child.kill(); reject(new Error("Server startup timeout")); }, 20000);
    child.stderr!.on("data", (data: Buffer) => {
      const m = data.toString().match(/running on http:\/\/localhost:(\d+)/);
      if (m) { serverPort = parseInt(m[1], 10); clearTimeout(timeout); resolve(child); }
    });
    child.on("error", (err) => { clearTimeout(timeout); reject(err); });
  });
}

const get = async (p: string) => {
  const res = await fetch(`http://localhost:${serverPort}${p}`);
  return { status: res.status, body: await res.text() };
};

function faqAnswers(body: string): string[] {
  const blocks = body.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g) ?? [];
  const answers: string[] = [];
  for (const block of blocks) {
    const json = block.replace(/^<script type="application\/ld\+json">/, "").replace(/<\/script>$/, "");
    let parsed: unknown;
    try { parsed = JSON.parse(json); } catch { continue; }
    const entries = Array.isArray(parsed) ? parsed : [parsed];
    for (const entry of entries) {
      const page = entry as { "@type"?: string; mainEntity?: Array<{ acceptedAnswer?: { text?: string } }> };
      if (page["@type"] !== "FAQPage" || !Array.isArray(page.mainEntity)) continue;
      for (const q of page.mainEntity) {
        if (q.acceptedAnswer?.text) answers.push(q.acceptedAnswer.text);
      }
    }
  }
  return answers;
}

function sectionAfter(body: string, heading: string): string {
  const at = body.indexOf(heading);
  assert.notEqual(at, -1, `the page must contain a "${heading}" section for this test to mean anything`);
  const rest = body.slice(at);
  const end = rest.indexOf("alt-excluded");
  return end === -1 ? rest.slice(0, 6000) : rest.slice(0, end);
}

before(async () => {
  for (const vendor of [SUBJECT, GATED_ADDON, GATED_LOCAL]) {
    assert.ok(offers.some((o) => o.vendor === vendor), `${vendor} must be in the catalogue for this test to mean anything`);
  }
  const addon = offers.find((o) => o.vendor === GATED_ADDON)!;
  const local = offers.find((o) => o.vendor === GATED_LOCAL)!;
  assert.equal(addon.product_role?.is_addon, true, `${GATED_ADDON} must be classified as an add-on for this test to mean anything`);
  assert.equal(local.product_role?.deployment_model, "local_dev_only", `${GATED_LOCAL} must be classified as local-only for this test to mean anything`);
  proc = await startServer();
});

after(() => { if (proc) proc.kill(); });

describe("#1032 the vendor page the issue was filed about", () => {
  it("renders, so the assertions below are about a real page", async () => {
    const res = await get(`/vendor/${slugOf(SUBJECT)}`);
    assert.equal(res.status, 200, `/vendor/${slugOf(SUBJECT)} must exist for this test to mean anything`);
    assert.match(res.body, new RegExp(`<h1>[^<]*${SUBJECT}`, "i"));
  });

  it("still offers alternatives, so the gates did not empty the list", async () => {
    const { body } = await get(`/vendor/${slugOf(SUBJECT)}`);
    const grid = sectionAfter(body, "Alternatives in");
    const cards = grid.match(/class="alt-name"/g) ?? [];
    assert.ok(cards.length >= 5, `the alternatives grid must still carry a useful list, found ${cards.length}`);
  });

  it("does not list a connection pool or a downloadable emulator among them", async () => {
    const { body } = await get(`/vendor/${slugOf(SUBJECT)}`);
    const grid = sectionAfter(body, "Alternatives in");
    assert.ok(!grid.includes(GATED_ADDON), `${GATED_ADDON} is a thing you put in front of ${SUBJECT}, not a replacement for it`);
    assert.ok(!grid.includes(GATED_LOCAL), `${GATED_LOCAL} cannot serve a production workload and is not a replacement for ${SUBJECT}`);
  });

  it("says which offers were left out and why, rather than removing them silently", async () => {
    const { body } = await get(`/vendor/${slugOf(SUBJECT)}`);
    const notice = body.match(/<p class="alt-excluded"[\s\S]*?<\/p>/);
    assert.ok(notice, "an offer removed from an alternatives list must be named on the page it was removed from");
    assert.ok(notice[0].includes(GATED_ADDON), `${GATED_ADDON} must be named in the notice`);
    assert.ok(notice[0].includes(GATED_LOCAL), `${GATED_LOCAL} must be named in the notice`);
    assert.match(notice[0], /How we decide this/, "the notice must link to the published rule");
  });

  it("changes the machine-readable answer, not only the rendered list", async () => {
    const { body } = await get(`/vendor/${slugOf(SUBJECT)}`);
    const answers = faqAnswers(body);
    assert.ok(answers.length > 0, "the vendor page must publish FAQ structured data for this test to mean anything");
    const alternativesAnswer = answers.find((a) => a.includes("free alternatives to"));
    assert.ok(alternativesAnswer, "the FAQ must answer what the free alternatives are");
    assert.ok(!alternativesAnswer.includes(GATED_ADDON), `${GATED_ADDON} must not be quoted as a top free alternative`);
    assert.ok(!alternativesAnswer.includes(GATED_LOCAL), `${GATED_LOCAL} must not be quoted as a top free alternative`);
    for (const answer of answers) {
      assert.ok(!answer.includes(GATED_LOCAL), `no structured answer may present ${GATED_LOCAL} as a ${SUBJECT} option`);
    }
  });
});

describe("#1032 a gated vendor's own page shows the classification and its source", () => {
  it("publishes the property, the URL it was read from and the sentence", async () => {
    const { status, body } = await get(`/vendor/${slugOf(GATED_ADDON)}`);
    assert.equal(status, 200, `/vendor/${slugOf(GATED_ADDON)} must exist for this test to mean anything`);
    const line = body.match(/<p class="product-role-line"[\s\S]*?<\/p>/);
    assert.ok(line, "a gated vendor must be able to see how we classified it");
    const role = offers.find((o) => o.vendor === GATED_ADDON)!.product_role!;
    assert.ok(line[0].includes(role.source_url), "the classification must cite the page it was read from");
    assert.ok(line[0].includes(role.source_quote.slice(0, 40)), "the classification must quote the sentence it was read from");
    assert.ok(line[0].includes(role.reviewed), "the classification must carry the date it was read");
  });

  it("says the offer is still listed in its category", async () => {
    const { body } = await get(`/vendor/${slugOf(GATED_LOCAL)}`);
    const line = body.match(/<p class="product-role-line"[\s\S]*?<\/p>/);
    assert.ok(line, `${GATED_LOCAL} must publish its classification`);
    const category = offers.find((o) => o.vendor === GATED_LOCAL)!.category;
    assert.ok(line[0].includes(category), "the page must say where the offer is still listed");
  });

  it("publishes nothing for an offer we have not reviewed", async () => {
    const unreviewed = offers.find((o) => !o.product_role && o.category === "Databases")!;
    assert.ok(unreviewed, "the catalogue must contain an unreviewed record for this test to mean anything");
    const { body } = await get(`/vendor/${slugOf(unreviewed.vendor)}`);
    assert.ok(!body.includes("product-role-line"), "an unreviewed offer must not carry a classification line");
  });
});

describe("#1032 inventory surfaces are not filtered", () => {
  it("keeps gated offers on their category page", async () => {
    const category = offers.find((o) => o.vendor === GATED_ADDON)!.category;
    const { status, body } = await get(`/category/${slugOf(category)}`);
    assert.equal(status, 200, `/category/${slugOf(category)} must exist for this test to mean anything`);
    assert.ok(body.includes(GATED_ADDON), `${GATED_ADDON} must still be listed in ${category}`);
    assert.ok(body.includes(GATED_LOCAL), `${GATED_LOCAL} must still be listed in ${category}`);
  });

  it("keeps gated offers in the JSON catalogue, with the classification attached", async () => {
    const { status, body } = await get(`/api/offers?category=Databases&limit=200`);
    assert.equal(status, 200);
    const parsed = JSON.parse(body) as { offers: Offer[] };
    const addon = parsed.offers.find((o) => o.vendor === GATED_ADDON);
    assert.ok(addon, `${GATED_ADDON} must still be returned by the catalogue API`);
    assert.equal(addon.product_role?.is_addon, true, "the API record must publish the classification");
    assert.ok(parsed.offers.some((o) => o.vendor === GATED_LOCAL), `${GATED_LOCAL} must still be returned by the catalogue API`);
  });

  it("keeps gated offers findable by search", async () => {
    const { status, body } = await get(`/api/offers?q=${encodeURIComponent(GATED_LOCAL)}`);
    assert.equal(status, 200);
    const parsed = JSON.parse(body) as { offers: Offer[] };
    assert.ok(parsed.offers.some((o) => o.vendor === GATED_LOCAL), `a caller who searches for ${GATED_LOCAL} must find it`);
  });
});

describe("#1032 every page in an affected category, not only the one in the issue", () => {
  const gatedByCategory = new Map<string, Offer[]>();
  for (const o of offers) {
    if (!o.product_role) continue;
    if (o.product_role.deployment_model !== "local_dev_only" && !o.product_role.is_addon) continue;
    gatedByCategory.set(o.category, [...(gatedByCategory.get(o.category) ?? []), o]);
  }

  it("has categories to sweep, so the assertions below have subjects", () => {
    assert.ok(gatedByCategory.size > 0, "no category carries a gated record, so the sweep below checks nothing");
  });

  for (const [category, gatedHere] of gatedByCategory) {
    it(`shows no gated offer in any ${category} alternatives grid`, async () => {
      const subjects = offers.filter((o) => o.category === category && !gatedHere.some((g) => g.vendor === o.vendor));
      assert.ok(subjects.length > 5, `${category} needs enough vendor pages to sweep, found ${subjects.length}`);
      let gridsChecked = 0;
      const offenders: string[] = [];
      for (const subject of subjects) {
        const { status, body } = await get(`/vendor/${slugOf(subject.vendor)}`);
        if (status !== 200) continue;
        const at = body.indexOf("Alternatives in");
        if (at === -1) continue;
        const grid = body.slice(at, body.indexOf("alt-excluded", at) === -1 ? at + 6000 : body.indexOf("alt-excluded", at));
        gridsChecked += 1;
        for (const gated of gatedHere) {
          if (grid.includes(gated.vendor)) offenders.push(`${gated.vendor} on /vendor/${slugOf(subject.vendor)}`);
        }
      }
      assert.ok(gridsChecked > 5, `the sweep must actually read grids, read ${gridsChecked}`);
      assert.deepStrictEqual(offenders, [], `these offers cannot replace the vendor whose page lists them: ${offenders.join("; ")}`);
    });

    it(`names the gated ${category} offers on every page they were removed from`, async () => {
      const subject = offers.find((o) => o.category === category && !gatedHere.some((g) => g.vendor === o.vendor))!;
      const { body } = await get(`/vendor/${slugOf(subject.vendor)}`);
      const notice = body.match(/<p class="alt-excluded"[\s\S]*?<\/p>/);
      assert.ok(notice, `/vendor/${slugOf(subject.vendor)} removed offers without naming them`);
      for (const gated of gatedHere) {
        assert.ok(notice[0].includes(gated.vendor), `${gated.vendor} must be named on /vendor/${slugOf(subject.vendor)}`);
      }
    });
  }
});

describe("#1032 the other recommendation surfaces", () => {
  it("leaves gated offers out of the alternatives page", async () => {
    const { status, body } = await get(`/alternative-to/${slugOf(SUBJECT)}`);
    assert.equal(status, 200, `/alternative-to/${slugOf(SUBJECT)} must exist for this test to mean anything`);
    const headingAt = body.indexOf("All Free Alternatives");
    assert.notEqual(headingAt, -1, "the full alternatives section must render for this test to mean anything");
    const listStart = body.indexOf('<div class="alt-list">', headingAt);
    assert.notEqual(listStart, -1, "the alternatives list must render for this test to mean anything");
    const list = body.slice(listStart, body.indexOf("</div>\n  </div>", listStart));
    const rows = list.match(/class="alt-vendor-name"/g) ?? [];
    assert.ok(rows.length >= 5, `the alternatives list must carry entries for this test to mean anything, found ${rows.length}`);
    assert.ok(!list.includes(GATED_ADDON), `${GATED_ADDON} must not appear in the alternatives list`);
    assert.ok(!list.includes(GATED_LOCAL), `${GATED_LOCAL} must not appear in the alternatives list`);
  });

  it("leaves gated offers out of a role recommendation and says so", async () => {
    const { status, body } = await get(`/api/stack?use_case=${encodeURIComponent("postgres api backend")}`);
    assert.equal(status, 200);
    const parsed = JSON.parse(body) as { stack: Array<{ role: string; category: string; candidates: Array<{ vendor: string }>; reason: string }> };
    const database = parsed.stack.find((r) => r.category === "Databases");
    assert.ok(database, "the stack must contain a database role for this test to mean anything");
    assert.ok(database.candidates.length > 0, "the database role must still return candidates");
    const vendors = database.candidates.map((c) => c.vendor);
    assert.ok(!vendors.includes(GATED_ADDON), `${GATED_ADDON} cannot fill a database role`);
    assert.ok(!vendors.includes(GATED_LOCAL), `${GATED_LOCAL} cannot fill a database role`);
    assert.ok(database.reason.includes(GATED_ADDON), "the role must say which offers it left out");
  });

  it("leaves gated offers out of the vendor risk tool's alternatives, on every page in the category", async () => {
    const category = offers.find((o) => o.vendor === GATED_ADDON)!.category;
    const subjects = offers.filter((o) => o.category === category && o.vendor !== GATED_ADDON && o.vendor !== GATED_LOCAL);
    let answered = 0;
    const offenders: string[] = [];
    for (const subject of subjects) {
      const { status, body } = await get(`/api/vendor-risk/${encodeURIComponent(subject.vendor)}`);
      if (status !== 200) continue;
      const parsed = JSON.parse(body) as { alternatives?: Array<{ vendor: string }> };
      if (!parsed.alternatives?.length) continue;
      answered += 1;
      for (const gated of [GATED_ADDON, GATED_LOCAL]) {
        if (parsed.alternatives.some((a) => a.vendor === gated)) offenders.push(`${gated} offered as an alternative to ${subject.vendor}`);
      }
    }
    assert.ok(answered > 10, `the sweep must actually read risk results, read ${answered}`);
    assert.deepStrictEqual(offenders, [], `these products cannot replace the vendor they are offered against: ${offenders.join("; ")}`);
  });

  it("leaves gated offers out of the vendor detail tool's related vendors", async () => {
    const category = offers.find((o) => o.vendor === GATED_ADDON)!.category;
    const subjects = offers.filter((o) => o.category === category && o.vendor !== GATED_ADDON && o.vendor !== GATED_LOCAL);
    let answered = 0;
    const offenders: string[] = [];
    for (const subject of subjects) {
      const { status, body } = await get(`/api/details/${encodeURIComponent(subject.vendor)}?alternatives=true`);
      if (status !== 200) continue;
      const parsed = JSON.parse(body) as { offer?: { relatedVendors?: string[]; alternatives?: Array<{ vendor: string }> } };
      const related = parsed.offer?.relatedVendors;
      if (!related?.length) continue;
      answered += 1;
      for (const gated of [GATED_ADDON, GATED_LOCAL]) {
        if (related.includes(gated)) offenders.push(`${gated} related to ${subject.vendor}`);
        if (parsed.offer?.alternatives?.some((a) => a.vendor === gated)) offenders.push(`${gated} listed as an alternative to ${subject.vendor}`);
      }
    }
    assert.ok(answered > 10, `the sweep must actually read detail results, read ${answered}`);
    assert.deepStrictEqual(offenders, [], `these products cannot replace the vendor they are returned against: ${offenders.join("; ")}`);
  });
});

describe("#1032 a classification must not contradict what we already publish", () => {
  const curated = new Set<string>();
  const changes = JSON.parse(readFileSync(path.join(REPO, "data", "deal_changes.json"), "utf-8")).changes as Array<{ alternatives?: string[] }>;
  for (const c of changes) {
    for (const a of c.alternatives ?? []) curated.add(a);
  }

  it("reads the curated alternatives, so the assertion below has a subject", () => {
    assert.ok(curated.size > 50, `the change records must name alternatives for this test to mean anything, found ${curated.size}`);
  });

  it("never gates a vendor our own change records recommend as an alternative", () => {
    const conflicts = offers
      .filter((o) => o.product_role && (o.product_role.deployment_model === "local_dev_only" || o.product_role.is_addon))
      .filter((o) => curated.has(o.vendor))
      .map((o) => o.vendor);
    assert.deepStrictEqual(
      conflicts,
      [],
      `we recommend these as alternatives in our own dated records and cannot also hold that they replace nothing: ${conflicts.join(", ")}`
    );
  });
});

describe("#1032 the rule is published", () => {
  it("explains both properties on the criteria page", async () => {
    const { status, body } = await get("/criteria");
    assert.equal(status, 200);
    assert.ok(body.includes('id="membership"'), "the criteria page must carry the anchor the vendor pages link to");
    assert.ok(body.includes("local_dev_only"), "the criteria page must name the deployment property");
    assert.ok(body.includes("addon"), "the criteria page must name the add-on property");
    assert.match(body, /Neither property is available on request/, "the criteria page must say the classification cannot be requested");
    assert.match(body, /has not been reviewed/, "the criteria page must say what an unclassified record means");
  });
});
