import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(__dirname, "..");

const TODAY = new Date().toISOString().slice(0, 10);
const dayOffset = (days: number) =>
  new Date(Date.parse(TODAY) + days * 86400000).toISOString().slice(0, 10);

const UPCOMING = "Fauna";
const UPCOMING_DATE = dayOffset(20);
const RECENT = "Neon";
const RECENT_DATE = dayOffset(-5);
const DISCOVERY = "Xata";
const BACKLOG_SIZE = 60;
const LIST_CAP = 50;
const ROUTES = ["/", "/changes", "/expiring"];

function change(vendor: string, date: string, dateSource: string) {
  return {
    vendor,
    change_type: "limits_reduced",
    date,
    date_source: dateSource,
    summary: `${vendor} free allowance cut.`,
    previous_state: "15 GB storage",
    current_state: "5 GB storage",
    impact: "high",
    source_url: `https://example.com/${vendor.toLowerCase()}/pricing`,
    category: "Databases",
    alternatives: [],
    recorded_date: date,
  };
}

function fixtureChanges() {
  const backlog = Array.from({ length: BACKLOG_SIZE }, (_, i) =>
    change(`Backlog${String(i).padStart(2, "0")}`, dayOffset(-100 - i), "vendor_page")
  );
  return [
    ...backlog,
    change(UPCOMING, UPCOMING_DATE, "vendor_page"),
    change(RECENT, RECENT_DATE, "vendor_page"),
    { ...change(DISCOVERY, TODAY, "discovered"), detected_by: "reverify-ai" },
  ];
}

type Item = { "@type": string; headline?: string; datePublished?: string };

function changeList(html: string, route: string): { numberOfItems: number; items: Item[] } {
  const lists: { numberOfItems: number; items: Item[] }[] = [];
  for (const block of html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)) {
    const json = JSON.parse(block[1]);
    if (json["@type"] !== "ItemList" || !Array.isArray(json.itemListElement)) continue;
    const items: Item[] = json.itemListElement.map((el: any, i: number) => {
      assert.strictEqual(el.position, i + 1, `${route} numbered its list positions out of order`);
      return el.item;
    });
    if (!items.every((it) => it["@type"] === "Article" || it["@type"] === "NewsArticle")) continue;
    lists.push({ numberOfItems: json.numberOfItems, items });
  }
  assert.strictEqual(lists.length, 1, `expected exactly one change list in the structured data on ${route}`);
  return lists[0];
}

function itemFor(list: { items: Item[] }, vendor: string, route: string): Item {
  const found = list.items.find((it) => it.headline?.startsWith(`${vendor}:`));
  assert.ok(found, `${route} left ${vendor} out of its structured data entirely`);
  return found!;
}

describe("the machine-readable change lists carry the entries the pages carry", () => {
  let tmp: string;
  let proc: ChildProcess;
  const bodies = new Map<string, string>();

  before(async () => {
    tmp = mkdtempSync(path.join(tmpdir(), "change-structured-data-"));
    const changesPath = path.join(tmp, "changes.json");
    writeFileSync(changesPath, JSON.stringify({ changes: fixtureChanges() }, null, 2));
    const started = await new Promise<{ proc: ChildProcess; port: number }>((resolve, reject) => {
      const child = spawn("node", [path.join(REPO, "dist", "serve.js")], {
        stdio: ["pipe", "pipe", "pipe"],
        env: {
          ...process.env,
          PORT: "0",
          BASE_URL: "http://localhost:3000",
          AGENTDEALS_CHANGES_PATH: changesPath,
        },
      });
      const timeout = setTimeout(() => {
        child.kill();
        reject(new Error("Server startup timeout"));
      }, 30000);
      child.stderr!.on("data", (data: Buffer) => {
        const m = data.toString().match(/running on http:\/\/localhost:(\d+)/);
        if (m) {
          clearTimeout(timeout);
          resolve({ proc: child, port: parseInt(m[1], 10) });
        }
      });
      child.on("error", (err) => {
        clearTimeout(timeout);
        reject(err);
      });
    });
    proc = started.proc;
    for (const route of ROUTES) {
      bodies.set(route, await (await fetch(`http://localhost:${started.port}${route}`)).text());
    }
  });

  after(() => {
    if (proc) proc.kill();
    if (tmp) rmSync(tmp, { recursive: true, force: true });
  });

  for (const route of ROUTES) {
    it(`states the effective date of a dated entry on ${route}`, () => {
      assert.strictEqual(
        itemFor(changeList(bodies.get(route)!, route), UPCOMING, route).datePublished,
        UPCOMING_DATE,
        `${route} dropped the effective date from an entry that has one`
      );
    });

    it(`lists an entry whose effective date is unknown on ${route}, without inventing one`, () => {
      const discovery = itemFor(changeList(bodies.get(route)!, route), DISCOVERY, route);
      assert.ok(
        !("datePublished" in discovery),
        `${route} published the day we looked as the day the terms changed`
      );
    });
  }

  it("counts the entry it could not date in the total it advertises", () => {
    const list = changeList(bodies.get("/expiring")!, "/expiring");
    assert.strictEqual(list.items.length, 3);
    assert.strictEqual(list.numberOfItems, 3);
  });

  it("gives /expiring's structured data every section its page renders, not only the two it listed", () => {
    const body = bodies.get("/expiring")!;
    for (const heading of ["Recently Changed", "Recently Discovered"]) {
      assert.ok(body.includes(heading), `/expiring did not render its ${heading} section, so the list below proves nothing`);
    }
    const list = changeList(body, "/expiring");
    for (const vendor of [UPCOMING, RECENT, DISCOVERY]) itemFor(list, vendor, "/expiring");
  });

  it("does not let a backlog of dated entries crowd a new discovery out of the list", () => {
    const list = changeList(bodies.get("/changes")!, "/changes");
    assert.strictEqual(
      list.items.length,
      LIST_CAP,
      "the list is not at its cap, so nothing is being crowded out"
    );
    assert.ok(
      list.items.filter((it) => it.headline?.startsWith("Backlog")).length > 10,
      "the list holds almost no dated entries, so the presence below proves nothing"
    );
    itemFor(list, DISCOVERY, "/changes");
  });

  it("orders the list by the date each entry carries, newest first", () => {
    const list = changeList(bodies.get("/changes")!, "/changes");
    assert.strictEqual(list.items[0].headline?.startsWith(`${UPCOMING}:`), true);
    assert.strictEqual(list.items[1].headline?.startsWith(`${DISCOVERY}:`), true);
  });

  it("advertises a total that counts every entry, not only the page of them it shows", () => {
    assert.strictEqual(
      changeList(bodies.get("/changes")!, "/changes").numberOfItems,
      fixtureChanges().length
    );
  });
});
