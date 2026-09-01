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

type GateName = "local_dev_only" | "addon";

function gatesOf(vendor: string): Set<GateName> {
  const gates = new Set<GateName>();
  const role = offers.find((o) => o.vendor === vendor)?.product_role;
  if (!role) return gates;
  if (role.deployment_model === "local_dev_only") gates.add("local_dev_only");
  if (role.is_addon) gates.add("addon");
  return gates;
}

function gateAppliesFor(gated: string, subject: string): boolean {
  const subjectGates = gatesOf(subject);
  return [...gatesOf(gated)].some((gate) => !subjectGates.has(gate));
}

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

  const bindsIn = (category: string) =>
    offers.some((o) => o.category === category && (o.product_subtypes?.labels.length ?? 0) > 0);

  it("has categories to sweep, so the assertions below have subjects", () => {
    assert.ok(gatedByCategory.size > 0, "no category carries a gated record, so the sweep below checks nothing");
    assert.ok(
      [...gatedByCategory.keys()].some(bindsIn),
      "no category with a gated record carries a taxonomy, so the grid sweep below asserts only absence",
    );
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
      if (!bindsIn(category)) {
        assert.strictEqual(gridsChecked, 0, `${category} carries no subtype taxonomy, so no page in it may offer a category grid`);
        return;
      }
      assert.ok(gridsChecked > 5, `the sweep must actually read grids, read ${gridsChecked}`);
      assert.deepStrictEqual(offenders, [], `these offers cannot replace the vendor whose page lists them: ${offenders.join("; ")}`);
    });

    it(`names the gated ${category} offers on every page they were removed from`, async () => {
      const subject = offers.find((o) => o.category === category && !gatedHere.some((g) => g.vendor === o.vendor))!;
      const { body } = await get(`/vendor/${slugOf(subject.vendor)}`);
      const notice = body.match(/<p class="alt-excluded"[\s\S]*?<\/p>/);
      if (!bindsIn(category)) {
        assert.strictEqual(notice, null, `${category} offers no category grid, so it has nothing to name a removal from`);
        return;
      }
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
    let gateChecks = 0;
    const offenders: string[] = [];
    for (const subject of subjects) {
      const { status, body } = await get(`/api/vendor-risk/${encodeURIComponent(subject.vendor)}`);
      if (status !== 200) continue;
      const parsed = JSON.parse(body) as { alternatives?: Array<{ vendor: string }> };
      if (!parsed.alternatives?.length) continue;
      answered += 1;
      for (const gated of [GATED_ADDON, GATED_LOCAL]) {
        if (!gateAppliesFor(gated, subject.vendor)) continue;
        gateChecks += 1;
        if (parsed.alternatives.some((a) => a.vendor === gated)) offenders.push(`${gated} offered as an alternative to ${subject.vendor}`);
      }
    }
    assert.ok(answered > 10, `the sweep must actually read risk results, read ${answered}`);
    assert.ok(gateChecks > 10, `the sweep must actually apply the gate, applied it ${gateChecks} times`);
    assert.deepStrictEqual(offenders, [], `these products cannot replace the vendor they are offered against: ${offenders.join("; ")}`);
  });

  it("leaves gated offers out of the vendor detail tool's related vendors", async () => {
    const category = offers.find((o) => o.vendor === GATED_ADDON)!.category;
    const subjects = offers.filter((o) => o.category === category && o.vendor !== GATED_ADDON && o.vendor !== GATED_LOCAL);
    let answered = 0;
    let gateChecks = 0;
    const offenders: string[] = [];
    for (const subject of subjects) {
      const { status, body } = await get(`/api/details/${encodeURIComponent(subject.vendor)}?alternatives=true`);
      if (status !== 200) continue;
      const parsed = JSON.parse(body) as { offer?: { relatedVendors?: string[]; alternatives?: Array<{ vendor: string }> } };
      const related = parsed.offer?.relatedVendors;
      if (!related?.length) continue;
      answered += 1;
      for (const gated of [GATED_ADDON, GATED_LOCAL]) {
        if (!gateAppliesFor(gated, subject.vendor)) continue;
        gateChecks += 1;
        if (related.includes(gated)) offenders.push(`${gated} related to ${subject.vendor}`);
        if (parsed.offer?.alternatives?.some((a) => a.vendor === gated)) offenders.push(`${gated} listed as an alternative to ${subject.vendor}`);
      }
    }
    assert.ok(answered > 10, `the sweep must actually read detail results, read ${answered}`);
    assert.ok(gateChecks > 10, `the sweep must actually apply the gate, applied it ${gateChecks} times`);
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

  it("never lets a subtype remove a pair a person wrote into a change record", async () => {
    const { curatedAlternativesFor } = await import("../dist/curated-alternatives.js");
    const allChanges = JSON.parse(readFileSync(path.join(REPO, "data", "deal_changes.json"), "utf-8")).changes;
    const dropped: string[] = [];
    let pairs = 0;
    for (const vendor of new Set(offers.map((o) => o.vendor))) {
      const result = curatedAlternativesFor(vendor, allChanges, offers, offers.filter((o) => o.vendor === vendor));
      pairs += result.kept.length + result.removed.length;
      for (const r of result.removed) {
        if (r.gate === "subtype_mismatch" || r.gate === "not_in_taxonomy") dropped.push(`${vendor} -> ${r.offer.vendor}`);
      }
    }
    assert.ok(pairs > 100, `the change records must resolve to pairs for this test to mean anything, found ${pairs}`);
    assert.deepStrictEqual(dropped, [], `a curated pair is a stronger claim than a taxonomy match: ${dropped.join(", ")}`);
  });

  it("keeps a curated name whose subtype differs from the subject's on both published surfaces", async () => {
    const subject = "PythonAnywhere";
    const crossing = ["Render", "Railway"];
    const { partitionAlternatives } = await import("../dist/product-role.js");
    const subjectOffer = offers.find((o) => o.vendor === subject)!;
    for (const name of crossing) {
      const candidate = offers.find((o) => o.vendor === name)!;
      assert.equal(
        partitionAlternatives([candidate], subjectOffer).removed[0]?.gate,
        "subtype_mismatch",
        `${name} must be subtype-gated against ${subject} for this test to mean anything`
      );
    }
    const cardName: Record<string, string> = {
      "/vendor/pythonanywhere": "alt-name",
      "/alternative-to/pythonanywhere": "alt-vendor-name",
    };
    for (const [url, cls] of Object.entries(cardName)) {
      const { body } = await get(url);
      const listed = [...body.matchAll(new RegExp(`class="${cls}">([^<]+)<`, "g"))].map(m => m[1]);
      assert.ok(listed.length > 3, `${url} rendered no alternatives cards, so this test proves nothing`);
      for (const name of crossing) {
        assert.ok(listed.includes(name), `${url} drops the curated name ${name} from its cards`);
      }
    }
  });
});

