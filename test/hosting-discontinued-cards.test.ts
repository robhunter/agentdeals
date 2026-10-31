import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const subjects = ["Render", "Netlify", "Val Town", "Google Cloud Run", "Oracle Cloud"];
const today = new Date().toISOString().slice(0, 10);
const tomorrow = new Date(Date.parse(today) + 86400000).toISOString().slice(0, 10);
type Server = { process: ChildProcess; base: string };
const servers: Server[] = [];

async function startServer(changes: string): Promise<Server> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(root, "dist/serve.js")], {
      env: { ...process.env, PORT: "0", BASE_URL: "http://localhost", TZ: "UTC", AGENTDEALS_CHANGES_PATH: changes, AGENTDEALS_REFERRAL_HEALTH: "off" },
      stdio: ["ignore", "ignore", "pipe"],
    });
    const timeout = setTimeout(() => { child.kill(); reject(new Error("Server startup timeout")); }, 40000);
    child.stderr!.on("data", (chunk: Buffer) => {
      const match = chunk.toString().match(/running on http:\/\/localhost:(\d+)/);
      if (match) {
        clearTimeout(timeout);
        const server = { process: child, base: `http://localhost:${match[1]}` };
        servers.push(server);
        resolve(server);
      }
    });
    child.once("error", error => { clearTimeout(timeout); reject(error); });
    child.once("exit", code => { clearTimeout(timeout); reject(new Error(`Server exited with ${code}`)); });
  });
}

async function read(server: Server, route: string): Promise<string> {
  const response = await fetch(server.base + route, { redirect: "error" });
  assert.equal(response.status, 200);
  return response.text();
}

function cards(html: string): Map<string, string> {
  return new Map([...html.matchAll(/<div class="alt-card">[\s\S]*?\n      <\/div>/g)].map(([card]) => {
    const name = card.match(/class="alt-card-name">([^<]+)<\/a>/)?.[1];
    assert.ok(name, "each card names its vendor");
    return [name, card];
  }));
}

function normalized(card: string, base: string): string {
  return card.replaceAll(base, "BASE");
}

describe("discontinued hosting cards", () => {
  let directory: string;
  let baseline: Server;
  let ended: Server;
  let future: Server;
  let baseCards: Map<string, string>;
  let endedCards: Map<string, string>;

  before(async () => {
    directory = mkdtempSync(path.join(tmpdir(), "hosting-discontinued-"));
    const store = JSON.parse(readFileSync(path.join(root, "data/deal_changes.json"), "utf8"));
    const record = (vendor: string, discontinued_date: string) => ({
      vendor, date: today, recorded_date: today, date_source: "vendor_page", change_type: "product_deprecated",
      summary: `${vendor} shuts down.`, previous_state: "Available", current_state: "Discontinued",
      discontinued_date, listing_effect: "ends", impact: "high", category: "Cloud Hosting",
      source_url: "https://example.com/shutdown", alternatives: [],
    });
    const start = async (name: string, changes: unknown[]) => {
      const file = path.join(directory, `${name}.json`);
      writeFileSync(file, JSON.stringify({ ...store, changes }));
      return startServer(file);
    };
    baseline = await start("baseline", []);
    ended = await start("ended", subjects.map(vendor => record(vendor, today)));
    future = await start("future", subjects.map(vendor => record(vendor, tomorrow)));
    baseCards = cards(await read(baseline, "/hosting-alternatives"));
    endedCards = cards(await read(ended, "/hosting-alternatives"));
    assert.ok(baseCards.size > subjects.length);
  });

  after(() => {
    for (const server of servers) server.process.kill();
    if (directory) rmSync(directory, { recursive: true, force: true });
  });

  for (const vendor of subjects) {
    it(`${vendor} replaces its offer with the vendor page's discontinued sentence on the shutdown day`, async () => {
      const card = endedCards.get(vendor);
      assert.ok(card, `${vendor} retains its card`);
      const sentence = `${vendor} was discontinued on ${today}, so it is not a current option.`;
      assert.equal(card.match(/<p class="alt-card-desc">([\s\S]*?)<\/p>/)![1], sentence);
      const slug = card.match(/href="\/vendor\/([^"]+)"/)![1];
      const vendorPage = await read(ended, `/vendor/${slug}`);
      assert.ok(vendorPage.includes(sentence.slice(0, -1)));
      assert.doesNotMatch(card, /alt-card-tier|https?:\/\/|Pricing|sponsored|listing-condition/);
      assert.ok(card.includes(`href="/vendor/${slug}">Full profile`));
      assert.ok(card.includes(`href="/alternative-to/${slug}">Alternatives`));
      assert.deepEqual([...card.matchAll(/href="([^"]+)"/g)].map(match => match[1]), [
        `/vendor/${slug}`, `/vendor/${slug}`, `/alternative-to/${slug}`,
      ]);
      const before = baseCards.get(vendor)!;
      assert.ok(before.includes('class="alt-card-tier"'));
      assert.notEqual(card, before);
    });
  }

  it("preserves the active control and every other card byte for byte", () => {
    assert.ok(baseCards.has("Railway"));
    assert.deepEqual([...endedCards.keys()], [...baseCards.keys()]);
    for (const [vendor, card] of baseCards) {
      if (subjects.includes(vendor)) continue;
      assert.equal(normalized(endedCards.get(vendor)!, ended.base), normalized(card, baseline.base), vendor);
    }
  });

  it("preserves current offers before the shutdown date", async () => {
    const futureCards = cards(await read(future, "/hosting-alternatives"));
    assert.deepEqual([...futureCards.keys()], [...baseCards.keys()]);
    for (const vendor of subjects) {
      const card = futureCards.get(vendor)!;
      const original = baseCards.get(vendor)!;
      assert.ok(card.includes(original.match(/<span class="alt-card-tier">[^<]+<\/span>/)![0]), vendor);
      assert.ok(card.includes(original.match(/<p class="alt-card-desc">([^<]+)/)![1]), vendor);
      assert.ok(card.includes(original.match(/<div class="alt-card-links">[\s\S]*?<\/div>/)![0]), vendor);
      assert.doesNotMatch(card, /was discontinued on/);
    }
  });
});
