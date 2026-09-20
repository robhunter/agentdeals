import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertPopulationFloor } from "./population-floor.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(__dirname, "..");

const {
  NO_CONFIRMATION_HELD,
  READ_CONTRADICTS_LABEL,
  WHAT_THE_LAST_READ_FOUND,
  confirmationSettles,
  contradictedTermsSentence,
  contradictingRead,
  readThatContradictsOurTerms,
  restatementSettles,
  somethingLaterSettledTheRead,
} = await import("../dist/read-date.js");
const { NOTHING_CONTRADICTS_OUR_TERMS_FOR } = await import("../dist/data.js");
const { offerEnded } = await import("../dist/retirement.js");
const { SUPERSEDED_TERMS_LABEL } = await import("../dist/superseded-description.js");
const { REFUSAL_REASONS_THAT_CONFIRM_THE_STORED_TERMS, REFUSAL_REASONS_THAT_MEASURED_NO_DIFFERENCE } =
  await import("../dist/change-refusal.js");

const FOUND_A_DIFFERENCE = WHAT_THE_LAST_READ_FOUND.changed;

interface CatalogueOffer {
  vendor: string;
  category: string;
  url: string;
  tier: string;
  verifiedDate: string;
}

const offers: CatalogueOffer[] = JSON.parse(readFileSync(path.join(REPO, "data", "index.json"), "utf-8")).offers;

const slugOf = (vendor: string) => vendor.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

const heldState: Array<{ vendor: string; url: string; last_outcome: string | null; last_success: string | null }> =
  JSON.parse(readFileSync(path.join(REPO, "data", "verification_state.json"), "utf-8")).records;
const outcomeOf = new Map(heldState.map((r) => [`${r.vendor}|${r.url}`, r.last_outcome]));

const readingOn = (date: string, outcome = "changed") => ({
  date,
  outcome,
  confirmed: outcome === "confirmed",
  settles: true,
  read_the_page: true,
  found: WHAT_THE_LAST_READ_FOUND[outcome] ?? null,
  consecutive_failures: 0,
  last_success: null,
  last_error: null,
});

const nothingCameAfter = { refusals: [], restatedFrom: null, confirmedOn: null };

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

const metaDescriptionOf = (body: string): string =>
  body.match(/<meta name="description" content="([^"]*)"/)?.[1] ?? "";

const NAMED_AS_UNCONTRADICTED = new RegExp(`${NOTHING_CONTRADICTS_OUR_TERMS_FOR} ([^.]*)\\.`);

const namedAsUncontradicted = (body: string): string[] => {
  const m = metaDescriptionOf(body).match(NAMED_AS_UNCONTRADICTED);
  if (!m) return [];
  return m[1].replace(/ and more$/, "").split(", ").map((v) => v.trim()).filter(Boolean);
};

const rowFor = (body: string, vendor: string): string | null =>
  body.split("<tr").find((row) => row.includes(`/vendor/${slugOf(vendor)}"`)) ?? null;

const categorySlugs = [...new Set(offers.map((o) => o.category))].map(slugOf);

const endedSlugs = new Set(offers.filter((o) => offerEnded(o)).map((o) => slugOf(o.vendor)));

const REASON_CLASSES = [
  "listing-read-contradicts",
  "listing-terms-unconfirmed",
  "listing-link-unreachable",
];

