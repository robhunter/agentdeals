import { describe, it } from "node:test";
import assert from "node:assert";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  SOURCE_CHECK_FREE_PRICE,
  SOURCE_CHECK_NO_AMOUNT,
  SOURCE_CHECK_NO_TERMS,
  SOURCE_CHECK_OK,
  WE_MATCHED_NO_AMOUNT_TO_OUR_TERMS,
  checkKeptOnlyTheName,
  classifySource,
  detailIsOnlyTheNaming,
} from "../scripts/vendor-naming.js";
import { priceSignals } from "../scripts/change-gate.js";
import {
  detailWithoutFiguresWeDoNotPublish,
  needsAReread,
} from "../scripts/withdraw-figures-we-do-not-publish.js";
import { isQuarantined, readVerificationState } from "../scripts/verification-state.js";
import { offerKey } from "../scripts/change-refusals.js";

const { pickOldestEntries, summaryLines } = await import("../scripts/reverify-rolling.js");

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const HOOKLINE = {
  vendor: "Hookline",
  url: "https://hookline.example/pricing",
  description: "Free plan includes 1,000 events/mo and 3 projects",
};

const TUTANOTA = {
  vendor: "Tutanota",
  url: "https://tuta.example/pricing",
  description: "Free plan includes 1 GB storage",
};

function readOf(offer: { vendor: string; url: string; description: string }, text: string) {
  return classifySource(offer, { ok: true, text }, priceSignals(text));
}

function namingOf(detail: string) {
  return detail.slice(0, detail.indexOf(" and "));
}

describe("a check that kept only the vendor's name", () => {
  it("is recognised in both forms a naming clause takes", () => {
    assert.strictEqual(detailIsOnlyTheNaming('the page names Hookline as "hookline"', "Hookline"), true);
    assert.strictEqual(
      detailIsOnlyTheNaming('the page writes "tuta", the domain we cite Tutanota from', "Tutanota"),
      true,
    );
    assert.strictEqual(
      detailIsOnlyTheNaming('the page writes "tuta", the domain we cite Tutanota from,', "Tutanota"),
      true,
    );
  });

  it("is the naming clause a read writes, with what the read found cut away", () => {
    const named = readOf(HOOKLINE, "Hookline pricing. Teams from $29/mo. Free: 1,000 events/mo.");
    const hosted = readOf(TUTANOTA, "Tuta secure email. Legend from €3/month. Free: 1 GB storage.");
    for (const read of [named, hosted]) {
      assert.strictEqual(read.outcome, SOURCE_CHECK_OK, read.detail);
      assert.strictEqual(detailIsOnlyTheNaming(read.detail, read === named ? "Hookline" : "Tutanota"), false);
      assert.strictEqual(
        detailIsOnlyTheNaming(namingOf(read.detail), read === named ? "Hookline" : "Tutanota"),
        true,
        namingOf(read.detail),
      );
    }
    assert.match(hosted.detail, /^the page writes "tuta", the domain we cite Tutanota from, and /);
  });

  it("is not a check that says what the page states", () => {
    const stated = [
      'the page names Hookline as "hookline" and states "1,000 events/mo"',
      `the page names Hookline as "hookline" and ${WE_MATCHED_NO_AMOUNT_TO_OUR_TERMS}`,
      'the page names Hookline, renders no terms we can read, and its markup carries the price "0 USD"',
      'the page names Hookline and states "Free $0 per month" over "10k credits per month"',
      'the page names Hookline but states no amount, tier or rate we can read',
      "",
    ];
    for (const detail of stated) {
      assert.strictEqual(
        checkKeptOnlyTheName({ vendor: "Hookline", source_check: { outcome: SOURCE_CHECK_OK, detail } }),
        false,
        detail,
      );
    }
  });

  it("is read on the record's own vendor and outcome", () => {
    const naming = 'the page names Hookline as "hookline"';
    assert.strictEqual(checkKeptOnlyTheName({ vendor: "Hookline", source_check: { outcome: SOURCE_CHECK_OK, detail: naming } }), true);
    assert.strictEqual(checkKeptOnlyTheName({ vendor: "Hookbase", source_check: { outcome: SOURCE_CHECK_OK, detail: naming } }), false);
    assert.strictEqual(checkKeptOnlyTheName({ vendor: "Hookline", source_check: { outcome: SOURCE_CHECK_NO_TERMS, detail: naming } }), false);
    assert.strictEqual(checkKeptOnlyTheName({ vendor: "Hookline" }), false);
  });
});

describe("a read writes the whole finding, and the clause only where the page states amounts", () => {
  const reads: [string, { vendor: string; url: string; description: string }, string, string][] = [
    ["an amount we publish", HOOKLINE, "Hookline pricing. Teams from $29/mo. Free: 1,000 events/mo.", SOURCE_CHECK_OK],
    ["amounts we do not publish", HOOKLINE, "Hookline pricing. Plans start at $49/mo for teams that need more.", SOURCE_CHECK_OK],
    ["the domain's name and an amount", TUTANOTA, "Tuta secure email. Legend from €3/month.", SOURCE_CHECK_OK],
    ["no amount, tier or rate", HOOKLINE, "Hookline helps teams ship webhooks without running queues or retries themselves.", SOURCE_CHECK_NO_TERMS],
    ["a price only in words", HOOKLINE, "Hookline helps teams ship webhooks. Free plan for small teams, no card needed.", SOURCE_CHECK_FREE_PRICE],
    ["a plan whose price it withholds", HOOKLINE, "Hookline helps teams ship webhooks. Enterprise plan: talk to our team.", SOURCE_CHECK_NO_AMOUNT],
  ];

  for (const [subject, offer, text, outcome] of reads) {
    it(`does not keep only the name on a page that states ${subject}`, () => {
      const read = readOf(offer, text);
      assert.strictEqual(read.outcome, outcome, read.detail);
      assert.strictEqual(checkKeptOnlyTheName({ vendor: offer.vendor, source_check: read }), false, read.detail);
      if (outcome !== SOURCE_CHECK_OK) {
        assert.ok(!read.detail.includes(WE_MATCHED_NO_AMOUNT_TO_OUR_TERMS), read.detail);
      }
    });
  }
});

