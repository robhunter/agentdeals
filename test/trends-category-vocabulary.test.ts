import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getCategories, loadDealChanges } from "../dist/data.js";
import { trackedChanges } from "../dist/change-census.js";
import { CATEGORY_ALIASES, CHANGE_LOG_CATEGORY_NAMES, resolveChangeCategory } from "../dist/category-scope.js";
import { isOurOwnBookkeeping } from "../dist/vendor-verdict.js";
import { NEGATIVE_CHANGE_TYPES, POSITIVE_CHANGE_TYPES } from "../dist/change-direction.js";
import { toSlug } from "../dist/slug.js";
import { assertPopulationFloor } from "./population-floor.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const publishedCategories = () => new Set(getCategories().map((c: { name: string }) => c.name));

const countedByATrendPage = () =>
  trackedChanges(loadDealChanges()).filter((c: { change_type: string }) => !isOurOwnBookkeeping(c));

describe("the change log files every record under a category we publish", () => {
  it("resolves every category the change log uses to a published name", () => {
    const published = publishedCategories();
    const used = [...new Set(loadDealChanges().map((c: { category: string }) => c.category))];
    assertPopulationFloor(used.length, 40, "category names the change log uses");
    const unresolved = used
      .filter((name) => !published.has(resolveChangeCategory(name)))
      .map((name) => `${name} resolves to ${resolveChangeCategory(name)}`);
    assert.deepStrictEqual(unresolved, []);
  });

  it("gives every published category a slug of its own", () => {
    const bySlug = new Map<string, string[]>();
    for (const name of publishedCategories()) {
      const slug = toSlug(name);
      bySlug.set(slug, [...(bySlug.get(slug) ?? []), name]);
    }
    const shared = [...bySlug.entries()].filter(([, names]) => names.length > 1);
    assert.deepStrictEqual(shared, []);
  });

  it("points every declared name at a category we publish", () => {
    const published = publishedCategories();
    const declared = Object.entries({ ...CATEGORY_ALIASES, ...CHANGE_LOG_CATEGORY_NAMES }) as Array<[string, string]>;
    assert.ok(declared.length > 0, "nothing is declared, so the mapping proves nothing");
    const broken = declared
      .filter(([from, to]) => !published.has(to) || published.has(from))
      .map(([from, to]) => `${from} -> ${to}`);
    assert.deepStrictEqual(broken, []);
  });

  it("sends two spellings of one category to one slug and one published name", () => {
    assert.strictEqual(toSlug("AI/ML"), toSlug("AI / ML"));
    assert.strictEqual(resolveChangeCategory("AI/ML"), resolveChangeCategory("AI / ML"));
    assert.ok(publishedCategories().has(resolveChangeCategory("AI/ML")));
  });
});