describe("a read our own store says contradicted the terms", () => {
  it("is a contradiction until something later settles it", () => {
    const read = readingOn("2026-09-16");
    assert.deepStrictEqual(contradictingRead(read, nothingCameAfter), read);
    assert.strictEqual(somethingLaterSettledTheRead(read, nothingCameAfter), false);
  });

  it("is not a contradiction when the read confirmed, or read no price at all", () => {
    for (const outcome of ["confirmed", "states_no_price", "link_ok", "fetch_failed"]) {
      assert.strictEqual(
        contradictingRead(readingOn("2026-09-16", outcome), nothingCameAfter),
        null,
        `a ${outcome} read was taken for a contradiction`,
      );
    }
  });

  it("is settled by terms restated from that same read, and not by an earlier restatement", () => {
    const read = readingOn("2026-09-16");
    assert.strictEqual(restatementSettles(read, "2026-09-16"), true);
    assert.strictEqual(restatementSettles(read, "2026-09-17"), true);
    assert.strictEqual(restatementSettles(read, "2026-09-15"), false);
    assert.strictEqual(restatementSettles(read, null), false);
    assert.strictEqual(contradictingRead(read, { ...nothingCameAfter, restatedFrom: "2026-09-16" }), null);
    assert.deepStrictEqual(contradictingRead(read, { ...nothingCameAfter, restatedFrom: "2026-09-15" }), read);
  });

  it("is settled by a confirmation after it, and not by one the same read disagreed with", () => {
    const read = readingOn("2026-09-16");
    assert.strictEqual(confirmationSettles(read, "2026-09-17"), true);
    assert.strictEqual(confirmationSettles(read, "2026-09-16"), false);
    assert.strictEqual(confirmationSettles(read, "2026-09-15"), false);
    assert.strictEqual(confirmationSettles(read, null), false);
    assert.strictEqual(contradictingRead(read, { ...nothingCameAfter, confirmedOn: "2026-09-17" }), null);
    assert.deepStrictEqual(contradictingRead(read, { ...nothingCameAfter, confirmedOn: "2026-09-16" }), read);
  });

  it("is settled by any refusal reason the register agrees settles a read", () => {
    const read = readingOn("2026-09-16");
    const settling = [
      ...REFUSAL_REASONS_THAT_CONFIRM_THE_STORED_TERMS,
      ...REFUSAL_REASONS_THAT_MEASURED_NO_DIFFERENCE,
    ];
    assert.ok(settling.length > 1, "the register of settling refusal reasons is too small to derive from");
    for (const reason of settling) {
      const refusals = [{ vendor: "Examplecorp", refused_date: "2026-09-16", reason }];
      assert.strictEqual(
        contradictingRead(read, { ...nothingCameAfter, refusals } as never),
        null,
        `a refusal reading ${reason} on the same day did not settle the read`,
      );
      const older = [{ ...refusals[0], refused_date: "2026-08-01" }];
      assert.deepStrictEqual(
        contradictingRead(read, { ...nothingCameAfter, refusals: older } as never),
        read,
        `a ${reason} refusal from another day was taken as settling this read`,
      );
    }
  });

  it("is not settled by a refusal that withheld for some other reason", () => {
    const read = readingOn("2026-09-16");
    const refusals = [{ vendor: "Examplecorp", refused_date: "2026-09-16", reason: "states_no_terms" }];
    assert.deepStrictEqual(contradictingRead(read, { ...nothingCameAfter, refusals } as never), read);
  });

  it("states the read date and what it found, and says we hold no confirmation", () => {
    const sentence = contradictedTermsSentence(readingOn("2026-09-16"));
    assert.match(sentence, /2026-09-16/);
    assert.ok(sentence.includes(FOUND_A_DIFFERENCE), `sentence does not say what the read found: ${sentence}`);
    assert.ok(
      sentence.toLowerCase().includes(NO_CONFIRMATION_HELD.toLowerCase()),
      `sentence does not say we hold no confirmation: ${sentence}`,
    );
  });
});

describe("the catalogue holds a population on both sides of the rule", () => {
  it("holds records whose last read contradicted the terms, and records it settled", () => {
    const changed = offers.filter((o) => outcomeOf.get(`${o.vendor}|${o.url}`) === "changed");
    assertPopulationFloor(changed.length, 200, "records whose last read found the page different");
    const standing = changed.filter((o) => readThatContradictsOurTerms(o) !== null);
    const settled = changed.filter((o) => readThatContradictsOurTerms(o) === null);
    assert.ok(standing.length > 0, "no record holds an unsettled contradicting read for the rule to act on");
    assert.ok(
      settled.length > 0,
      "every changed read is unsettled, so the settling branches are scored by nothing in the live data",
    );
  });

  it("never takes a read that confirmed for one that contradicted", () => {
    const confirmed = offers.filter((o) => outcomeOf.get(`${o.vendor}|${o.url}`) === "confirmed");
    assert.ok(confirmed.length > 0, "no confirmed read in the catalogue for this control to read");
    assert.deepStrictEqual(
      confirmed.filter((o) => readThatContradictsOurTerms(o) !== null).map((o) => o.vendor),
      [],
      "a read that confirmed our terms was published as contradicting them",
    );
  });
});

