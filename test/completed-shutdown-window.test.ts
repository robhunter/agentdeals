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

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const today = new Date().toISOString().slice(0, 10);
const day = (offset: number) => new Date(Date.parse(today) + offset * 86_400_000).toISOString().slice(0, 10);
const stored = JSON.parse(readFileSync(path.join(ROOT, "data/deal_changes.json"), "utf8"));
const extra = Array.from({ length: 30 }, (_, i) => ({
  vendor: `Window Future ${i}`, what_ends: `Window Future ${i} API`, date: day(1 + i * 7),
  discontinued_date: day(1 + i * 7), date_source: "vendor_page", recorded_date: today,
  change_type: "product_deprecated", summary: `Window Future ${i} retires its API on ${day(1 + i * 7)}. ${"Migration details. ".repeat(50)}`,
  previous_state: "API available", current_state: "API retired", impact: "high", category: "APIs",
  source_url: `https://example.com/window/${i}`, alternatives: [], listing_effect: "none",
}));
const boundary = [1, 30, 31, 183, 184].map(offset => ({ ...extra[0], vendor: `Window Past ${offset}`, what_ends: `Window Past ${offset} API`,
  date: day(-offset), recorded_date: day(-offset - 1), discontinued_date: day(-offset), summary: `Window Past ${offset} retired its API on ${day(-offset)}. Full migration details remain available.` }));
const scratch = mkdtempSync(path.join(tmpdir(), "shutdown-window-"));
const pages = new Map<string, string>();

