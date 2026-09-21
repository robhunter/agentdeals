import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertPopulationFloor, assertSharesPopulation, type Population } from "./population-floor.ts";

const {
  refusedReadClause,
  refusedReadRegister,
  refusedReadSentence,
  REFUSAL_REASONS_THAT_LEAVE_THE_READ_STANDING,
  REFUSAL_REASONS_THAT_MEASURED_NO_DIFFERENCE,
  REFUSAL_REASONS_THAT_VOID_THE_READS_STANDING,
  REFUSED_READ_REGISTERS,
  MEASURED_NO_DIFFERENCE_BADGE_LABEL,
  READ_HAD_NO_STANDING_BADGE_LABEL,
  UNRECONCILED_READ_BADGE_LABEL,
  WHAT_A_VOIDED_READ_FOUND,
} = await import("../dist/change-refusal.js");
const {
  refusedReadWeHold,
  refusedReadWithholding,
  refusedReadWithholdingClause,
  refusedReadWithholdingMetaClause,
  refusedReadWithholdingSentence,
  whyWeCannotConfirmTheseTerms,
  withheldBadgeLabel,
  withheldForARefusedRead,
  withholdsTheTerms,
} = await import("../dist/vendor-verdict.js");
const { offerVerdictInput } = await import("../dist/vendor-verdict-input.js");
const { changesByVendor, loadChangeRefusals, loadOffers } = await import("../dist/data.js");
const { refusalsByVendor } = await import("../dist/change-refusal.js");

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(__dirname, "..");

const UNRECONCILED_CLAUSE = "we found a change we could not reconcile with the terms we publish";
const UNRECONCILED_META = "found a change we could not reconcile";
const NAMED_NO_FIGURE = "it named no figure that had moved";

const REFUSED_ON = "2026-09-19";
const READ_AGAIN_ON = "2026-09-20";

const held = (reason: string, read_again_on: string | null = null) => ({
  reason,
  refused_date: REFUSED_ON,
  read_again_on,
});

const everyWayWeSayIt = (subject: string, refusal: ReturnType<typeof held>): string[] => {
  const withholding = refusedReadWithholding(refusal);
  return [
    refusedReadClause(refusal),
    refusedReadSentence(subject, refusal),
    refusedReadWithholdingClause(withholding),
    refusedReadWithholdingSentence(subject, withholding),
    refusedReadWithholdingMetaClause(withholding),
  ];
};

interface Record {
  vendor: string;
  slug: string;
  reason: string;
  register: string;
  publishesTheRefusal: boolean;
}

const slugOf = (vendor: string) =>
  vendor.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

const changeLog = changesByVendor();
const refusalLog = refusalsByVendor(loadChangeRefusals());
const servedOn = new Date().toISOString().slice(0, 10);

const withholdingRecords: Record[] = [];
for (const offer of loadOffers()) {
  const input = offerVerdictInput({
    vendor: offer.vendor,
    offer,
    vendorChanges: changeLog.get(offer.vendor.toLowerCase()) ?? [],
    refusedReads: refusalLog.get(offer.vendor.toLowerCase()) ?? [],
    servedOn,
  });
  if (!input) continue;
  const refusal = refusedReadWeHold(input);
  if (!refusal) continue;
  const unconfirmed = whyWeCannotConfirmTheseTerms(input);
  withholdingRecords.push({
    vendor: offer.vendor,
    slug: slugOf(offer.vendor),
    reason: refusal.reason,
    register: refusedReadRegister(refusal),
    publishesTheRefusal: unconfirmed !== null && withheldForARefusedRead(unconfirmed.because),
  });
}

const inRegister = (register: string): Record[] =>
  withholdingRecords.filter(record => record.register === register);

const speakingInRegister = (register: string): Record[] =>
  inRegister(register).filter(record => record.publishesTheRefusal);

const recordsHoldingAWithholdingRefusedRead = (): Population => ({
  size: withholdingRecords.length,
  read: "records whose rating a refused read withholds",
});

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