describe("the two surfaces that describe one read", () => {
  before(async () => { if (!proc) proc = await startServer(); });
  after(() => { proc?.kill(); proc = null; });

  it("names no vendor as uncontradicted whose own page says our read found a difference", async () => {
    const disagreements: string[] = [];
    let named = 0;
    const vendorPages = new Map<string, string>();
    for (const slug of categorySlugs) {
      const { status, body } = await get(`/category/${slug}`);
      if (status !== 200) continue;
      for (const vendor of namedAsUncontradicted(body)) {
        named++;
        const vendorSlug = slugOf(vendor);
        if (!vendorPages.has(vendorSlug)) {
          const page = await get(`/vendor/${vendorSlug}`);
          vendorPages.set(vendorSlug, page.status === 200 ? page.body : "");
        }
        if (vendorPages.get(vendorSlug)!.includes(FOUND_A_DIFFERENCE)) {
          disagreements.push(`/category/${slug} names ${vendor}`);
        }
      }
    }
    assertPopulationFloor(named, 60, "vendor slots named as uncontradicted");
    assert.deepStrictEqual(
      disagreements,
      [],
      `a category page calls a vendor uncontradicted while the vendor's own page states the difference: ${disagreements.join("; ")}`,
    );
  });

  it("gives every listed row whose read contradicted the terms a reason on the same page", async () => {
    let checked = 0;
    const silent: string[] = [];
    for (const slug of categorySlugs) {
      const { status, body } = await get(`/category/${slug}`);
      if (status !== 200) continue;
      for (const offer of offers.filter((o) => slugOf(o.category) === slug && !offerEnded(o))) {
        const reading = readThatContradictsOurTerms(offer);
        if (!reading) continue;
        const row = rowFor(body, offer.vendor);
        if (row === null) continue;
        checked++;
        const speaks = REASON_CLASSES.some((c) => row.includes(c))
          || row.includes("listing-eligibility-restricted")
          || row.includes(SUPERSEDED_TERMS_LABEL);
        if (!speaks) silent.push(`/category/${slug} ${offer.vendor}`);
      }
    }
    assertPopulationFloor(checked, 80, "listed rows holding a contradicting read");
    assert.deepStrictEqual(silent, [], `rows publish a read date and no reason: ${silent.join("; ")}`);
  });

  it("says the read date and what it found where it renders the notice", async () => {
    let spoken = 0;
    for (const slug of categorySlugs) {
      const { status, body } = await get(`/category/${slug}`);
      if (status !== 200) continue;
      for (const offer of offers.filter((o) => slugOf(o.category) === slug)) {
        const reading = readThatContradictsOurTerms(offer);
        const row = rowFor(body, offer.vendor);
        if (!reading || row === null || !row.includes("listing-read-contradicts")) continue;
        spoken++;
        assert.ok(
          row.includes(contradictedTermsSentence(reading)),
          `/category/${slug} flags ${offer.vendor} without stating the read of ${reading.date}`,
        );
      }
    }
    assertPopulationFloor(spoken, 40, "rows rendering the contradiction notice");
  });

  it("counts every row it flags, and gives no row two reasons", async () => {
    let pages = 0;
    let flagged = 0;
    let doubled = 0;
    const uncounted: string[] = [];
    const unspoken: string[] = [];
    for (const slug of categorySlugs) {
      const { status, body } = await get(`/category/${slug}`);
      if (status !== 200) continue;
      pages++;
      const stated = Number(body.match(/could not confirm today's terms for (\d+) of them/)?.[1] ?? 0);
      let contradicting = 0;
      let speaking = 0;
      for (const row of body.split("<tr").filter((r) => r.includes("/vendor/"))) {
        const vendorSlug = row.match(/\/vendor\/([a-z0-9-]+)"/)?.[1];
        if (!vendorSlug || endedSlugs.has(vendorSlug) || row.includes(SUPERSEDED_TERMS_LABEL)) continue;
        if (row.includes("listing-read-contradicts")) {
          contradicting++;
          if (row.includes("listing-terms-unconfirmed")) doubled++;
        }
        if (REASON_CLASSES.some((c) => row.includes(c))) speaking++;
      }
      flagged += contradicting;
      if (stated < contradicting) uncounted.push(`/category/${slug} flags ${contradicting} and counts ${stated}`);
      if (stated > speaking) unspoken.push(`/category/${slug} counts ${stated} and only ${speaking} say why`);
    }
    assertPopulationFloor(pages, 40, "category pages read for the count");
    assertPopulationFloor(flagged, 80, "rows flagged over a contradicting read");
    assert.deepStrictEqual(uncounted, [], `a page flags rows its own count leaves out: ${uncounted.join("; ")}`);
    assert.deepStrictEqual(unspoken, [], `a page counts rows that say nothing: ${unspoken.join("; ")}`);
    assert.strictEqual(doubled, 0, `${doubled} rows carry two reasons for the same terms`);
  });

  it("says nothing about a read against an offer that has ended", async () => {
    const ended = offers.filter((o) => offerEnded(o) && outcomeOf.get(`${o.vendor}|${o.url}`) === "changed");
    assert.ok(ended.length > 0, "no ended offer carries a contradicting read for this control to read");
    let seen = 0;
    for (const offer of ended) {
      const { status, body } = await get(`/category/${slugOf(offer.category)}`);
      if (status !== 200) continue;
      const row = rowFor(body, offer.vendor);
      if (row === null) continue;
      seen++;
      assert.ok(
        !row.includes("listing-read-contradicts"),
        `${offer.vendor} has no free tier and was flagged over terms it no longer publishes`,
      );
    }
    assert.ok(seen > 0, "no ended offer reached a category row for this control to read");
  });

  it("leaves a settled read named as uncontradicted", async () => {
    const settled = offers.filter((o) =>
      outcomeOf.get(`${o.vendor}|${o.url}`) === "changed" && readThatContradictsOurTerms(o) === null);
    assert.ok(settled.length > 0, "no settled contradicting read in the catalogue for this control");
    let seen = 0;
    for (const offer of settled) {
      const { status, body } = await get(`/category/${slugOf(offer.category)}`);
      if (status !== 200) continue;
      const row = rowFor(body, offer.vendor);
      if (row === null) continue;
      seen++;
      assert.ok(
        !row.includes("listing-read-contradicts"),
        `${offer.vendor} was flagged over a read something later settled`,
      );
    }
    assert.ok(seen > 0, "no settled record reached a category row for this control to read");
  });

  it("marks a ranked row whose read contradicted the terms", async () => {
    const { status, body } = await get("/sitemap-pages.xml");
    assert.strictEqual(status, 200);
    const pages = [...new Set((body.match(/\/best\/[a-z0-9-]+/g) ?? []))];
    assert.ok(pages.length > 0, "no best-of page to read");
    let marked = 0;
    for (const page of pages) {
      const served = await get(page);
      if (served.status !== 200) continue;
      marked += (served.body.match(/terms-read-contradicts/g) ?? []).length;
      for (const offer of offers) {
        const row = rowFor(served.body, offer.vendor);
        if (row === null || !row.includes("terms-read-contradicts")) continue;
        const reading = readThatContradictsOurTerms(offer);
        assert.ok(reading, `${page} marks ${offer.vendor} over a read nothing in our store contradicts`);
        assert.ok(
          row.includes(READ_CONTRADICTS_LABEL) && row.includes(reading!.date),
          `${page} marks ${offer.vendor} without the label and the read date`,
        );
      }
    }
    assert.ok(marked > 0, `none of the ${pages.length} ranked pages marks a contradicting read`);
  });
});
