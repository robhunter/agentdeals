export interface FeedCorrection {
  id: string;
  updated: string;
  title: string;
  path: string;
  summaryHtml: string;
}

export const FEED_CORRECTIONS: FeedCorrection[] = [
  {
    id: "urn:agentdeals:correction:2026-08-29:weekly-digest-2026-08-24",
    updated: "2026-08-29T00:00:00.000Z",
    title: "Correction: the digest for the week of August 24–30, 2026",
    path: "/this-week",
    summaryHtml:
      "<p>The digest published for the week of August 24–30, 2026 reported <em>24 free tiers removed, 6 new ones added, 3 products deprecated, 53 limits reduced, 23 limits increased, 29 pricing restructures across 154 developer tool pricing changes</em>. That count was wrong, and this entry replaces it.</p>" +
      "<p>153 of those 154 records came from a single run on 2026-08-28 in which we read those vendors’ pricing pages for the first time. Each one records terms that differ from what we had stored, on a page that does not say when they changed — so the record carries the date we read it, not the date it took effect. Some of what they describe is years old. One change in that week has a known effective date: OpenAI’s removal of the Assistants API free tier, on 2026-08-26.</p>" +
      "<p>Weekly counts now include only changes with a known effective date. Pages read for the first time are reported separately, under their own heading, and are not counted as changes that took effect in the week we read them.</p>",
  },
];

export function correctionEntriesXml(baseUrl: string, escXml: (s: string) => string): string[] {
  return FEED_CORRECTIONS.map(
    (c) => `  <entry>
    <title>${escXml(c.title)}</title>
    <link href="${escXml(baseUrl + c.path)}" rel="alternate"/>
    <id>${escXml(c.id)}</id>
    <updated>${c.updated}</updated>
    <author><name>AgentDeals</name></author>
    <summary type="html">${escXml(c.summaryHtml)}</summary>
  </entry>`
  );
}
