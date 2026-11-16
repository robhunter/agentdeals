import { before, after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createDocument } from "@mixmark-io/domino";
import TurndownService from "turndown";
import { citationLabel, citedClaimHtml } from "../dist/change-citation.js";
import { citedSourceLinkHtml } from "../dist/source-citation.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const today = new Date().toISOString().slice(0, 10);
const day = (offset: number) => new Date(Date.parse(today) + offset * 86_400_000).toISOString().slice(0, 10);
const stored = JSON.parse(readFileSync(process.env.AGENTDEALS_CHANGES_PATH || path.join(ROOT, "data/deal_changes.json"), "utf8"));
const extra = Array.from({ length: 25 }, (_, i) => {
  const date = day(1 + Math.round(i * 89 / 24));
  return {
    vendor: `Capacity Shutdown ${i}`, what_ends: `Capacity Shutdown ${i} API`, date,
    discontinued_date: date, date_source: "vendor_page", recorded_date: today,
    change_type: "product_deprecated", summary: `Capacity Shutdown ${i} retires its API on ${date}. ${"Existing applications must migrate before the API stops accepting requests. ".repeat(7)}Use the replacement API and rotate the endpoint before the deadline.`,
    previous_state: "API available", current_state: "API retired", impact: "high", category: "APIs",
    source_url: `https://example.com/shutdowns/${i}`, alternatives: [], listing_effect: "none",
  };
});
const scratch = mkdtempSync(path.join(tmpdir(), "shutdown-capacity-"));
const pages = new Map<string, string>();

async function readPages(name: string, records: unknown[]) {
  const filename = path.join(scratch, `${name}.json`);
  writeFileSync(filename, JSON.stringify({ ...stored, changes: records }, null, 2) + "\n");
  const child = spawn("node", [path.join(ROOT, "dist/serve.js")], {
    cwd: ROOT, stdio: ["ignore", "ignore", "pipe"],
    env: { ...process.env, TZ: "UTC", PORT: "0", BASE_URL: "http://localhost", AGENTDEALS_REFERRAL_HEALTH: "off", AGENTDEALS_CHANGES_PATH: filename },
  });
  try {
    const port = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => { child.kill(); reject(new Error("Server startup timeout")); }, 30_000);
      child.stderr!.on("data", chunk => {
        const match = String(chunk).match(/running on http:\/\/localhost:(\d+)/);
        if (match) { clearTimeout(timer); resolve(match[1]); }
      });
      child.on("error", error => { clearTimeout(timer); reject(error); });
      child.on("exit", code => { clearTimeout(timer); reject(new Error(`Server exited with code ${code}`)); });
    });
    for (const route of ["/shutdowns", "/deadlines", "/pricing-changes"]) {
      const response = await fetch(`http://localhost:${port}${route}`, { redirect: "error" });
      assert.equal(response.status, 200);
      pages.set(`${name} ${route}`, await response.text());
    }
  } finally {
    if (child.exitCode === null && child.signalCode === null) { const exited = once(child, "exit"); child.kill(); await exited; }
  }
}
before(async () => {
  await readPages("live", stored.changes);
  await readPages("expanded", [...stored.changes, ...extra]);
});
after(() => rmSync(scratch, { recursive: true, force: true }));

function cardsOf(html: string) {
  const document = createDocument(html);
  let section = "";
  const cards: { section: string; node: Element }[] = [];
  for (const node of Array.from(document.querySelector(".container")!.children)) {
    if (node.tagName === "H2") section = node.id;
    if (node.classList.contains("shutdown-card")) cards.push({ section, node });
  }
  return { document, cards };
}

function markdownOf(document: Document) {
  for (const node of document.querySelectorAll("head, script, style")) node.parentNode!.removeChild(node);
  return new TurndownService().turndown(document.body);
}

