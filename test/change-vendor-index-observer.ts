import assert from "node:assert/strict";

export const visibleText = (html: string) => html
  .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/g, " ")
  .replace(/<[^>]*>/g, " ")
  .replace(/&amp;/g, "&")
  .replace(/&#39;|&#x27;/g, "'")
  .replace(/&quot;/g, '"')
  .replace(/&lt;/g, "<")
  .replace(/&gt;/g, ">")
  .replace(/\s+/g, " ")
  .trim();

type Entry = { label: string; date: string; cancellation?: string };
type Vendor = { href: string | null; entries: Entry[] };

export function assertChangeVendorIndex(html: string, route: string) {
  const indexes = [...html.matchAll(/<section class="change-vendor-index"[^>]*>[\s\S]*?<\/section>/g)];
  assert.equal(indexes.length, 1, `${route}: one vendor index`);
  const index = indexes[0];
  assert.match(index[0], /<h2[^>]*>Every vendor on this page<\/h2>/);
  const groups = [...html.matchAll(/<div class="month-group(?: [^"]*)?"[^>]*>/g)];
  const expected = new Map<string, Vendor>();
  const entries = [...html.matchAll(/<div class="(?:pc|chg)-entry\b[^>]*>/g)];
  const oursAt = html.indexOf('id="month-ours"');
  const today = new Date().toISOString().slice(0, 10);
  for (let j = 0; j < entries.length; j++) {
    if (oursAt >= 0 && entries[j].index! > oursAt) continue;
    const originalDate = entries[j][0].match(/data-event-date="([^"]+)"/)?.[1];
    const entry = html.slice(entries[j].index!, entries[j + 1]?.index);
    const vendor = entry.match(/<(a|span)\b([^>]*\bclass="(?:pc|chg)-vendor"[^>]*)>([\s\S]*?)<\/\1>/);
    assert.ok(vendor, `${route}: entry has a vendor`);
    const name = visibleText(vendor[3]);
    const href = vendor[2].match(/href="([^"]+)"/)?.[1] ?? null;
    const label = entry.match(/<span class="badge"[^>]*>([^<]*)<\/span>/)?.[1];
    assert.ok(label, `${route}: ${name} has a change label`);
    if (originalDate && originalDate < today && visibleText(label) !== "cancelled") continue;
    const dateMarkup = entry.match(/<div class="(?:pc|chg)-date(?: [^"]*)?">([\s\S]*?)<\/div>/)?.[1];
    assert.ok(dateMarkup, `${route}: ${name} has a date label`);
    const date = visibleText(label) === "cancelled" ? visibleText(dateMarkup).match(/\d{4}-\d{2}-\d{2}/)?.[0] : originalDate ?? (/\b(?:pc|chg)-undated\b/.test(entries[j][0]) ? "(date unknown)" : visibleText(dateMarkup).match(/\bEffective:? (\d{4}-\d{2}-\d{2})\b/i)?.[1]);
    assert.ok(date, `${route}: ${name} has an effective date`);
    const bucket = expected.get(name) ?? { href, entries: [] };
    assert.equal(bucket.href, href, `${route}: ${name} has a consistent link`);
    const cancellation = visibleText(label) === "cancelled" ? visibleText((entry.match(/<div class="(?:pc|chg)-summary">([\s\S]*?)<\/div>/)?.[1] ?? "").replace(/<a\b[^>]*class="change-source"[^>]*>[\s\S]*?<\/a>/g, "")) : undefined;
    if (cancellation !== undefined) assert.ok(cancellation.length > 0, `${route}: ${name} names its cancellation`);
    bucket.entries.push({ label: visibleText(label), date, cancellation });
    expected.set(name, bucket);
  }
  assert.ok(expected.size > 0, `${route}: vendor entries exist`);
  const actual = [...index[0].matchAll(/<li>([\s\S]*?)<\/li>/g)].map(([, line]) => {
    const vendor = line.match(/^<(a|span)\b([^>]*)>([\s\S]*?)<\/\1>:\s*([\s\S]*)$/);
    assert.ok(vendor, `${route}: index line has one vendor and its changes`);
    return { name: visibleText(vendor[3]), href: vendor[2].match(/href="([^"]+)"/)?.[1] ?? null, text: visibleText(vendor[4]) };
  });
  const names = [...expected.keys()].sort((a, b) => a.localeCompare(b));
  assert.deepEqual(actual.map(line => line.name), names, `${route}: index names every rendered vendor once in alphabetical order`);
  for (const line of actual) {
    const vendor = expected.get(line.name)!;
    const sorted = [...vendor.entries].sort((a, b) => {
      if (a.date === "(date unknown)") return b.date === "(date unknown)" ? 0 : 1;
      if (b.date === "(date unknown)") return -1;
      return b.date.localeCompare(a.date);
    });
    assert.equal(line.href, vendor.href, `${route}: ${line.name} uses its entry's vendor link`);
    assert.equal(line.text, sorted.map(entry => entry.cancellation ?? `${entry.label} ${entry.date === "(date unknown)" ? entry.date : `effective ${entry.date}${entry.date > today ? " (upcoming)" : ""}`}`).join("; "), `${route}: ${line.name} lists every change label and date newest first`);
  }
  const following = route === "/pricing-changes" ? html.indexOf('<div class="upcoming-section"') : -1;
  const firstVendorMonth = groups.find(group => /<h2 class="month-heading" id="month-(?!ours)/.test(html.slice(group.index!, group.index! + 220)))?.index;
  assert.ok(firstVendorMonth !== undefined, `${route}: a vendor month section exists`);
  assert.ok(index.index! + index[0].length < (following >= 0 ? following : firstVendorMonth), `${route}: index precedes vendor changes`);
  const end = visibleText(html.slice(0, index.index! + index[0].length)).length;
  assert.ok(end <= 50_000, `${route}: index ends at visible character ${end}`);
  return { vendors: expected.size, entries: [...expected.values()].reduce((n, vendor) => n + vendor.entries.length, 0), linked: actual.filter(line => line.href !== null).length, end };
}
