import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { GATE_REASONS } from "../scripts/change-gate.js";
import { SUPPRESSED_SAME_TRANSITION_REGRADED } from "../scripts/change-log.js";
import { assertPopulationFloor } from "./population-floor.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(__dirname, "..");

const {
  REFUSAL_REASONS_THAT_CONFIRM_THE_STORED_TERMS,
  REFUSAL_REASONS_THAT_LEAVE_THE_READ_STANDING,
  REFUSAL_REASONS_THAT_MEASURED_NO_DIFFERENCE,
  REFUSAL_REASONS_THAT_VOID_THE_READS_STANDING,
  howWeSettledTheRead,
  refusalSettledTheRead,
  refusalVoidsTheReadsStanding,
} = await import("../dist/change-refusal.js");
const {
  READ_VOIDED_BY_ITS_OWN_REFUSAL,
  WHAT_A_SETTLED_READ_FOUND,
  WHAT_A_VOIDED_READ_FOUND,
  WHAT_THE_LAST_READ_FOUND,
  readingSettledByRefusals,
  whatASettledReadFound,
  whatTheLastReadFound,
} = await import("../dist/read-date.js");

const FOUND_A_DIFFERENCE = WHAT_THE_LAST_READ_FOUND.changed;
const READ_NO_TERMS = WHAT_THE_LAST_READ_FOUND.states_no_price;
const READ = "2026-09-11";

const refused = (reason: string, refused_date = READ) => ({ reason, refused_date });

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

interface CatalogueOffer {
  vendor: string;
  url: string;
  restated_from?: { reading_date: string } | null;
}

interface StoredRefusal {
  vendor: string;
  reason: string;
  refused_date: string;
}

const offers: CatalogueOffer[] =
  JSON.parse(readFileSync(path.join(REPO, "data", "index.json"), "utf-8")).offers;

const heldState: Array<{
  vendor: string;
  url: string;
  last_attempt_at: string | null;
  last_outcome: string | null;
  last_success: string | null;
}> = JSON.parse(readFileSync(path.join(REPO, "data", "verification_state.json"), "utf-8")).records;

const storedRefusals: StoredRefusal[] =
  JSON.parse(readFileSync(path.join(REPO, "data", "change_refusals.json"), "utf-8")).refusals;

const stateOf = new Map(heldState.map((r) => [`${r.vendor}|${r.url}`, r]));

const refusalsOf = new Map<string, StoredRefusal[]>();
for (const refusal of storedRefusals) {
  const key = refusal.vendor.trim().toLowerCase();
  const held = refusalsOf.get(key);
  if (held) held.push(refusal);
  else refusalsOf.set(key, [refusal]);
}

const slugOf = (vendor: string) =>
  vendor.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

function sameDayRefusals(offer: CatalogueOffer): StoredRefusal[] {
  const record = stateOf.get(`${offer.vendor}|${offer.url}`);
  if (!record || record.last_outcome !== "changed" || !record.last_attempt_at) return [];
  return (refusalsOf.get(offer.vendor.trim().toLowerCase()) ?? [])
    .filter((r) => r.refused_date === record.last_attempt_at);
}

function nothingLaterSpokeFor(offer: CatalogueOffer): boolean {
  const record = stateOf.get(`${offer.vendor}|${offer.url}`)!;
  const read = record.last_attempt_at!;
  const restated = offer.restated_from?.reading_date ?? null;
  if (restated !== null && restated >= read) return false;
  return !(record.last_success !== null && record.last_success > read);
}

const voidedByItsOwnRefusal = offers.filter((offer) => {
  const sameDay = sameDayRefusals(offer);
  if (sameDay.length === 0) return false;
  if (!sameDay.every((r) => refusalVoidsTheReadsStanding(r))) return false;
  return nothingLaterSpokeFor(offer);
});

