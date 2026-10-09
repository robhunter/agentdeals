import { describe, it } from "node:test";
import assert from "node:assert";
import { nextRecord } from "../scripts/check-liveness.js";

const { unreachableNotice, LINK_GRACE_DAYS } = await import("../dist/link-health.js");
const { evaluate } = await import("../dist/ranking.js");
const { withheldStability } = await import("../dist/data.js");

const URL = "https://grace.example/pricing";
const VERIFIED = "2026-07-31";
const LAST_RUN_THAT_REACHED_IT = "2026-09-28";
const FIRST_FAILED_RUN = "2026-09-29";

const target = { url: URL, latestVerified: VERIFIED, vendors: ["Grace"] };
const failed = { outcome: "unreachable" as const, detail: "GET ENOTFOUND", terminal: false };
const nothingWithheld = { link_unreachable: null, refused_read: null, rating_withheld: null, source_check: null, gate: null };

function dayAfter(day: string): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + 86400000).toISOString().slice(0, 10);
}

function recordsFailingFrom(firstFailedRun: string, lastRun: string, through: string) {
  const records = new Map<string, ReturnType<typeof nextRecord>>();
  let previous: ReturnType<typeof nextRecord> | undefined;
  let runBefore = lastRun;
  for (let day = firstFailedRun; day <= through; day = dayAfter(day)) {
    previous = nextRecord(target, previous, failed, day, runBefore);
    records.set(day, previous);
    runBefore = day;
  }
  return records;
}

function publishedOn(day: string, record: ReturnType<typeof nextRecord>) {
  const notice = unreachableNotice(record, Date.parse(`${day}T00:00:00Z`));
  const evaluation = evaluate(
    { vendor: "Grace", category: "Databases", description: "A free tier.", tier: "Free", url: URL, tags: [], verifiedDate: VERIFIED },
    { date: day, changesForVendor: [], linkHealth: (url: string) => (url === URL ? notice : null) },
  );
  return {
    notice,
    linkDemerits: evaluation.demerits.map((d: { code: string }) => d.code).filter((code: string) => code.startsWith("link_")),
    stability: withheldStability({ ...nothingWithheld, link_unreachable: notice }, "stable"),
  };
}

describe("the grace a vendor is allowed for an outage counts from the last run that reached its page", () => {
  const through = "2026-10-13";
  const records = recordsFailingFrom(FIRST_FAILED_RUN, LAST_RUN_THAT_REACHED_IT, through);

  it("gives a page whose record was verified 60 days ago no notice, no demerit and its stable label on the day it first fails", () => {
    const first = records.get(FIRST_FAILED_RUN)!;
    assert.strictEqual(first.last_reachable, LAST_RUN_THAT_REACHED_IT);
    assert.deepStrictEqual(publishedOn(FIRST_FAILED_RUN, first), { notice: null, linkDemerits: [], stability: "stable" });
  });

  it("still publishes nothing against the page on the last day of the grace", () => {
    const lastGraceDay = "2026-10-11";
    assert.deepStrictEqual(publishedOn(lastGraceDay, records.get(lastGraceDay)!), { notice: null, linkDemerits: [], stability: "stable" });
  });

  it(`publishes the notice, the demerit and withholds the stable label once ${LINK_GRACE_DAYS} days have passed since the page last answered`, () => {
    const firstDayPast = "2026-10-12";
    const published = publishedOn(firstDayPast, records.get(firstDayPast)!);
    assert.deepStrictEqual(published.notice, { last_reachable: LAST_RUN_THAT_REACHED_IT, checked: firstDayPast, terminal: false });
    assert.deepStrictEqual(published.linkDemerits, ["link_unreachable"]);
    assert.strictEqual(published.stability, null);
  });
});
