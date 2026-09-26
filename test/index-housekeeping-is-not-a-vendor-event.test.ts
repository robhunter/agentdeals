import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { assertPopulationFloor } from "./population-floor.ts";
import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  isIndexHousekeeping,
  trackedChanges,
  INDEX_SWEEP_STATE,
  INDEX_HOUSEKEEPING_CLASS,
  INDEX_HOUSEKEEPING_BADGE,
  INDEX_HOUSEKEEPING_NOTE,
} from "../dist/change-census.js";
import { reportsOurIndex } from "../dist/change-reporting.js";
import { isNoLongerInForce } from "../dist/change-resolution.js";
import { statesWhenItTookEffect } from "./effective-date-rule.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(__dirname, "..");

interface StoredChange {
  vendor: string;
  date: string;
  date_source: string;
  recorded_date?: string;
  summary: string;
  change_type: string;
  current_state: string;
  source_url?: string;
  reports?: string;
  resolution?: { state: string } | null;
}

const WEEK_15_2026 = { start: "2026-04-06", end: "2026-04-12" };

function getWeek15Tracked(): number {
  return storedChanges().filter(
    c =>
      c.date >= WEEK_15_2026.start
      && c.date <= WEEK_15_2026.end
      && statesWhenItTookEffect(c)
      && !isNoLongerInForce(c)
      && !isIndexHousekeeping(c),
  ).length;
}

function storedChanges(): StoredChange[] {
  const raw = JSON.parse(readFileSync(path.join(REPO, "data", "deal_changes.json"), "utf8"));
  return Array.isArray(raw) ? raw : raw.changes;
}

function startServer(): Promise<{ proc: ChildProcess; port: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn("node", [path.join(REPO, "dist", "serve.js")], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, PORT: "0", BASE_URL: "http://localhost:3000" },
    });
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error("Server startup timeout"));
    }, 60000);
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
}

describe("a record of our own index", () => {
  it("is the population the census rule already names, and every one of them says so in its own fields", () => {
    const stored = storedChanges();
    const housekeeping = stored.filter(isIndexHousekeeping);
    assertPopulationFloor(housekeeping.length, 20, "records whose current_state is the index sweep state");

    for (const change of housekeeping) {
      assert.strictEqual(change.current_state, INDEX_SWEEP_STATE, change.vendor);
      assert.ok(reportsOurIndex(change as never), `${change.vendor} does not declare that it reports our own index`);
      assert.ok(
        !change.source_url,
        `${change.vendor} reports our own index and cites ${change.source_url}, which is a vendor page it cannot have`,
      );
    }

    assert.strictEqual(
      stored.filter(c => reportsOurIndex(c as never)).length,
      housekeeping.length,
      "a record declares it reports our own index and the census rule does not agree",
    );
    assert.strictEqual(trackedChanges(stored).some(isIndexHousekeeping), false);
  });
});