const stillContradicted = offers.filter((offer) => {
  const sameDay = sameDayRefusals(offer);
  if (sameDay.length > 0 && sameDay.every((r) => refusalSettledTheRead(r))) return false;
  const record = stateOf.get(`${offer.vendor}|${offer.url}`);
  if (record?.last_outcome !== "changed" || !record.last_attempt_at) return false;
  return nothingLaterSpokeFor(offer);
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

describe("every reason a rule can refuse under is classified", () => {
  const REASONS_A_RULE_CAN_WRITE: string[] = [...GATE_REASONS, SUPPRESSED_SAME_TRANSITION_REGRADED];

  const REGISTERS: Array<[string, readonly string[]]> = [
    ["confirms the stored terms", REFUSAL_REASONS_THAT_CONFIRM_THE_STORED_TERMS],
    ["measured no difference", REFUSAL_REASONS_THAT_MEASURED_NO_DIFFERENCE],
    ["voids the read's standing", REFUSAL_REASONS_THAT_VOID_THE_READS_STANDING],
    ["leaves the read standing", REFUSAL_REASONS_THAT_LEAVE_THE_READ_STANDING],
  ];

  it("names a register for every reason the writer can emit", () => {
    const classified = new Set(REGISTERS.flatMap(([, reasons]) => reasons));
    const unclassified = REASONS_A_RULE_CAN_WRITE.filter((r) => !classified.has(r));
    assert.deepStrictEqual(
      unclassified,
      [],
      `a rule can refuse under these reasons and no register says what the read then found: ${unclassified.join(", ")}`,
    );
  });

  it("puts no reason in two registers", () => {
    const seen = new Map<string, string>();
    const doubled: string[] = [];
    for (const [name, reasons] of REGISTERS) {
      for (const reason of reasons) {
        const held = seen.get(reason);
        if (held) doubled.push(`${reason}: ${held} and ${name}`);
        else seen.set(reason, name);
      }
    }
    assert.deepStrictEqual(doubled, []);
  });

  it("invents no reason the writer cannot emit", () => {
    const canWrite = new Set(REASONS_A_RULE_CAN_WRITE);
    const invented = REGISTERS.flatMap(([name, reasons]) =>
      reasons.filter((r) => !canWrite.has(r)).map((r) => `${name}: ${r}`));
    assert.deepStrictEqual(invented, []);
  });

  it("holds no refusal in the store under a reason no register classifies", () => {
    const classified = new Set(REGISTERS.flatMap(([, reasons]) => reasons));
    const unknown = [...new Set(storedRefusals.map((r) => r.reason))].filter((r) => !classified.has(r));
    assert.deepStrictEqual(unknown, []);
  });

  it("states what the read found for every reason that voids its standing", () => {
    const silent = REFUSAL_REASONS_THAT_VOID_THE_READS_STANDING.filter(
      (r) => !WHAT_A_VOIDED_READ_FOUND[r],
    );
    assert.deepStrictEqual(silent, []);
    for (const reason of REFUSAL_REASONS_THAT_VOID_THE_READS_STANDING) {
      assert.notStrictEqual(
        WHAT_A_VOIDED_READ_FOUND[reason],
        FOUND_A_DIFFERENCE,
        `${reason} voids the read and still publishes the difference`,
      );
    }
  });

  it("reads no terms from the page for the two reasons that say so", () => {
    assert.strictEqual(WHAT_A_VOIDED_READ_FOUND.no_price_signal, READ_NO_TERMS);
    assert.strictEqual(WHAT_A_VOIDED_READ_FOUND.states_no_terms, READ_NO_TERMS);
  });
});

describe("a refusal that voids the read that raised it", () => {
  it("settles the read on the day it was refused", () => {
    for (const reason of REFUSAL_REASONS_THAT_VOID_THE_READS_STANDING) {
      assert.ok(refusalSettledTheRead({ reason }), `${reason} settles nothing`);
      assert.deepStrictEqual(howWeSettledTheRead([refused(reason)], READ), {
        settlement: READ_VOIDED_BY_ITS_OWN_REFUSAL,
        refusal: refused(reason),
      });
    }
  });

  it("settles nothing on a day that is not the day of the read", () => {
    assert.strictEqual(howWeSettledTheRead([refused("no_price_signal", "2026-09-10")], READ), null);
    assert.strictEqual(howWeSettledTheRead([refused("no_price_signal", "2026-09-12")], READ), null);
  });

  it("leaves the read standing where a same-day refusal rests on other grounds", () => {
    for (const reason of REFUSAL_REASONS_THAT_LEAVE_THE_READ_STANDING) {
      assert.strictEqual(
        howWeSettledTheRead([refused("no_price_signal"), refused(reason)], READ),
        null,
        `${reason} left the day settled`,
      );
    }
  });

  it("yields to a same-day refusal that measured the figures or restated our terms", () => {
    assert.strictEqual(
      howWeSettledTheRead([refused("no_price_signal"), refused("measures_no_change")], READ)?.settlement,
      "named_no_figure_that_moved",
    );
    assert.strictEqual(
      howWeSettledTheRead([refused("states_no_terms"), refused("confirmed_unchanged")], READ)?.settlement,
      "restated_the_terms_we_publish",
    );
    assert.strictEqual(
      howWeSettledTheRead(
        [refused("no_baseline"), refused("measures_no_change"), refused("free_tier_still_offered")],
        READ,
      )?.settlement,
      "restated_the_terms_we_publish",
    );
  });

  it("publishes what the refusal found in place of the difference", () => {
    for (const reason of REFUSAL_REASONS_THAT_VOID_THE_READS_STANDING) {
      const settled = howWeSettledTheRead([refused(reason)], READ)!;
      assert.strictEqual(whatASettledReadFound(settled), WHAT_A_VOIDED_READ_FOUND[reason]);
      assert.strictEqual(whatTheLastReadFound("changed", settled), WHAT_A_VOIDED_READ_FOUND[reason]);
    }
  });

  it("still states the difference where nothing refused that read", () => {
    assert.strictEqual(whatTheLastReadFound("changed", null), FOUND_A_DIFFERENCE);
  });

  it("leaves a read that did not find the page changed alone", () => {
    for (const outcome of ["confirmed", "states_no_price", "link_ok", "fetch_failed"]) {
      const raw = readingOn(READ, outcome);
      assert.deepStrictEqual(readingSettledByRefusals(raw, [refused("no_price_signal")]), raw);
    }
  });

  it("rewrites only what a changed read found", () => {
    const raw = readingOn(READ);
    const settled = readingSettledByRefusals(raw, [refused("removal_read_from_root")])!;
    assert.strictEqual(settled.found, WHAT_A_VOIDED_READ_FOUND.removal_read_from_root);
    assert.deepStrictEqual({ ...settled, found: null }, { ...raw, found: null });
  });

  it("reads the refusal of the day, not a settlement typed beside it", () => {
    const settled = howWeSettledTheRead([refused("no_removal_evidence")], READ)!;
    assert.notStrictEqual(whatASettledReadFound(settled), WHAT_A_SETTLED_READ_FOUND.named_no_figure_that_moved);
    assert.notStrictEqual(whatASettledReadFound(settled), WHAT_A_SETTLED_READ_FOUND.restated_the_terms_we_publish);
  });
});

describe("the pages that describe a read our own refusal voided", () => {
  before(async () => { proc = await startServer(); });
  after(() => { proc?.kill(); });

  it("holds records on both sides of the rule", () => {
    assertPopulationFloor(voidedByItsOwnRefusal.length, 50, "records whose last read its own refusal voided");
    assertPopulationFloor(stillContradicted.length, 200, "records whose last read still contradicts the terms");
  });

  it("publishes no difference on a vendor page whose read its own refusal voided", async () => {
    const wrong: string[] = [];
    for (const offer of voidedByItsOwnRefusal) {
      const { status, body } = await get(`/vendor/${slugOf(offer.vendor)}`);
      if (status !== 200) continue;
      if (body.includes(FOUND_A_DIFFERENCE)) wrong.push(`/vendor/${slugOf(offer.vendor)}`);
    }
    assert.deepStrictEqual(
      wrong.slice(0, 20),
      [],
      `these publish a difference our own refusal of that same read voided:\n${wrong.slice(0, 20).join("\n")}`,
    );
  });

  it("states what the refusal found wherever it speaks about that read", async () => {
    const spoke: string[] = [];
    const wrong: string[] = [];
    for (const offer of voidedByItsOwnRefusal) {
      const reason = sameDayRefusals(offer)[0].reason;
      const { status, body } = await get(`/vendor/${slugOf(offer.vendor)}`);
      if (status !== 200) continue;
      if (!body.includes("Our last read of it, on ")) continue;
      spoke.push(offer.vendor);
      if (!body.includes(WHAT_A_VOIDED_READ_FOUND[reason])) {
        wrong.push(`/vendor/${slugOf(offer.vendor)} (${reason})`);
      }
    }
    assertPopulationFloor(spoke.length, 40, "voided reads whose vendor page states what the read found");
    assert.deepStrictEqual(wrong.slice(0, 20), [], wrong.slice(0, 20).join("\n"));
  });

  it("still publishes the difference where no refusal settled the read", async () => {
    const quiet: string[] = [];
    let spoke = 0;
    for (const offer of stillContradicted.slice(0, 120)) {
      const { status, body } = await get(`/vendor/${slugOf(offer.vendor)}`);
      if (status !== 200) continue;
      if (!body.includes("Our last read of it, on ")) continue;
      spoke++;
      if (!body.includes(FOUND_A_DIFFERENCE)) quiet.push(`/vendor/${slugOf(offer.vendor)}`);
    }
    assertPopulationFloor(spoke, 50, "unsettled contradicting reads whose vendor page states what the read found");
    assert.deepStrictEqual(quiet.slice(0, 20), [], quiet.slice(0, 20).join("\n"));
  });

  it("counts a listed row it no longer calls contradicted only where the row still speaks", async () => {
    const categories = [...new Set(
      JSON.parse(readFileSync(path.join(REPO, "data", "index.json"), "utf-8"))
        .offers.map((o: { category: string }) => o.category),
    )] as string[];
    const disagreeing: string[] = [];
    let checked = 0;
    for (const category of categories) {
      const { status, body } = await get(`/category/${slugOf(category)}`);
      if (status !== 200) continue;
      const stated = body.match(/We could not confirm today's terms for (\d+) of them/);
      if (!stated) continue;
      checked++;
      const reasons = (body.match(/class="listing-(read-contradicts|terms-unconfirmed|link-unreachable)"/g) ?? []).length;
      if (Number(stated[1]) > reasons) {
        disagreeing.push(`/category/${slugOf(category)}: ${stated[1]} counted, ${reasons} rows speak`);
      }
    }
    assertPopulationFloor(checked, 40, "category pages stating a count of terms we cannot confirm");
    assert.deepStrictEqual(disagreeing.slice(0, 20), [], disagreeing.slice(0, 20).join("\n"));
  });

  it("leaves a record whose last read confirmed saying nothing about a refusal", async () => {
    const confirmed = offers.filter(
      (o) => stateOf.get(`${o.vendor}|${o.url}`)?.last_outcome === "confirmed",
    );
    assertPopulationFloor(confirmed.length, 240, "records whose last read confirmed the terms");
    const voidedClauses = [...new Set(Object.values(WHAT_A_VOIDED_READ_FOUND))] as string[];
    const speaking: string[] = [];
    for (const offer of confirmed.slice(0, 120)) {
      const { status, body } = await get(`/vendor/${slugOf(offer.vendor)}`);
      if (status !== 200) continue;
      for (const clause of voidedClauses) {
        if (body.includes(`Our last read of it, on `) && body.includes(clause)) {
          speaking.push(`/vendor/${slugOf(offer.vendor)}: ${clause}`);
        }
      }
    }
    assert.deepStrictEqual(speaking.slice(0, 20), [], speaking.slice(0, 20).join("\n"));
  });
});