describe("every trends row lands on the page it promised", () => {
  let proc: ChildProcess;
  let base: string;

  before(async () => {
    const started = await new Promise<{ proc: ChildProcess; port: number }>((resolve, reject) => {
      const child = spawn("node", [path.join(__dirname, "..", "dist", "serve.js")], {
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env, PORT: "0", BASE_URL: "http://127.0.0.1" },
      });
      const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("startup timeout")); }, 60000);
      child.stderr?.on("data", (b: Buffer) => {
        const m = b.toString().match(/running on http:\/\/localhost:(\d+)/);
        if (m) { clearTimeout(timer); resolve({ proc: child, port: parseInt(m[1], 10) }); }
      });
      child.on("error", (e) => { clearTimeout(timer); reject(e); });
    });
    proc = started.proc;
    base = `http://127.0.0.1:${started.port}`;
  });

  after(() => { proc?.kill("SIGKILL"); });

  const rowsOnTheIndex = async () => {
    const html = await (await fetch(`${base}/trends`)).text();
    return [...html.matchAll(/<a href="\/trends\/([a-z0-9-]+)" class="trend-row">([\s\S]*?)<\/a>/g)].map((m) => ({
      slug: m[1],
      category: (m[2].match(/class="trend-cat">([^<]*)</)?.[1] ?? "").replace(/&amp;/g, "&"),
      changes: parseInt(m[2].match(/>(\d+) change/)?.[1] ?? "0", 10),
    }));
  };

  it("answers every row on the index with a page", async () => {
    const rows = await rowsOnTheIndex();
    assertPopulationFloor(rows.length, 40, "rows the trends index renders");
    const refused: string[] = [];
    for (const row of rows) {
      const res = await fetch(`${base}/trends/${row.slug}`);
      await res.text();
      if (res.status !== 200) refused.push(`/trends/${row.slug} answered ${res.status}`);
    }
    assert.deepStrictEqual(refused, []);
  });

  it("counts on the page what the row that links to it advertised", async () => {
    const rows = await rowsOnTheIndex();
    const disagreed: string[] = [];
    let compared = 0;
    for (const row of rows) {
      const res = await fetch(`${base}/trends/${row.slug}`);
      if (res.status !== 200) continue;
      const html = await res.text();
      compared++;
      const onPage = parseInt(html.match(/<div class="stat-value">(\d+)<\/div>\s*<div class="stat-label"><a href="[^"]*">Tracked Changes/)?.[1] ?? "-1", 10);
      const rendered = (html.match(/class="timeline-item"/g) ?? []).length;
      if (onPage !== row.changes) disagreed.push(`/trends/${row.slug}: row says ${row.changes}, page says ${onPage}`);
      if (rendered !== row.changes) disagreed.push(`/trends/${row.slug}: row says ${row.changes}, timeline renders ${rendered}`);
    }
    assertPopulationFloor(compared, 40, "rows on the index that reached a page");
    assert.deepStrictEqual(disagreed, []);
  });

  it("answers a category= filter on an alias the way it answers the name it resolves to", async () => {
    const renames = Object.entries(CATEGORY_ALIASES) as Array<[string, string]>;
    assert.ok(renames.length > 0, "no category has been renamed, so the agreement proves nothing");
    const doors = ["/api/offers?category=", "/api/newest?since=2020-01-01&limit=50&category=", "/api/agent-payments?category="];
    const refused: string[] = [];
    for (const [renamed, published] of renames) {
      for (const door of doors) {
        const underOldName = await fetch(`${base}${door}${encodeURIComponent(renamed)}`);
        const underNewName = await fetch(`${base}${door}${encodeURIComponent(published)}`);
        assert.strictEqual(underOldName.status, 200, `${door}${renamed} answered ${underOldName.status}`);
        assert.strictEqual(underNewName.status, 200, `${door}${published} answered ${underNewName.status}`);
        const [a, b] = [await underOldName.text(), await underNewName.text()];
        if (a !== b) refused.push(`${door}: ${renamed} answers differently from ${published}`);
      }
    }
    assert.deepStrictEqual(refused, []);
  });

  it("gives one row to each category and counts every record the site tracks", async () => {
    const rows = await rowsOnTheIndex();
    const published = publishedCategories();
    const unknown = rows.map((r) => r.category).filter((name) => !published.has(name));
    assert.deepStrictEqual(unknown, []);
    assert.strictEqual(rows.length, published.size);
    const summed = rows.reduce((total, r) => total + r.changes, 0);
    assert.strictEqual(summed, countedByATrendPage().length);
  });

  it("leaves a record that corrects our own entry out of every category count", async () => {
    const corrections = trackedChanges(loadDealChanges()).filter((c: { change_type: string }) => isOurOwnBookkeeping(c));
    assert.ok(corrections.length > 0, "no record corrects an earlier entry, so the exclusion proves nothing");
    const rows = await rowsOnTheIndex();
    const summed = rows.reduce((total, r) => total + r.changes, 0);
    assert.strictEqual(summed, trackedChanges(loadDealChanges()).length - corrections.length);
    for (const correction of corrections) {
      const category = resolveChangeCategory((correction as { category: string }).category);
      const row = rows.find((r) => r.category === category);
      assert.ok(row, `${category} carries a correction and has no row`);
      const counted = countedByATrendPage().filter(
        (c: { category: string }) => resolveChangeCategory(c.category) === category,
      ).length;
      assert.strictEqual(row!.changes, counted);
    }
  });

  it("keeps a change dated after today out of the history and says it is announced", async () => {
    const asOf = new Date().toISOString().slice(0, 10);
    const ahead = countedByATrendPage().filter((c: { date: string }) => c.date > asOf);
    assert.ok(ahead.length > 0, "nothing is dated ahead of today, so the partition proves nothing");
    for (const change of ahead) {
      const slug = toSlug(resolveChangeCategory((change as { category: string }).category));
      const html = await (await fetch(`${base}/trends/${slug}`)).text();
      const history = html.split("<h2>Pricing Change Timeline</h2>")[1] ?? "";
      assert.ok(
        !history.includes((change as { date: string }).date),
        `/trends/${slug} renders ${(change as { date: string }).date} inside its history`,
      );
      assert.match(html, /Announced, not yet in effect/);
    }
  });
});

