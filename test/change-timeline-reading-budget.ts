import assert from "node:assert/strict";
import TurndownService from "turndown";
import { createDocument } from "@mixmark-io/domino";

export function changeTimelineMarkdown(html: string) {
  const document = createDocument(html);
  for (const node of document.querySelectorAll("head, script, style")) node.parentNode!.removeChild(node);
  const converter = new TurndownService();
  const markdown = converter.turndown(document.body);
  const ends = { latest: 0, upcoming: 0 };
  for (const section of ["latest", "upcoming"] as const) {
    const nodes = document.querySelectorAll(`.${section}-section`);
    assert.equal(nodes.length, 1, `one ${section} section`);
    const content = converter.turndown(nodes[0]);
    assert.ok(content.length > 0, `${section} section has markdown content`);
    const start = markdown.indexOf(content);
    assert.ok(start >= 0, `${section} section occurs in the page's markdown`);
    assert.equal(markdown.indexOf(content, start + 1), -1, `${section} section occurs once`);
    ends[section] = start + content.length;
  }
  return { markdown, ends };
}

export function assertChangeTimelineReadingBudget(html: string) {
  const result = changeTimelineMarkdown(html);
  for (const section of ["latest", "upcoming"] as const) {
    assert.ok(result.ends[section] <= 100_000, `${section} section ends at markdown character ${result.ends[section]}, beyond the 100000-character reading window`);
  }
  return result;
}
