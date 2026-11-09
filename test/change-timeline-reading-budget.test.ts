import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { assertChangeTimelineReadingBudget, changeTimelineMarkdown } from "./change-timeline-reading-budget.ts";
import { visibleText } from "./change-vendor-index-observer.ts";

const page = ({ before = "", latest = "L", upcoming = "U", after = "", head = "" } = {}) =>
  `<!doctype html><html><head>${head}</head><body>${before}<section class="latest-section"><p>${latest}</p></section><div class="upcoming-section"><p>${upcoming}</p></div>${after}</body></html>`;

describe("change timeline markdown reading window", () => {
  it("accepts formatting-heavy HTML whose converted sections fit the window", () => {
    const html = page({ before: `<p>${"<span>x</span>".repeat(6500)}</p>` });
    const oldEstimate = visibleText(html).length + (html.match(/<[^>]+>/g) ?? []).length * 8;
    assert.equal(oldEstimate, 117139);
    const result = assertChangeTimelineReadingBudget(html);
    assert.equal(result.markdown, `${"x".repeat(6500)}\n\nL\n\nU`);
    assert.deepEqual(result.ends, { latest: 6503, upcoming: 6506 });
  });

  it("accepts the last character of Upcoming at the window boundary and refuses the next", () => {
    assert.deepEqual(assertChangeTimelineReadingBudget(page({ upcoming: "u".repeat(99_997) })).ends, { latest: 1, upcoming: 100_000 });
    assert.throws(() => assertChangeTimelineReadingBudget(page({ upcoming: "u".repeat(99_998) })), /upcoming section ends at markdown character 100001/);
  });

  it("refuses Latest itself beyond the reading window", () => {
    assert.throws(() => assertChangeTimelineReadingBudget(page({ latest: "l".repeat(100_001) })), /latest section ends at markdown character 100001/);
  });

  it("counts text before the sections but allows a long history after them", () => {
    assert.throws(() => assertChangeTimelineReadingBudget(page({ before: `<p>${"b".repeat(100_000)}</p>` })), /latest section ends at markdown character 100003/);
    const result = assertChangeTimelineReadingBudget(page({ after: `<p>${"h".repeat(100_001)}</p>` }));
    assert.equal(result.markdown.length, 100_007);
    assert.deepEqual(result.ends, { latest: 1, upcoming: 4 });
  });

  it("counts markdown links, titles, emphasis, lists and escaped text", () => {
    const result = assertChangeTimelineReadingBudget(page({
      before: '<h1>Changes &amp; prices</h1>',
      latest: '<a href="https://example.com/pricing?a=1&amp;b=2" title="Plan &amp; price">A &amp; B</a>',
      upcoming: '<strong>Paid</strong> * plan<ul><li>First</li><li>Second</li></ul>',
    }));
    const before = 'Changes & prices\n================\n\n';
    const latest = '[A & B](https://example.com/pricing?a=1&b=2 "Plan & price")';
    const upcoming = '**Paid** \\* plan\n\n*   First\n*   Second';
    assert.equal(result.markdown, before + latest + '\n\n' + upcoming);
    assert.deepEqual(result.ends, { latest: (before + latest).length, upcoming: result.markdown.length });
  });

  it("includes a link destination even when its visible label is short", () => {
    assert.throws(() => assertChangeTimelineReadingBudget(page({ upcoming: `<a href="https://example.com/${"u".repeat(100_000)}">U</a>` })), /upcoming section ends at markdown character/);
  });

  it("removes head, script and style content before measuring the body", () => {
    const hidden = "x".repeat(100_001);
    const result = assertChangeTimelineReadingBudget(page({
      head: `<title>${hidden}</title><script>${hidden}</script><style>${hidden}</style>`,
      before: `<script>${hidden}</script><style>${hidden}</style>`,
      upcoming: `U<script>${hidden}</script><style>${hidden}</style>`,
    }));
    assert.equal(result.markdown, "L\n\nU");
    assert.deepEqual(result.ends, { latest: 1, upcoming: 4 });
  });

  it("requires each named section exactly once with readable content", () => {
    for (const section of ["latest", "upcoming"]) {
      assert.throws(() => changeTimelineMarkdown(page().replace(`${section}-section`, "other-section")), new RegExp(`one ${section} section`));
      assert.throws(() => changeTimelineMarkdown(page({ after: `<section class="${section}-section">Duplicate</section>` })), new RegExp(`one ${section} section`));
    }
    assert.throws(() => changeTimelineMarkdown(page({ upcoming: "" })), /upcoming section has markdown content/);
  });
});