async function readPages(name: string, records: unknown[], indexPath?: string) {
  const filename = path.join(scratch, `${name}.json`);
  writeFileSync(filename, JSON.stringify({ ...stored, changes: records }, null, 2) + "\n");
  const child = spawn("node", [path.join(ROOT, "dist/serve.js")], {
    cwd: ROOT, stdio: ["ignore", "ignore", "pipe"],
    env: { ...process.env, TZ: "UTC", PORT: "0", BASE_URL: "http://localhost", AGENTDEALS_REFERRAL_HEALTH: "off", AGENTDEALS_CHANGES_PATH: filename, ...(indexPath ? { AGENTDEALS_INDEX_PATH: indexPath } : {}) },
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
    for (const route of ["/shutdowns", "/changes"]) {
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
  await readPages("expanded", [...stored.changes, ...extra, ...boundary]);
  const indexPath = path.join(scratch, "conditioned-index.json");
  const offers = ["Whole", "Excerpt", "Empty", "NVIDIA NIM"].map(vendor => ({
    vendor, category: "APIs", tier: "Free", url: `https://example.com/${vendor.replaceAll(" ", "-")}`, verifiedDate: today,
    description: `${vendor} endpoint retires on ${day(-40)}.${vendor === "Excerpt" ? " Other endpoints remain available." : ""}`,
    conditions: vendor === "Empty" ? [] : [{ text: `${vendor} accepts existing customers only.`, quote: "Existing customers only.", url: "https://example.com/terms", read_on: today }],
  }));
  writeFileSync(indexPath, JSON.stringify({ offers }));
  await readPages("conditions", [], indexPath);

});
after(() => rmSync(scratch, { recursive: true, force: true }));

function cardsOf(html: string) {
  const document = createDocument(html);
  let section = "";
  const cards: { section: string; node: Element; date: number }[] = [];
  for (const node of Array.from(document.querySelector(".container")!.children)) {
    if (node.tagName === "H2") section = node.id === "completed-history" ? "completed" : node.id;
    if (node.classList.contains("shutdown-card")) {
      const dates = [...node.querySelectorAll(".shutdown-deadline")].map(deadline => Date.parse(deadline.querySelectorAll("span")[1].textContent!));
      assert.ok(dates.length > 0 && dates.every(Number.isFinite));
      cards.push({ section, node, date: Math.max(...dates) });
    }
  }
  return { document, cards };
}

describe("completed shutdown reading window", () => {
  for (const name of ["live", "expanded"]) it(`${name} keeps every completed shutdown from the last 183 days inside the reading window`, () => {
    const { document, cards } = cardsOf(pages.get(`${name} /shutdowns`)!);
    const recent = cards.filter(card => card.section === "completed" && card.date >= Date.parse(day(-183)));
    assert.ok(recent.length > 0);
    for (const node of document.querySelectorAll("head, script, style")) node.parentNode!.removeChild(node);
    const converter = new TurndownService();
    const markdown = converter.turndown(document.body);
    for (const card of recent) {
      const link = [...document.querySelectorAll(".shutdown-completed-entry")].find(node => node.querySelector("a")!.getAttribute("href") === `#${card.node.id}`);
      const content = converter.turndown(link ?? card.node);
      const start = markdown.indexOf(content);
      assert.ok(start >= 0 && start + content.length <= 100_000, `${card.node.querySelector("h3")!.textContent}: ${start + content.length}`);
    }
    if (name === "expanded") {
      for (const offset of [1, 30, 31, 183]) assert.ok(recent.some(card => card.node.querySelector("h3")!.textContent === `Window Past ${offset} API`));
      assert.ok(!recent.some(card => card.node.querySelector("h3")!.textContent === "Window Past 184 API"));
      assert.equal(cards.filter(card => card.node.querySelector("h3")!.textContent!.startsWith("Window Future ")).length, 30);
    }
  });

  it("carries conditions beside a complete listing description in a completed entry", () => {
    const { document } = cardsOf(pages.get("conditions /shutdowns")!);
    const lines = [...document.querySelectorAll(".shutdown-completed-entry")];
    for (const vendor of ["Whole", "Excerpt", "Empty", "NVIDIA NIM"]) {
      const line = lines.find(node => node.querySelector("a")!.textContent === vendor)!;
      assert.ok(line, vendor);
      const conditions = line.querySelectorAll(".listing-conditions");
      assert.equal(conditions.length, ["Whole", "NVIDIA NIM"].includes(vendor) ? 1 : 0, vendor);
      if (conditions.length) assert.ok(conditions[0].textContent!.includes(`${vendor} accepts existing customers only.`));
      assert.equal(line.querySelectorAll(".completed-summary .listing-conditions").length, 0);
      if (vendor === "Excerpt") assert.ok(!line.textContent!.includes("Other endpoints remain available."));
    }
  });

  it("keeps the thirty-day boundary in full above imminent", () => {
    const { document, cards } = cardsOf(pages.get("expanded /shutdowns")!);
    const children = Array.from(document.querySelector(".container")!.children);
    for (const offset of [1, 30, 31, 183, 184]) {
      const card = cards.find(card => card.node.querySelector("h3")!.textContent === `Window Past ${offset} API`)!;
      assert.ok(card);
      assert.equal(children.indexOf(card.node) < children.indexOf(document.querySelector("#imminent")!), offset <= 30);
    }
  });

  it("retains every original card's full text and order within its section when future records are added", () => {
    const original = cardsOf(pages.get("live /shutdowns")!).cards;
    const expanded = cardsOf(pages.get("expanded /shutdowns")!).cards.filter(card => !card.node.querySelector("h3")!.textContent!.startsWith("Window "));
    for (const section of ["completed", "imminent", "upcoming", "later"]) assert.deepEqual(
      expanded.filter(card => card.section === section).map(card => card.node.outerHTML),
      original.filter(card => card.section === section).map(card => card.node.outerHTML), section);
  });

  it("keeps all thirty future cards complete, cited and in date order", () => {
    const cards = cardsOf(pages.get("expanded /shutdowns")!).cards.filter(card => card.node.querySelector("h3")!.textContent!.startsWith("Window Future "));
    assert.deepEqual(cards.map(card => card.node.querySelector("h3")!.textContent), extra.map(record => record.what_ends));
    for (const [i, card] of cards.entries()) {
      assert.equal(card.node.querySelector(".shutdown-what")!.textContent, extra[i].summary);
      assert.equal(card.node.querySelector(".figure-source")!.getAttribute("href"), extra[i].source_url);
      assert.equal(card.date, Date.parse(extra[i].date));
    }
  });

  it("retains every original by-month entry when future records are added", () => {
    const entries = (name: string) => [...cardsOf(pages.get(`${name} /shutdowns`)!).document.querySelectorAll(".shutdown-month-entry")]
      .filter(node => !node.textContent!.startsWith("Window Future ")).map(node => node.outerHTML);
    assert.deepEqual(entries("expanded"), entries("live"));
  });

  it("identifies the full card for each completed month entry", () => {
    const { document } = cardsOf(pages.get("expanded /shutdowns")!);
    const entries = Array.from(document.querySelectorAll(".shutdown-month-entry[data-card]"));
    assert.ok(entries.length > 0);
    for (const entry of entries) {
      const card = document.getElementById(entry.getAttribute("data-card")!);
      assert.ok(card?.classList.contains("shutdown-card"));
    }
  });

  it("keeps every added completed shutdown and its complete record", () => {
    const { cards } = cardsOf(pages.get("expanded /shutdowns")!);
    const log = createDocument(pages.get("expanded /changes")!);
    for (const record of boundary) {
      const card = cards.find(card => card.section === "completed" && card.node.querySelector("h3")!.textContent === record.what_ends);
      assert.ok(card, record.vendor);
      assert.equal(card.node.querySelector(".shutdown-what")!.textContent, record.summary);
      assert.ok([...log.querySelectorAll(".chg-summary")].some(node => node.textContent!.startsWith(record.summary)), record.vendor);
    }
  });
});
