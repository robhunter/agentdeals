import { describe, it } from "node:test";
import assert from "node:assert";
import {
  BYLINE_CLASS, acceptsAByline, bylineFor, publishedDateEndsAt, withReviewByline,
} from "../dist/page-byline.js";
import type { PageReviewRecord } from "../src/page-reviews.ts";

const TODAY = "2026-09-12";

function record(fields: Partial<PageReviewRecord> = {}): PageReviewRecord {
  return {
    path: "/a-registered-page",
    published: "2026-04-08",
    tier: "A",
    vendors_asserted: [],
    vendors_tabulated: [],
    badge_subjects_unresolved: [],
    reviewed_at: null,
    reviewer: null,
    review_outcome: null,
    review_note: null,
    reads_index: false,
    reads_changes: false,
    data_source: "unsourced",
    data_source_reason: null,
    ...fields,
  };
}

function holding(held: PageReviewRecord | null) {
  return () => held;
}

const WITH_BYLINE = '<h1>A page</h1><p class="pub-date">Published 2026-04-08 &middot; 19 providers compared</p>';
const WITHOUT_BYLINE = '<h1>A page</h1><p class="subtitle">Everything you need.</p>';

describe("#1543 the byline is derived from the register rather than named page by page", () => {
  it("puts the review beside the publication date the page already prints", () => {
    const rendered = withReviewByline(WITH_BYLINE, "/a-registered-page", TODAY, holding(record()));
    assert.match(rendered, /Published 2026-04-08 &middot; Not yet reviewed &middot; 19 providers compared/);
  });

  it("gives a page with no publication date one, so a register entry cannot go unanswered", () => {
    const rendered = withReviewByline(WITHOUT_BYLINE, "/a-registered-page", TODAY, holding(record()));
    assert.match(rendered, new RegExp(`</h1><p class="${BYLINE_CLASS}">Published 2026-04-08 &middot; Not yet reviewed</p><p class="subtitle">`));
  });

  it("carries a failed review to a page that had no publication date to attach it to", () => {
    const failed = record({ reviewed_at: "2026-09-11", reviewer: "pm", review_outcome: "fail" });
    const rendered = withReviewByline(WITHOUT_BYLINE, "/a-registered-page", TODAY, holding(failed));
    assert.match(rendered, /Reviewed 2026-09-11, corrections outstanding/);
  });

  it("leaves a page the register holds no record for exactly as it was", () => {
    assert.strictEqual(withReviewByline(WITH_BYLINE, "/not-registered", TODAY, holding(null)), WITH_BYLINE);
    assert.strictEqual(withReviewByline(WITHOUT_BYLINE, "/not-registered", TODAY, holding(null)), WITHOUT_BYLINE);
  });

  it("says the same thing twice running, so a page served through two passes reads once", () => {
    const once = withReviewByline(WITH_BYLINE, "/a-registered-page", TODAY, holding(record()));
    assert.strictEqual(withReviewByline(once, "/a-registered-page", TODAY, holding(record())), once);
    const created = withReviewByline(WITHOUT_BYLINE, "/a-registered-page", TODAY, holding(record()));
    assert.strictEqual(withReviewByline(created, "/a-registered-page", TODAY, holding(record())), created);
  });

  it("adds nothing where the segment rule falls silent, rather than an empty aside", () => {
    const expired = record({ reviewed_at: "2026-04-13", reviewer: "pm", review_outcome: "pass" });
    assert.strictEqual(withReviewByline(WITH_BYLINE, "/a-registered-page", TODAY, holding(expired)), WITH_BYLINE);
    assert.strictEqual(
      withReviewByline(WITHOUT_BYLINE, "/a-registered-page", TODAY, holding(expired)),
      WITHOUT_BYLINE.replace("</h1>", `</h1>${bylineFor(expired, "")}`),
    );
  });

  it("attaches to the publication date a reader sees, not one written inside a script", () => {
    const scripted = `<script>const t = '<p class="pub-date">Published 2026-01-01</p>';</script>${WITH_BYLINE}`;
    const rendered = withReviewByline(scripted, "/a-registered-page", TODAY, holding(record()));
    assert.match(rendered, /Published 2026-01-01<\/p>';<\/script>/);
    assert.match(rendered, /Published 2026-04-08 &middot; Not yet reviewed/);
  });

  it("opens the new element after a heading a reader sees, not one written inside a script", () => {
    const scripted = `<script>const t = '<h1>Draft</h1>';</script>${WITHOUT_BYLINE}`;
    const rendered = withReviewByline(scripted, "/a-registered-page", TODAY, holding(record()));
    assert.match(rendered, /'<h1>Draft<\/h1>';<\/script>/);
    assert.match(rendered, new RegExp(`<h1>A page</h1><p class="${BYLINE_CLASS}">Published 2026-04-08`));
  });

  it("finds no place to speak on a page with neither a publication date nor a heading", () => {
    const bare = "<p>Nothing to attach to.</p>";
    assert.strictEqual(acceptsAByline(bare), false);
    assert.strictEqual(withReviewByline(bare, "/a-registered-page", TODAY, holding(record())), bare);
    assert.strictEqual(acceptsAByline(WITH_BYLINE), true);
    assert.strictEqual(acceptsAByline(WITHOUT_BYLINE), true);
  });

  it("reads the publication date out of an element of any name, because pages do not agree on one", () => {
    for (const element of ['<p class="pub-date">', '<div class="pub-date">', '<p class="updated">']) {
      const html = `<h1>A page</h1>${element}Published 2026-04-08</p>`;
      assert.notStrictEqual(publishedDateEndsAt(html), -1);
      assert.match(
        withReviewByline(html, "/a-registered-page", TODAY, holding(record())),
        /Published 2026-04-08 &middot; Not yet reviewed/,
      );
    }
  });
});