describe("the stored-figure restatement leaves a finding it cannot re-derive for a re-read", () => {
  const stored = [
    ['the page names Hookline as "hookline" and states "$10"', "Free plan includes 5 GB storage"],
    ['the page writes "tuta", the domain we cite Tutanota from, and states "$21"', "Free plan includes 3 collaborators"],
  ];

  for (const [detail, terms] of stored) {
    it(`leaves "${detail}" as it is`, () => {
      assert.strictEqual(needsAReread(detail, terms), true);
      assert.strictEqual(detailWithoutFiguresWeDoNotPublish(detail, terms), detail);
    });
  }

  it("still narrows a stored pair to the figure we publish, which needs no re-read", () => {
    const pair = 'the page names Hookline as "hookline" and states "$49" and "1,000 events/mo"';
    assert.strictEqual(needsAReread(pair, HOOKLINE.description), false);
    assert.strictEqual(
      detailWithoutFiguresWeDoNotPublish(pair, HOOKLINE.description),
      'the page names Hookline as "hookline" and states "1,000 events/mo"',
    );
  });
});

function recordOn(vendor: string, verifiedDate: string, checked: string, detail: string) {
  return {
    vendor,
    url: `https://${vendor.toLowerCase()}.example/pricing`,
    verifiedDate,
    source_check: { checked, outcome: SOURCE_CHECK_OK, detail },
  };
}

const RUN = new Date("2026-09-26T06:00:00Z");

describe("the rotation reads a record whose check kept only the name before older records", () => {
  const oldest = recordOn("Alderbrook", "2026-06-01", "2026-09-01", 'the page names Alderbrook as "alderbrook" and states "1,000 events/mo"');
  const clause = recordOn("Birchfield", "2026-07-01", "2026-09-03", `the page names Birchfield as "birchfield" and ${WE_MATCHED_NO_AMOUNT_TO_OUR_TERMS}`);
  const recentName = recordOn("Cedarline", "2026-09-12", "2026-09-12", 'the page names Cedarline as "cedarline"');
  const olderName = recordOn("Dunmore", "2026-09-08", "2026-09-08", 'the page writes "dunmore", the domain we cite Dunmore from');
  const offers = [oldest, clause, recentName, olderName];

  it("draws both before either record that holds a finding, the older of the two first", () => {
    const { picked } = pickOldestEntries(offers, 2, RUN);
    assert.deepStrictEqual(picked.map((entry: any) => entry.offer.vendor), ["Dunmore", "Cedarline"]);
  });

  it("goes back to age order once none is left", () => {
    const { picked } = pickOldestEntries(offers, 4, RUN);
    assert.deepStrictEqual(picked.map((entry: any) => entry.offer.vendor), ["Dunmore", "Cedarline", "Alderbrook", "Birchfield"]);
  });

  it("keeps a held verdict's second reading ahead of it", () => {
    const awaitingCorroboration = new Set([offerKey(clause.vendor, clause.url)]);
    const { picked } = pickOldestEntries(offers, 1, RUN, { awaitingCorroboration });
    assert.deepStrictEqual(picked.map((entry: any) => entry.offer.vendor), ["Birchfield", "Dunmore"]);
  });

  it("says in the run summary how many it drew and how many were waiting", () => {
    const draw = pickOldestEntries(offers, 1, RUN);
    assert.strictEqual(draw.pickedBecauseTheCheckKeptOnlyTheName, 1);
    assert.strictEqual(draw.queuedWithACheckThatKeptOnlyTheName, 2);
    const lines = summaryLines({ verified: 0 }, { checked: 1, ...draw });
    assert.ok(lines.includes("Drawn first because the stored check kept only the vendor's name: 1 of 2"), lines.join("\n"));
    assert.ok(!summaryLines({ verified: 0 }, { checked: 1 }).some((line: string) => line.startsWith("Drawn first because")));
  });
});

describe("on the committed catalogue, every record whose check kept only the name is drawn first", () => {
  const offers = JSON.parse(readFileSync(path.join(__dirname, "..", "data", "index.json"), "utf-8")).offers as any[];
  const verificationState = readVerificationState(path.join(__dirname, "..", "data", "verification_state.json"));
  const LIMIT = 75;

  it("fills the run's queue slots with them before any other record", () => {
    const waiting = offers.filter(
      offer => checkKeptOnlyTheName(offer) && !isQuarantined(verificationState.get(offerKey(offer.vendor, offer.url))),
    );
    const { picked, retriedFromQuarantine } = pickOldestEntries(offers, LIMIT, new Date(), { verificationState });
    const kept = picked.map((entry: any) => checkKeptOnlyTheName(entry.offer));
    const drawn = kept.filter(Boolean).length;
    assert.strictEqual(drawn, Math.min(waiting.length, LIMIT - retriedFromQuarantine));
    assert.deepStrictEqual(kept.slice(0, drawn), new Array(drawn).fill(true));
  });
});
