import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const children: ChildProcess[] = [];
const catalogue = JSON.parse(readFileSync(path.join(root, "data/index.json"), "utf8"));
const koyeb = catalogue.offers.find((offer: { vendor: string }) => offer.vendor === "Koyeb");
assert.ok(koyeb);
const condition = "Koyeb requires a payment method for this hosting plan.";

async function start(index: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(root, "dist/serve.js")], {
      env: { ...process.env, PORT: "0", BASE_URL: "http://localhost", TZ: "UTC", AGENTDEALS_INDEX_PATH: index, AGENTDEALS_REFERRAL_HEALTH: "off" },
      stdio: ["ignore", "ignore", "pipe"],
    });
    children.push(child);
    const timer = setTimeout(() => { child.kill(); reject(new Error("server startup timeout")); }, 40000);
    child.stderr!.on("data", (buffer: Buffer) => {
      const match = buffer.toString().match(/running on http:\/\/localhost:(\d+)/);
      if (match) { clearTimeout(timer); resolve(`http://localhost:${match[1]}`); }
    });
    child.once("error", error => { clearTimeout(timer); reject(error); });
    child.once("exit", code => { clearTimeout(timer); reject(new Error(`server exited ${code}`)); });
  });
}

async function read(base: string, route: string): Promise<string> {
  const response = await fetch(base + route, { redirect: "error" });
  assert.equal(response.status, 200);
  return response.text();
}

describe("the hosting guide keeps Koyeb's legacy plan in its comparison row", () => {
  let directory: string;
  const pages: Array<{ category: string; html: string }> = [];

  before(async () => {
    directory = mkdtempSync(path.join(tmpdir(), "hosting-koyeb-"));
    for (const category of ["Databases", "Cloud Hosting", "Cloud IaaS"]) {
      const record = { ...koyeb, category, service_type: "container_app", conditions: [{
        text: condition, quote: condition, url: koyeb.url, read_on: "2026-10-01",
      }] };
      const index = path.join(directory, `${category.replaceAll(" ", "-")}.json`);
      writeFileSync(index, JSON.stringify({ ...catalogue, offers: [record, ...catalogue.offers.filter((offer: { vendor: string }) => offer.vendor !== "Koyeb")] }));
      const base = await start(index);
      pages.push({ category, html: await read(base, "/hosting-alternatives") });
    }
  });

  after(() => {
    for (const child of children) child.kill();
    if (directory) rmSync(directory, { recursive: true, force: true });
  });

  it("retains exactly one comparison row and its conditions immediately afterward", () => {
    for (const { category, html } of pages) {
      const rows = [...html.matchAll(/<tr\b[^>]*>[\s\S]*?<\/tr>/g)].map(match => match[0]);
      const indices = rows.flatMap((row, index) => row.includes('href="/vendor/koyeb"') ? [index] : []);
      assert.equal(indices.length, 1, category);
      assert.match(rows[indices[0]!]!, /None for new users/);
      assert.match(rows[indices[0]!]!, /No free plan for new users since Feb 2026/);
      const next = rows[indices[0]! + 1]!;
      assert.match(next, /class="vendor-conditions-row"/);
      assert.match(next, /colspan="5"/);
      assert.ok(next.includes(condition), category);
      assert.equal(html.split(condition).length - 1, 1, category);
    }
  });

  it("offers no Koyeb card or structured-data entry as a free alternative", () => {
    for (const { category, html } of pages) {
      const cards = [...html.matchAll(/<div class="alt-card">[\s\S]*?\n      <\/div>/g)].map(match => match[0]);
      assert.ok(cards.some(card => card.includes('href="/vendor/railway"')), category);
      assert.ok(cards.every(card => !card.includes('href="/vendor/koyeb"')), category);
      const itemLists = [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)]
        .map(match => JSON.parse(match[1]!)).filter(value => value["@type"] === "ItemList");
      assert.equal(itemLists.length, 1, category);
      assert.ok(itemLists[0].itemListElement.length > 0, category);
      assert.ok(itemLists[0].itemListElement.every((entry: { item: { name: string } }) => entry.item.name !== "Koyeb"), category);
    }
  });

  it("keeps the same served guide when Koyeb moves between catalogue categories", () => {
    const baseline = pages[0]!.html;
    for (const { category, html } of pages.slice(1)) assert.equal(html, baseline, category);
    assert.doesNotMatch(baseline, /Koyeb<\/a> \(listed under PaaS above\)/);
    assert.match(baseline, /Koyeb<\/a> \(no free plan for new users; Pro from \$29\/mo\)/);
  });
});