describe("the register a withholding refused read publishes in", () => {
  it("puts every reason a refusal can withhold under in exactly one register", () => {
    const registered = new Map<string, string[]>();
    for (const register of REFUSED_READ_REGISTERS) registered.set(register, []);
    for (const reason of [
      ...REFUSAL_REASONS_THAT_VOID_THE_READS_STANDING,
      ...REFUSAL_REASONS_THAT_MEASURED_NO_DIFFERENCE,
      ...REFUSAL_REASONS_THAT_LEAVE_THE_READ_STANDING,
    ]) {
      registered.get(refusedReadRegister({ reason }))!.push(reason);
    }
    assert.deepStrictEqual(
      [...registered.entries()].filter(([, reasons]) => reasons.length === 0).map(([register]) => register),
      [],
      "a register no reason reaches states a case the data cannot produce",
    );
    for (const reason of REFUSAL_REASONS_THAT_VOID_THE_READS_STANDING) {
      assert.strictEqual(refusedReadRegister({ reason }), "had_no_standing_to_contradict", reason);
    }
    for (const reason of REFUSAL_REASONS_THAT_MEASURED_NO_DIFFERENCE) {
      assert.strictEqual(refusedReadRegister({ reason }), "named_no_figure_that_moved", reason);
    }
    for (const reason of REFUSAL_REASONS_THAT_LEAVE_THE_READ_STANDING) {
      assert.strictEqual(refusedReadRegister({ reason }), "could_not_reconcile_the_change", reason);
    }
  });

  it("states what the read found, and no change it could not reconcile, for a refusal that voids it", () => {
    for (const reason of REFUSAL_REASONS_THAT_VOID_THE_READS_STANDING) {
      const found = WHAT_A_VOIDED_READ_FOUND[reason];
      for (const readAgain of [null, READ_AGAIN_ON]) {
        for (const wording of everyWayWeSayIt("Meilisearch", held(reason, readAgain))) {
          assert.ok(wording.includes(found), `${reason} publishes "${wording}" and not what the read found`);
          assert.ok(!wording.includes(UNRECONCILED_META), `${reason} publishes "${wording}"`);
          assert.ok(!wording.includes(NAMED_NO_FIGURE), `${reason} publishes "${wording}"`);
        }
      }
    }
  });

  it("reads the refusal the record holds, not the first reason in the register", () => {
    const rootRead = refusedReadClause(held("removal_read_from_root"));
    const noBaseline = refusedReadClause(held("no_baseline"));
    assert.notStrictEqual(rootRead, noBaseline);
    assert.ok(rootRead.includes(WHAT_A_VOIDED_READ_FOUND.removal_read_from_root));
    assert.ok(noBaseline.includes(WHAT_A_VOIDED_READ_FOUND.no_baseline));
  });

  it("leaves both the registers it did not move saying what they said before", () => {
    assert.strictEqual(
      refusedReadClause(held("unquantified_limit")),
      `when we last read the page we cite for this offer, on ${REFUSED_ON},`
      + " we found a change we could not reconcile with the terms we publish",
    );
    assert.strictEqual(
      refusedReadSentence("Meilisearch", held("unquantified_limit")),
      `When we last read the page we cite for Meilisearch, on ${REFUSED_ON},`
      + " we found a change we could not reconcile with the terms we publish for it.",
    );
    assert.strictEqual(
      refusedReadWithholdingMetaClause(refusedReadWithholding(held("unquantified_limit"))),
      `our last read, on ${REFUSED_ON}, found a change we could not reconcile`,
    );
    assert.strictEqual(
      refusedReadClause(held("measures_no_change")),
      `when we last read the page we cite for this offer, on ${REFUSED_ON},`
      + " we refused the change we considered recording because it named no figure that had moved,"
      + " and refusing a change is not a confirmation of the terms above",
    );
    assert.strictEqual(
      refusedReadWithholdingMetaClause(refusedReadWithholding(held("measures_no_change"))),
      `we refused the change we last considered recording, on ${REFUSED_ON}`,
    );
  });

  it("gives each register its own badge and withholds on all three", () => {
    const badges = new Map<string, string>();
    for (const reason of [
      ...REFUSAL_REASONS_THAT_VOID_THE_READS_STANDING,
      ...REFUSAL_REASONS_THAT_MEASURED_NO_DIFFERENCE,
      ...REFUSAL_REASONS_THAT_LEAVE_THE_READ_STANDING,
    ]) {
      const withholding = refusedReadWithholding(held(reason));
      assert.ok(withholdsTheTerms(withholding), `${reason} stopped withholding the terms`);
      badges.set(refusedReadRegister({ reason }), withheldBadgeLabel(withholding));
    }
    assert.deepStrictEqual(
      [...badges.entries()].sort(),
      [
        ["could_not_reconcile_the_change", UNRECONCILED_READ_BADGE_LABEL],
        ["had_no_standing_to_contradict", READ_HAD_NO_STANDING_BADGE_LABEL],
        ["named_no_figure_that_moved", MEASURED_NO_DIFFERENCE_BADGE_LABEL],
      ],
    );
    assert.strictEqual(new Set(badges.values()).size, 3, "two registers share a badge label");
  });
});

