import assert from "node:assert";

type VendorDate = { vendor: string; date: string };

type DigestWindow = {
  summary: string;
  upcoming_deadlines: VendorDate[];
  deal_changes: VendorDate[];
};

export function assertFutureChangesInDigestWindow(digest: DigestWindow, futureChanges: VendorDate[], today: string): void {
  for (const c of digest.deal_changes) {
    assert.ok(c.date <= today, `${c.vendor} ${c.date} should not be reported as a change already tracked`);
  }
  const statedWindow = digest.summary.match(/\b(\d+) upcoming deadlines? through (\d{4}-\d{2}-\d{2})\b/);
  if (digest.upcoming_deadlines.length === 0) {
    assert.strictEqual(statedWindow, null, "An empty deadline list must not state a last date");
    assert.strictEqual(futureChanges.length, 0, "Future changes require a nonempty deadline window");
    return;
  }
  assert.ok(statedWindow, "Upcoming deadlines require a stated last date");
  const end = statedWindow[2];
  assert.strictEqual(Number(statedWindow[1]), digest.upcoming_deadlines.length, "The summary must count the returned deadlines");
  assert.strictEqual(end, [...digest.upcoming_deadlines].map((d) => d.date).sort().at(-1), "The stated last date must end the returned window");
  for (const c of futureChanges.filter((c) => c.date > today && c.date <= end)) {
    assert.ok(
      digest.upcoming_deadlines.some((d) => d.vendor === c.vendor && d.date === c.date),
      `${c.vendor} ${c.date} should be an upcoming deadline through ${end}`
    );
  }
}