describe("the surfaces a reader takes for vendor market activity", () => {
  let proc: ChildProcess | null = null;
  let port = 0;

  before(async () => {
    const started = await startServer();
    proc = started.proc;
    port = started.port;
  });

  after(() => {
    proc?.kill();
  });

  async function body(route: string): Promise<string> {
    const res = await fetch(`http://localhost:${port}${route}`);
    assert.strictEqual(res.status, 200, route);
    return res.text();
  }

  function entries(page: string): { classes: string; html: string }[] {
    return [...page.matchAll(/<div class="(chg-entry[^"]*)"[^>]*>([\s\S]*?)(?=\n      <div class="chg-entry|\n    <\/div>)/g)]
      .map(([, classes, html]) => ({ classes, html }));
  }

  it("marks a record of our own index in the change log rather than leaving it to read as a vendor event", async () => {
    const page = await body("/changes");
    const rendered = entries(page);
    assertPopulationFloor(rendered.length, 100, "entries the change log renders");

    const vendors = new Set(storedChanges().filter(isIndexHousekeeping).map(c => c.vendor));
    const marked = rendered.filter(e => e.classes.includes(INDEX_HOUSEKEEPING_CLASS));
    assert.strictEqual(marked.length, vendors.size, "the change log marks a different number of entries than we hold");

    for (const entry of marked) {
      assert.ok(
        entry.html.includes(INDEX_HOUSEKEEPING_BADGE),
        `an entry of our own index carries no badge saying so: ${entry.html.slice(0, 200)}`,
      );
      assert.ok(
        entry.html.includes(INDEX_HOUSEKEEPING_NOTE.slice(0, 60)),
        `an entry of our own index carries no note saying the vendor's terms did not move`,
      );
      assert.ok(
        !/>deprecated</.test(entry.html),
        `an entry of our own index is badged as the vendor deprecating a product: ${entry.html.slice(0, 200)}`,
      );
    }
  });

  it("does not headline a live product as deprecated in the change log's structured data", async () => {
    const page = await body("/changes");
    const jsonLd = JSON.parse(page.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)![1]);
    const headlines: string[] = jsonLd.itemListElement.map((i: { item: { headline: string } }) => i.item.headline);
    assertPopulationFloor(headlines.length, 20, "headlines the change log publishes as structured data");

    const vendors = new Set(storedChanges().filter(isIndexHousekeeping).map(c => c.vendor));
    for (const vendor of vendors) {
      assert.ok(
        !headlines.includes(`${vendor}: deprecated`),
        `${vendor} is headlined as deprecated, and the record saying so is our own index housekeeping`,
      );
    }
  });

  it("marks a record of our own index on the filterable log too", async () => {
    const page = await body("/pricing-changes");
    const rendered = [...page.matchAll(/<div class="(pc-entry[^"]*)"/g)];
    assertPopulationFloor(rendered.length, 100, "entries the filterable log renders");

    const held = storedChanges().filter(isIndexHousekeeping).length;
    const marked = rendered.filter(([, classes]) => classes.includes(INDEX_HOUSEKEEPING_CLASS));
    assert.strictEqual(marked.length, held, "the filterable log marks a different number of entries than we hold");
    assert.ok(
      page.includes(INDEX_HOUSEKEEPING_BADGE),
      "the filterable log badges a record of our own index as something the vendor did",
    );
  });

  it("leaves a week's digest counting only what a vendor did that week", async () => {
    const swept = storedChanges().filter(isIndexHousekeeping);
    assertPopulationFloor(swept.length, 20, "records of our own index the digest could have counted");
    const sentence = swept[0].summary as unknown as string;

    const page = await body("/digest/2026-w15");
    assert.ok(
      !page.includes(sentence),
      "the week's digest publishes our own index housekeeping as developer tool pricing changes",
    );
    const stated = page.match(/<strong>(\d+)<\/strong> changes/);
    assert.ok(stated, "the digest states no figure for the week");
    assert.strictEqual(
      parseInt(stated[1], 10),
      getWeek15Tracked(),
      "the digest counts a different number than the week holds once our own index is set aside",
    );
  });

  it("counts only tracked changes into the Q2 preview's confirmed figure", async () => {
    const page = await body("/q2-pricing-preview-2026");
    const stored = storedChanges();
    const inWindow = (changes: StoredChange[]) =>
      changes.filter(c => c.date >= "2026-03-25" && c.date <= "2026-06-30").length;
    const confirmed = inWindow(trackedChanges(stored) as StoredChange[]);
    const held = inWindow(stored);
    assertPopulationFloor(confirmed, 100, "changes whose terms took effect in the window the preview covers");
    assert.ok(held > confirmed, "the window holds nothing that is not a tracked change, so this proves nothing");

    assert.ok(
      page.includes(`${confirmed} confirmed changes`),
      `the preview does not state the ${confirmed} tracked changes in its window`,
    );
    assert.ok(
      !page.includes(`${held} confirmed changes`),
      `the preview counts all ${held} records in its window as confirmed changes`,
    );
    const swept = stored.filter(isIndexHousekeeping);
    const sweptSummaries = new Set(swept.map(c => c.summary as unknown as string));
    assert.strictEqual(sweptSummaries.size, 1, "the sweep is no longer one act with one sentence");
    const [sentence] = [...sweptSummaries];
    assert.ok(
      !page.includes(sentence),
      "the preview renders a record of our own index as a vendor pricing event",
    );
    for (const markup of ['<div class="change-card"', '<div class="timeline-item"']) {
      assert.strictEqual(
        page.split(markup).length - 1,
        confirmed,
        `the preview renders a different number of ${markup} than the ${confirmed} tracked changes in its window`,
      );
    }
  });
});