describe("the vendor pages of a read its own refusal voided", () => {
  before(async () => { proc = await startServer(); });
  after(() => { proc?.kill(); });

  it("holds a population on every register", () => {
    assertPopulationFloor(
      inRegister("had_no_standing_to_contradict").length,
      40,
      "records withhold on a refusal that voids the read's standing — 67 today over seven reasons,"
      + " so a floor of 40 leaves 27 records of slack for ordinary rotation churn",
    );
    assertPopulationFloor(
      inRegister("could_not_reconcile_the_change").length,
      60,
      "records withhold on a refusal that leaves the read standing — 102 today,"
      + " so a floor of 60 leaves 42 records of slack",
    );
    assertPopulationFloor(
      inRegister("named_no_figure_that_moved").length,
      12,
      "records withhold on a refusal that measured no difference — 26 today,"
      + " so a floor of 12 leaves 14 records of slack",
    );
    assertSharesPopulation(
      inRegister("had_no_standing_to_contradict").length,
      recordsHoldingAWithholdingRefusedRead(),
      0.2,
      "withholding refused reads their own refusal voided",
    );
    assert.strictEqual(
      withholdingRecords.length,
      REFUSED_READ_REGISTERS.reduce((total: number, register: string) => total + inRegister(register).length, 0),
      "a withholding refused read reaches no register",
    );
  });

  it("publishes no unreconciled change over a refusal that established none", async () => {
    const wrong: string[] = [];
    let read = 0;
    for (const record of inRegister("had_no_standing_to_contradict")) {
      const { status, body } = await get(`/vendor/${record.slug}`);
      if (status !== 200) continue;
      read++;
      if (body.includes(UNRECONCILED_CLAUSE)) wrong.push(`/vendor/${record.slug} (${record.reason}) states a change it could not reconcile`);
      if (body.includes(UNRECONCILED_META)) wrong.push(`/vendor/${record.slug} (${record.reason}) states a change it could not reconcile in its meta description`);
      if (body.includes(UNRECONCILED_READ_BADGE_LABEL)) wrong.push(`/vendor/${record.slug} (${record.reason}) badges the read as a change not reconciled`);
    }
    assertPopulationFloor(
      read,
      40,
      "vendor pages answer for a record whose withholding refusal voided the read — 67 today,"
      + " so a floor of 40 leaves 27 pages of slack",
    );
    assert.deepStrictEqual(wrong.slice(0, 20), [], wrong.slice(0, 20).join("\n"));
  });

  it("states what its own refusal found in place of the change", async () => {
    const silent: string[] = [];
    let stating = 0;
    for (const record of speakingInRegister("had_no_standing_to_contradict")) {
      const { status, body } = await get(`/vendor/${record.slug}`);
      if (status !== 200) continue;
      if (!body.includes(`we ${WHAT_A_VOIDED_READ_FOUND[record.reason]}`)) {
        silent.push(`/vendor/${record.slug} (${record.reason}) states neither the change nor what the read found`);
        continue;
      }
      stating++;
    }
    assertPopulationFloor(
      stating,
      35,
      "vendor pages state what a read their own refusal voided found — 52 today,"
      + " so a floor of 35 leaves 17 pages of slack",
    );
    assert.deepStrictEqual(silent.slice(0, 20), [], silent.slice(0, 20).join("\n"));
  });

  it("leaves the pages of the other two registers saying what they said before", async () => {
    const quiet: string[] = [];
    let stating = 0;
    for (const record of speakingInRegister("could_not_reconcile_the_change")) {
      const { status, body } = await get(`/vendor/${record.slug}`);
      if (status !== 200) continue;
      if (!body.includes(UNRECONCILED_CLAUSE)) {
        quiet.push(`/vendor/${record.slug} (${record.reason}) no longer states the change it could not reconcile`);
        continue;
      }
      stating++;
    }
    assertPopulationFloor(
      stating,
      36,
      "vendor pages still state a change they could not reconcile — 54 today,"
      + " so a floor of 36 leaves 18 pages of slack",
    );
    assert.deepStrictEqual(quiet.slice(0, 20), [], quiet.slice(0, 20).join("\n"));
  });
});