describe("the category risk heatmap counts the population its caption names", () => {
  let proc: ChildProcess;
  let base: string;

  before(async () => {
    const started = await new Promise<{ proc: ChildProcess; port: number }>((resolve, reject) => {
      const child = spawn("node", [path.join(__dirname, "..", "dist", "serve.js")], {
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env, PORT: "0", BASE_URL: "http://127.0.0.1" },
      });
      const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("startup timeout")); }, 60000);
      child.stderr?.on("data", (b: Buffer) => {
        const m = b.toString().match(/running on http:\/\/localhost:(\d+)/);
        if (m) { clearTimeout(timer); resolve({ proc: child, port: parseInt(m[1], 10) }); }
      });
      child.on("error", (e) => { clearTimeout(timer); reject(e); });
    });
    proc = started.proc;
    base = `http://127.0.0.1:${started.port}`;
  });

  after(() => { proc?.kill("SIGKILL"); });

  const heatmap = async () => {
    const html = await (await fetch(`${base}/free-tier-risk`)).text();
    const section = html.split('id="heatmap"')[1]?.split("Reading the heatmap")[0] ?? "";
    const bars = [...section.matchAll(
      /min-width:180px;font-weight:600;font-size:\.85rem">([^<]+)<\/div>[\s\S]*?title="Negative: (\d+)"[\s\S]*?title="Positive: (\d+)"[\s\S]*?color:var\(--text-dim\)">(\d+)<\/div>/g,
    )].map((m) => ({
      category: m[1].replace(/&amp;/g, "&"),
      negative: parseInt(m[2], 10),
      positive: parseInt(m[3], 10),
      total: parseInt(m[4], 10),
    }));
    const caption = parseInt(html.match(/Based on (\d+) tracked changes across all categories/)?.[1] ?? "-1", 10);
    return { bars, caption };
  };

  it("sums its bars to the figure its caption names", async () => {
    const { bars, caption } = await heatmap();
    assertPopulationFloor(bars.length, 20, "bars the heatmap renders");
    assert.strictEqual(caption, trackedChanges(loadDealChanges()).length);
    assert.strictEqual(bars.reduce((total, b) => total + b.total, 0), caption);
  });

  it("gives every bar the records whose category resolves to it, and no others", async () => {
    const { bars } = await heatmap();
    const population = trackedChanges(loadDealChanges());
    const wrong: string[] = [];
    for (const bar of bars) {
      const mine = population.filter(
        (c: { category: string }) => resolveChangeCategory(c.category) === bar.category,
      );
      const negative = mine.filter((c: { change_type: string }) => NEGATIVE_CHANGE_TYPES.has(c.change_type)).length;
      const positive = mine.filter((c: { change_type: string }) => POSITIVE_CHANGE_TYPES.has(c.change_type)).length;
      if (mine.length !== bar.total) wrong.push(`${bar.category}: bar ${bar.total}, records ${mine.length}`);
      if (negative !== bar.negative) wrong.push(`${bar.category}: bar ${bar.negative} negative, records ${negative}`);
      if (positive !== bar.positive) wrong.push(`${bar.category}: bar ${bar.positive} positive, records ${positive}`);
    }
    assert.deepStrictEqual(wrong, []);
  });

  it("names every bar after a category we publish", async () => {
    const { bars } = await heatmap();
    const published = publishedCategories();
    const invented = bars.map((b) => b.category).filter((name) => !published.has(name));
    assert.deepStrictEqual(invented, []);
  });

  it("keeps apart two categories whose names share letters", async () => {
    const { bars } = await heatmap();
    const named = (name: string) => bars.find((b) => b.category === name);
    for (const name of ["Email", "DNS & Domain Management", "Container Registry", "Web Scraping", "AI / ML"]) {
      assert.ok(named(name), `${name} has no bar of its own`);
    }
    const population = trackedChanges(loadDealChanges());
    const emailRecords = population.filter((c: { category: string }) => c.category === "Email").length;
    assert.ok(emailRecords > 0, "no record is filed under Email, so the separation proves nothing");
    assert.strictEqual(named("Email")!.total, emailRecords);
    const eitherBucket = population.filter((c: { category: string }) =>
      ["AI / ML", "Email"].includes(resolveChangeCategory(c.category)),
    ).length;
    assert.strictEqual(named("AI / ML")!.total + named("Email")!.total, eitherBucket);
    assert.notStrictEqual(named("AI / ML")!.total, eitherBucket);
  });
});