describe("shutdown reading capacity", () => {
  for (const name of ["live", "expanded"]) it(`${name} keeps every imminent and upcoming card inside 95000 characters`, () => {
    const { document, cards } = cardsOf(pages.get(`${name} /shutdowns`)!);
    const near = cards.filter(card => ["imminent", "upcoming"].includes(card.section));
    assert.ok(near.length > 0);
    const converter = new TurndownService();
    const markdown = markdownOf(document);
    for (const card of near) {
      const content = converter.turndown(card.node);
      const start = markdown.indexOf(content);
      assert.ok(start >= 0 && start + content.length <= 95_000, `${card.node.querySelector("h3")!.textContent}: ${start + content.length}`);
    }
    if (name === "expanded") {
      assert.equal(near.filter(card => card.node.querySelector("h3")!.textContent!.startsWith("Capacity Shutdown ")).length, 25);
      console.log(JSON.stringify({ nearCards: near.length, nearEnd: Math.max(...near.map(card => { const text = converter.turndown(card.node); return markdown.indexOf(text) + text.length; })) }));
    }
  });

  it("preserves every added card's complete description, date and source", () => {
    const { cards } = cardsOf(pages.get("expanded /shutdowns")!);
    for (const record of extra) {
      const card = cards.find(card => card.node.querySelector("h3")!.textContent === record.what_ends);
      assert.ok(card, record.vendor);
      assert.equal(card.node.querySelector(".shutdown-what")!.textContent, record.summary);
      assert.equal(card.node.querySelector(".figure-source")!.getAttribute("href"), record.source_url);
      assert.equal(Date.parse(card.node.querySelectorAll(".shutdown-deadline span")[1].textContent!), Date.parse(record.date));
    }
  });

  it("preserves original cards and all by-month entries above imminent", () => {
    const original = cardsOf(pages.get("live /shutdowns")!);
    const expanded = cardsOf(pages.get("expanded /shutdowns")!);
    const actual = expanded.cards.filter(card => !card.node.querySelector("h3")!.textContent!.startsWith("Capacity Shutdown "));
    for (const section of ["completed", "imminent", "upcoming", "later"]) assert.deepEqual(
      actual.filter(card => card.section === section).map(card => card.node.outerHTML),
      original.cards.filter(card => card.section === section).map(card => card.node.outerHTML));
    const markdown = markdownOf(expanded.document);
    const monthHeading = new TurndownService().turndown(expanded.document.querySelector("#by-month")!);
    const imminentHeading = new TurndownService().turndown(expanded.document.querySelector("#imminent")!);
    assert.ok(markdown.indexOf(monthHeading) >= 0 && markdown.indexOf(monthHeading) < markdown.indexOf(imminentHeading));
    const oldEntries = Array.from(original.document.querySelectorAll(".shutdown-month-entry")).map(node => node.outerHTML);
    const entries = Array.from(expanded.document.querySelectorAll(".shutdown-month-entry"));
    assert.deepEqual(entries.filter(node => !node.textContent!.startsWith("Capacity Shutdown ")).map(node => node.outerHTML), oldEntries);
    for (const record of extra) assert.equal(entries.filter(node => node.textContent!.startsWith(record.what_ends + " (")).length, 1);
  });

  for (const route of ["/shutdowns", "/deadlines", "/pricing-changes"]) it(`omits URL-only link titles on ${route}`, () => {
    const links = Array.from(createDocument(pages.get(`live ${route}`)!).querySelectorAll("a[href]"));
    assert.ok(links.length > 50);
    assert.deepEqual(links.filter(link => link.getAttribute("title") === citationLabel(link.getAttribute("href")!)).map(link => link.outerHTML), []);
  });

  it("uses the heading's profile link without repeating it below the card", () => {
    const { cards } = cardsOf(pages.get("live /shutdowns")!);
    assert.ok(cards.some(card => card.node.querySelector("h3 a[href^='/vendor/']")));
    for (const card of cards) {
      const heading = card.node.querySelector("h3 a");
      if (heading) assert.ok(!Array.from(card.node.querySelectorAll(".shutdown-links a")).some(link => link.getAttribute("href") === heading.getAttribute("href")));
    }
    assert.ok(cards.some(card => card.node.querySelector(".shutdown-links a")));
  });

  it("retains titles that convey a read date or the claim behind a short label", () => {
    const escape = (text: string) => text;
    const read = createDocument(citedSourceLinkHtml({ cited: true, url: "https://example.com/pricing", readOn: today, finding: null, findingEnded: [] }, escape));
    assert.ok(read.querySelector("a")!.getAttribute("title")!.includes(today));
    const claim = createDocument(citedClaimHtml({ vendor: "Example", summary: "The plan ends next month.", source_url: "https://example.com/pricing" }, escape, "Ends", ""));
    assert.ok(claim.querySelector("a")!.getAttribute("title")!.includes("The plan ends next month."));
  });
});