describe("#1195 how a product is deployed does not decide what can replace it", () => {
  const GROUPED = ["static_site", "serverless_function", "container_app"];
  const labelsOf = (vendor: string) => (offers.find((o) => o.vendor === vendor)?.product_subtypes?.labels ?? []).map((l) => l.subtype);

  const subject = "Vercel";
  const hosting = offers.filter((o) => o.category === "Cloud Hosting");

  it("classifies the subject as a grouped subtype only, so the assertions below have a boundary to cross", () => {
    const own = labelsOf(subject);
    assert.ok(own.length > 0, `${subject} must carry subtypes for this test to mean anything`);
    assert.ok(own.every((s) => GROUPED.includes(s)), `${subject} must carry only grouped subtypes, carries ${own.join(", ")}`);
    assert.ok(!own.includes("container_app"), `${subject} must not itself be a container platform, or nothing below crosses a boundary`);
  });

  const NAMED_ON_THE_ISSUE = ["Northflank", "Clever Cloud", "Qoddi", "gigalixir.com", "leapcell"];

  it("lists the container platforms the issue names among the subject's published alternatives", async () => {
    const curated = new Set<string>();
    const changes = JSON.parse(readFileSync(path.join(REPO, "data", "deal_changes.json"), "utf-8")).changes as Array<{ vendor: string; alternatives?: string[] }>;
    for (const c of changes) {
      if (c.vendor.toLowerCase() !== subject.toLowerCase()) continue;
      for (const a of c.alternatives ?? []) curated.add(a);
    }
    for (const vendor of NAMED_ON_THE_ISSUE) {
      assert.deepStrictEqual(labelsOf(vendor), ["container_app"], `${vendor} must be a container platform for this test to mean anything`);
      assert.ok(!curated.has(vendor), `${vendor} is a curated name for ${subject} and is exempt already, so it proves nothing here`);
    }
    const { body } = await get(`/alternative-to/${slugOf(subject)}`);
    const listed = [...body.matchAll(/class="alt-vendor-name">([^<]+)</g)].map((m) => m[1]);
    assert.ok(listed.length > 10, `/alternative-to/${slugOf(subject)} rendered too few entries to check, found ${listed.length}`);
    const missing = NAMED_ON_THE_ISSUE.filter((v) => !listed.includes(v));
    assert.deepStrictEqual(missing, [], `a reader leaving ${subject} can deploy on these: ${missing.join(", ")}`);
  });

  const SURFACES = [`/vendor/${slugOf(subject)}`, `/alternative-to/${slugOf(subject)}`];

  async function exclusionNotice(url: string): Promise<string[]> {
    const { body } = await get(url);
    const notice = body.match(/<p class="alt-excluded"[\s\S]*?<\/p>/);
    assert.ok(notice, `${url} must publish the exclusion notice for this test to mean anything`);
    const named = [...notice[0].matchAll(/<a href="\/vendor\/[^"]+">([^<]+)<\/a>/g)].map((m) => m[1]);
    assert.ok(named.length > 3, `${url} must name exclusions for this test to mean anything, found ${named.length}`);
    assert.ok(notice[0].includes("shares no subtype with this product"), `${url} must publish the subtype reason unchanged`);
    return named;
  }

  it("names none of them in the notice that says who was left out", async () => {
    for (const url of SURFACES) {
      const named = await exclusionNotice(url);
      const wrongly = named.filter((v) => labelsOf(v).some((s) => GROUPED.includes(s)));
      assert.deepStrictEqual(
        wrongly,
        [],
        `${url} says these cannot replace ${subject}, and a reader leaving it can deploy on every one: ${wrongly.join(", ")}`
      );
    }
  });

  it("keeps every ungrouped subtype out, with the reason unchanged", async () => {
    const ungrouped = hosting
      .filter((o) => o.vendor !== subject)
      .filter((o) => {
        const own = labelsOf(o.vendor);
        return own.length > 0 && own.every((s) => !GROUPED.includes(s));
      })
      .map((o) => o.vendor);
    assert.ok(ungrouped.length > 10, `this test needs ungrouped records to check, found ${ungrouped.length}`);
    for (const url of SURFACES) {
      const named = await exclusionNotice(url);
      const missing = ungrouped.filter((v) => !named.includes(v));
      assert.deepStrictEqual(missing, [], `${url} must still leave these out and name them: ${missing.join(", ")}`);
    }
    const { body } = await get(`/alternative-to/${slugOf(subject)}`);
    const listed = [...body.matchAll(/class="alt-vendor-name">([^<]+)</g)].map((m) => m[1]);
    const admitted = ungrouped.filter((v) => listed.includes(v));
    assert.deepStrictEqual(admitted, [], `these share no subtype and no group with ${subject}: ${admitted.join(", ")}`);
  });

  it("publishes the group and which subtypes are in it on the criteria page", async () => {
    const { SUBTYPE_MEMBERSHIP_GROUPS } = await import("../dist/product-role.js");
    const { status, body } = await get("/criteria");
    assert.equal(status, 200);
    const declared = SUBTYPE_MEMBERSHIP_GROUPS as Record<string, Array<{ subtypes: string[]; rule: string }>>;
    const taxonomies = Object.keys(declared);
    assert.ok(taxonomies.length > 0, "a taxonomy must declare a membership group for this test to mean anything");
    for (const taxonomy of taxonomies) {
      for (const group of declared[taxonomy]) {
        assert.ok(body.includes(group.rule.replace(/&/g, "&amp;")), `the criteria page must state the rule ${taxonomy}'s group gates by`);
        for (const subtype of group.subtypes) {
          assert.ok(body.includes(`<code>${subtype}</code>`), `${subtype} is not named on the criteria page`);
        }
      }
    }
    assert.ok(body.includes("<th>Group</th>"), "the taxonomy table must mark which subtypes are in a group");
  });
});

describe("#1032 the rule is published", () => {
  it("explains every membership property on the criteria page", async () => {
    const { status, body } = await get("/criteria");
    assert.equal(status, 200);
    assert.ok(body.includes('id="membership"'), "the criteria page must carry the anchor the vendor pages link to");
    assert.ok(body.includes("local_dev_only"), "the criteria page must name the deployment property");
    assert.ok(body.includes("addon"), "the criteria page must name the add-on property");
    assert.match(body, /available on request/, "the criteria page must say the classification cannot be requested");
    assert.match(body, /has not been reviewed/, "the criteria page must say what an unclassified record means");
  });

  it("publishes every subtype it gates on, with the definition it gates by", async () => {
    const { SUBTYPE_TAXONOMIES } = await import("../dist/product-role.js");
    const { status, body } = await get("/criteria");
    assert.equal(status, 200);
    assert.ok(body.includes('id="subtypes"'), "the criteria page must carry the subtype anchor the vendor pages link to");
    for (const [taxonomy, entries] of Object.entries(SUBTYPE_TAXONOMIES) as [string, Array<{ subtype: string; definition: string }>][]) {
      assert.ok(body.includes(taxonomy), `${taxonomy} is not named on the criteria page`);
      for (const entry of entries) {
        assert.ok(body.includes(`<code>${entry.subtype}</code>`), `${entry.subtype} is not named on the criteria page`);
        assert.ok(body.includes(entry.definition.replace(/&/g, "&amp;")), `${entry.subtype} is named without the definition it gates by`);
      }
    }
  });

  it("states how far classification has got in every taxonomy it publishes", async () => {
    const { SUBTYPE_TAXONOMIES } = await import("../dist/product-role.js");
    const { body } = await get("/criteria");
    for (const taxonomy of Object.keys(SUBTYPE_TAXONOMIES as Record<string, unknown>)) {
      const inTaxonomy = offers.filter((o) => o.category === taxonomy);
      const labelled = inTaxonomy.filter((o) => o.product_subtypes).length;
      assert.ok(
        body.includes(`${labelled} of ${inTaxonomy.length} in ${taxonomy}`),
        `the criteria page must say how many of the ${inTaxonomy.length} ${taxonomy} records carry a subtype`
      );
    }
  });

  it("publishes the subtypes and their source on the vendor page that carries them", async () => {
    const { body } = await get("/vendor/neon");
    const line = body.match(/<p class="product-subtypes-line"[\s\S]*?<\/p>/);
    assert.ok(line, "the vendor page must publish its subtypes");
    const neon = offers.find((o) => o.vendor === "Neon")!;
    for (const label of neon.product_subtypes!.labels) {
      assert.ok(line[0].includes(`<code>${label.subtype}</code>`), `${label.subtype} is not published on /vendor/neon`);
      assert.ok(line[0].includes(label.source_url), `${label.subtype} is published without the URL it was read from`);
      assert.ok(line[0].includes(label.source_quote.slice(0, 40)), `${label.subtype} is published without the sentence it was read from`);
    }
    assert.ok(line[0].includes(neon.product_subtypes!.reviewed), "the vendor page must publish the date the subtypes were reviewed");
  });
});
