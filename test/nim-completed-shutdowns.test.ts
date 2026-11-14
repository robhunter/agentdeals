import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createDocument } from "@mixmark-io/domino";

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const qwen = "Qwen: qwen/first on 2026-05-12 and qwen/second on 2026-06-11.";
const gemma = "Gemma: google/gemma-3-27b-it on 2026-07-27.";
const future = "Next: example/next retires on 2026-11-15.";
const description = `Retired models include these. ${qwen} ${gemma} ${future}`;
const source = "https://example.com/nim-retirements";
const listing = { vendor: "NVIDIA NIM", tier: "Free", category: "AI / ML", description, url: source, verifiedDate: "2026-10-01", conditions: [] };
const recorded = {
  vendor: "NVIDIA NIM", date: "2026-08-01", recorded_date: "2026-07-01", change_type: "product_deprecated",
  summary: "A separately recorded NIM endpoint retires.", previous_state: "Available", current_state: "Retired",
  source_url: "https://example.com/recorded-endpoint", impact: "high", category: "AI / ML", alternatives: [],
  what_ends: "Recorded endpoint", listing_effect: "none",
};

function cards(html: string) {
  return [...createDocument(html).querySelectorAll(".shutdown-card")].map(node => ({
    name: node.querySelector("h3")!.textContent!.trim(),
    what: node.querySelector(".shutdown-what")!.textContent!.replace(/\s+/g, " ").trim(),
    sentences: [...node.querySelectorAll(".shutdown-what li")].map(li => li.textContent!),
    html: node.outerHTML,
  }));
}

describe("completed NVIDIA endpoint cards", () => {
  let scratch: string;
  const children: ChildProcess[] = [];
  const pages = new Map<string, string>();

  async function serve(day: string, zone = "UTC", input = [listing]): Promise<string> {
    const index = path.join(scratch, `index-${children.length}.json`);
    writeFileSync(index, JSON.stringify({ offers: input }));
    const child = spawn("node", ["--import", path.join(REPO, "scripts/shifted-clock.mjs"), path.join(REPO, "dist/serve.js")], {
      cwd: REPO, stdio: ["ignore", "ignore", "pipe"],
      env: { ...process.env, PORT: "0", BASE_URL: "http://localhost", TZ: zone, AGENTDEALS_REFERRAL_HEALTH: "off",
        AGENTDEALS_CLOCK_SHIFT_MS: String(Date.parse(day + "T12:00:00Z") - Date.now()),
        AGENTDEALS_INDEX_PATH: index, AGENTDEALS_CHANGES_PATH: path.join(scratch, "changes.json") },
    });
    children.push(child);
    const port = await new Promise<string>((resolve, reject) => {
      const timeout = setTimeout(() => { child.kill(); reject(new Error("Server startup timeout")); }, 30000);
      let stderr = "";
      child.stderr!.on("data", chunk => {
        stderr += chunk;
        const match = stderr.match(/running on http:\/\/localhost:(\d+)/);
        if (match) { clearTimeout(timeout); resolve(match[1]); }
      });
      child.on("error", error => { clearTimeout(timeout); reject(error); });
      child.on("exit", code => { clearTimeout(timeout); reject(new Error(`Server exited ${code}: ${stderr}`)); });
    });
    const response = await fetch(`http://localhost:${port}/shutdowns`, { redirect: "error" });
    assert.equal(response.status, 200);
    return response.text();
  }

  before(async () => {
    scratch = mkdtempSync(path.join(tmpdir(), "nim-shutdowns-"));
    writeFileSync(path.join(scratch, "changes.json"), JSON.stringify({ changes: [recorded] }));
    for (const day of ["2026-05-01", "2026-11-14", "2026-11-15", "2026-11-16"]) pages.set(day, await serve(day));
    pages.set("west", await serve("2026-11-15", "America/Los_Angeles"));
    pages.set("empty", await serve("2026-11-16", "UTC", []));
    pages.set("other", await serve("2026-11-16", "UTC", [{ ...listing, vendor: "Other Inference" }]));
  });

  after(async () => {
    await Promise.all(children.map(child => new Promise<void>(resolve => {
      if (child.exitCode !== null || child.signalCode !== null) return resolve();
      child.once("exit", () => resolve());
      child.kill("SIGKILL");
    })));
    if (scratch) rmSync(scratch, { recursive: true, force: true });
  });

  it("prints each completed family sentence once with its model IDs, dates and source", () => {
    const groups = cards(pages.get("2026-11-14")!).filter(card => card.sentences.length > 0);
    assert.equal(groups.length, 1);
    assert.equal(groups[0].name, "NVIDIA NIM");
    assert.equal(groups[0].sentences.length, 2);
    for (const sentence of [qwen, gemma]) assert.equal(groups[0].sentences.filter(text => text.startsWith(sentence)).length, 1);
    assert.equal((groups[0].html.match(/href="https:\/\/example.com\/nim-retirements"/g) ?? []).length, 3);
    assert.ok(!groups[0].what.includes("example/next"));
  });

  it("keeps a future retirement separate through its UTC date and groups it on the next day", () => {
    for (const day of ["2026-11-14", "2026-11-15", "west"]) {
      const nim = cards(pages.get(day)!).filter(card => card.name === "NVIDIA NIM");
      assert.equal(nim.length, 2, day);
      assert.equal(nim.filter(card => card.sentences.length === 0 && card.what === future).length, 1, day);
      assert.ok(!nim.find(card => card.sentences.length > 0)!.what.includes("example/next"), day);
    }
    const nim = cards(pages.get("2026-11-16")!).filter(card => card.name === "NVIDIA NIM");
    assert.equal(nim.length, 1);
    assert.equal(nim[0].sentences.length, 3);
    assert.ok(nim[0].sentences.some(text => text.startsWith(future)));
  });

  it("does not create a group when all listing retirements are future or the listing is absent", () => {
    for (const key of ["2026-05-01", "empty"]) assert.equal(cards(pages.get(key)!).filter(card => card.sentences.length > 0).length, 0, key);
    assert.equal(cards(pages.get("2026-05-01")!).filter(card => card.name === "NVIDIA NIM").length, 4);
    assert.equal(cards(pages.get("empty")!).filter(card => card.name === "NVIDIA NIM").length, 0);
  });

  it("keeps separately recorded NIM retirements unchanged", () => {
    const originals = [...pages.values()].map(page => cards(page).filter(card => card.name === "Recorded endpoint"));
    for (const found of originals) {
      assert.equal(found.length, 1);
      assert.equal(found[0].what, recorded.summary);
      assert.match(found[0].html, /href="https:\/\/example.com\/recorded-endpoint"/);
      assert.equal(found[0].sentences.length, 0);
    }
  });

  it("keeps another vendor's completed listing dates in separate cards", () => {
    const other = cards(pages.get("other")!).filter(card => card.name === "Other Inference");
    assert.equal(other.length, 4);
    assert.equal(other.filter(card => card.what === qwen).length, 2);
    assert.ok(other.every(card => card.sentences.length === 0));
  });

  it("keeps structured data descriptions aligned with the grouped card", () => {
    const page = pages.get("2026-11-16")!;
    const lists = [...createDocument(page).querySelectorAll('script[type="application/ld+json"]')].map(node => JSON.parse(node.textContent!));
    const list = lists.find(value => value["@type"] === "ItemList");
    const group = list.itemListElement.filter((value: {name: string}) => value.name === "NVIDIA NIM");
    assert.equal(group.length, 1);
    assert.equal(group[0].description, [qwen, gemma, future].join(" "));
    assert.equal(list.numberOfItems, cards(page).length);
  });
});
