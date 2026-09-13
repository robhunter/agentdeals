import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertPopulationFloor } from "./population-floor.ts";

const {
  durabilitySplit,
  durabilityVerdictText,
  durabilityBriefText,
  DURABILITY_NOT_A_SIZE_RANKING,
} = await import("../dist/durability-verdict.js");
const { NO_RANKING_HELD } = await import("../dist/unranked.js");
const { superlativeClaims } = await import("../dist/superlative-claims.js");

const __dirname = path.dirname(fileURLToPath(import.meta.url));
let serverPort = 0;
let proc: ChildProcess | null = null;

function startHttpServer(): Promise<ChildProcess> {
  return new Promise((resolve, reject) => {
    const child = spawn("node", [path.join(__dirname, "..", "dist", "serve.js")], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, PORT: "0", BASE_URL: "http://localhost", TZ: "UTC" },
    });
    const timeout = setTimeout(() => { child.kill(); reject(new Error("Server startup timeout")); }, 30000);
    child.stderr!.on("data", (data: Buffer) => {
      const match = data.toString().match(/running on http:\/\/localhost:(\d+)/);
      if (match) { serverPort = parseInt(match[1], 10); clearTimeout(timeout); resolve(child); }
    });
    child.on("error", (err) => { clearTimeout(timeout); reject(err); });
  });
}

async function get(p: string): Promise<string> {
  const res = await fetch(`http://localhost:${serverPort}${p}`, { redirect: "manual" });
  assert.strictEqual(res.status, 200, `${p} answered ${res.status}`);
  return res.text();
}

const COLUMN_NAME = "Durability";
const COLUMN_HREF = "#quick-comparison";

function visibleText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/g, " ")
    .replace(/<style[\s\S]*?<\/style>/g, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&mdash;/g, "—")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

interface QuickRow {
  vendor: string;
  durability: string | null;
  href: string | null;
}

function quickComparisonRows(html: string): QuickRow[] {
  const from = html.indexOf(`<h2 id="quick-comparison">`);
  if (from < 0) return [];
  const table = html.slice(from, html.indexOf("</table>", from));
  const rows: QuickRow[] = [];
  for (const row of table.match(/<tr>[\s\S]*?<\/tr>/g) ?? []) {
    const cells = row.match(/<td\b[^>]*>[\s\S]*?<\/td>/g);
    if (!cells || cells.length < 5) continue;
    const cell = cells[3]!;
    const named = /<span[^>]*>([a-z]+)<\/span>/.exec(cell);
    rows.push({
      vendor: visibleText(cells[0]!),
      durability: named ? named[1]! : null,
      href: /href="([^"]+)"/.exec(cell)?.[1] ?? null,
    });
  }
  return rows;
}

function tieNote(html: string): string {
  return visibleText(/<div class="tie-note">([\s\S]*?)<\/div>/.exec(html)?.[1] ?? "");
}

function statedScope(note: string): string {
  const stated = /\d+ offers? meets? our criteria ([^.]+)\./.exec(note);
  assert.ok(stated, `no durability denominator in: ${note.slice(0, 200)}`);
  return stated[1]!;
}

function faqAnswers(html: string): Map<string, string> {
  const answers = new Map<string, string>();
  for (const block of html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)) {
    const parsed = JSON.parse(block[1]!);
    if (parsed["@type"] !== "FAQPage") continue;
    for (const entry of parsed.mainEntity ?? []) answers.set(entry.name, entry.acceptedAnswer.text);
  }
  return answers;
}

let bestOfPaths: string[] = [];
const served = new Map<string, string>();
let pricingChangeAnchors = new Set<string>();

before(async () => {
  proc = await startHttpServer();
  const index = await get("/best");
  bestOfPaths = [...new Set([...index.matchAll(/href="(\/best\/[a-z0-9-]+)"/g)].map(m => m[1]!))].sort();
  for (const routePath of bestOfPaths) served.set(routePath, await get(routePath));
  const changes = await get("/pricing-changes");
  pricingChangeAnchors = new Set([...changes.matchAll(/ id="([^"]+)"/g)].map(m => m[1]!));
});

after(() => { if (proc) proc.kill(); });

describe("#1492 a best-of page states what its own signal says about its offers", () => {
  it("sweeps the whole published family", () => {
    assertPopulationFloor(bestOfPaths.length, 50, "best-of pages the site publishes");
  });

  it("asserts on no page that nothing we record distinguishes its offers", () => {
    const claiming = [...served].filter(([, html]) => /distinguishable/i.test(html)).map(([p]) => p);
    assert.deepStrictEqual(claiming, [], `pages still claiming an indistinguishable set:\n${claiming.join("\n")}`);
  });

  it("counts each offer under the class its own row publishes", () => {
    const disagreeing: string[] = [];
    let checked = 0;
    for (const [routePath, html] of served) {
      const rows = quickComparisonRows(html);
      if (rows.length === 0) { disagreeing.push(`${routePath} publishes no ${COLUMN_NAME} column`); continue; }
      const note = tieNote(html);
      const split = durabilitySplit(rows.map(row => row.durability));
      const expected = durabilityVerdictText(split, {
        where: statedScope(note),
        columnName: COLUMN_NAME,
        columnHref: COLUMN_HREF,
      });
      if (!note.includes(expected)) disagreeing.push(`${routePath}\n  rows say: ${expected}\n  page says: ${note.slice(0, 320)}`);
      checked++;
    }
    assert.deepStrictEqual(disagreeing, [], `pages whose verdict does not resolve from their own rows:\n${disagreeing.join("\n")}`);
    assertPopulationFloor(checked, 50, "best-of pages whose verdict was checked against their own column");
  });

  it("renders no clause for a group holding nothing", () => {
    const empty: string[] = [];
    for (const [routePath, html] of served) {
      const note = tieNote(html);
      for (const clause of [/\b0 carr/, /\b0 a recorded/, /no durability signal for 0\b/]) {
        if (clause.test(note)) empty.push(`${routePath} renders ${clause}`);
      }
    }
    assert.deepStrictEqual(empty, [], `zero-count clauses that should not render:\n${empty.join("\n")}`);
  });

  it("reaches a dated record from every offer it counts as changed", () => {
    const unreachable: string[] = [];
    let changed = 0;
    for (const [routePath, html] of served) {
      for (const row of quickComparisonRows(html)) {
        if (row.durability === null || row.durability === "stable") continue;
        changed++;
        if (!row.href) { unreachable.push(`${routePath} ${row.vendor} is ${row.durability} and links no record`); continue; }
        const anchor = row.href.split("#")[1] ?? "";
        if (!pricingChangeAnchors.has(anchor)) {
          unreachable.push(`${routePath} ${row.vendor} links ${row.href}, which /pricing-changes does not carry`);
        }
      }
    }
    assert.deepStrictEqual(unreachable, [], `changed offers with no reachable record:\n${unreachable.join("\n")}`);
    assertPopulationFloor(changed, 150, "listed offers counted as changed");
  });

  it("publishes the same verdict to a reader and to a machine", () => {
    const disagreeing: string[] = [];
    let checked = 0;
    for (const [routePath, html] of served) {
      const held = [...faqAnswers(html)].filter(([question]) => /have held their terms\?$/.test(question));
      if (held.length !== 1) { disagreeing.push(`${routePath} publishes ${held.length} durability answers`); continue; }
      const note = tieNote(html);
      if (!note.includes(held[0]![1])) {
        disagreeing.push(`${routePath}\n  machine: ${held[0]![1]}\n  reader:  ${note.slice(0, 320)}`);
      }
      checked++;
    }
    assert.deepStrictEqual(disagreeing, [], `pages whose two surfaces disagree:\n${disagreeing.join("\n")}`);
    assertPopulationFloor(checked, 50, "best-of pages publishing the verdict on both surfaces");
  });

  it("ranks nothing by capacity, quota or limit size", () => {
    const ranking: string[] = [];
    for (const [routePath, html] of served) {
      for (const claim of superlativeClaims(html)) ranking.push(`${routePath} publishes "${claim.label}"`);
      if (!visibleText(html).includes(DURABILITY_NOT_A_SIZE_RANKING)) {
        ranking.push(`${routePath} states no refusal to rank by size`);
      }
    }
    assert.deepStrictEqual(ranking, [], `size rankings on the best-of family:\n${ranking.join("\n")}`);
  });

  it("keeps the refusal to name a best on every page of this family", () => {
    const missing: string[] = [];
    for (const [routePath, html] of served) {
      if (!visibleText(html).includes(NO_RANKING_HELD)) missing.push(routePath);
    }
    assert.deepStrictEqual(missing, [], `pages that dropped the refusal:\n${missing.join("\n")}`);
  });

  it("leaves the category hubs refusing in the same words", async () => {
    const missing: string[] = [];
    let checked = 0;
    for (const hub of ["/category/databases", "/category/monitoring", "/category/security", "/category/storage"]) {
      const html = await get(hub);
      if (!visibleText(html).includes(NO_RANKING_HELD)) missing.push(hub);
      if (/distinguishable/i.test(html)) missing.push(`${hub} claims an indistinguishable set`);
      checked++;
    }
    assert.deepStrictEqual(missing, [], `category hubs that changed their refusal:\n${missing.join("\n")}`);
    assert.strictEqual(checked, 4);
  });
});

describe("#1492 a per-group verdict counts that group and not the page", () => {
  it("states a separate denominator under every labelled function", async () => {
    const html = served.get("/best/free-monitoring") ?? (await get("/best/free-monitoring"));
    const groups = [...html.matchAll(/<p class="function-group-scope">([\s\S]*?)<\/p>/g)].map(m => visibleText(m[1]!));
    assert.ok(groups.length > 1, `only ${groups.length} groups, so this is not measuring the split`);
    const page = /(\d+) offers? meets? our criteria here\./.exec(tieNote(html));
    assert.ok(page, "the hub page states no page-level denominator");
    let counted = 0;
    for (const group of groups) {
      const stated = /(\d+) offers? meets? our criteria in this group\./.exec(group);
      assert.ok(stated, `a group states no denominator: ${group.slice(0, 120)}`);
      counted += Number(stated[1]);
    }
    assert.ok(
      counted >= Number(page[1]),
      `the groups count ${counted} offers and the page counts ${page[1]}`,
    );
  });
});

describe("#1492 the verdict holds where the data is at an edge", () => {
  const scope = { where: "on this page", columnName: COLUMN_NAME, columnHref: COLUMN_HREF };

  it("says we hold no durability signal where no offer carries one", () => {
    const text = durabilityVerdictText(durabilitySplit([null, null, null]), scope);
    assert.match(text, /3 offers meet our criteria on this page\./);
    assert.match(text, /We publish no durability signal for any of them\./);
    assert.ok(!text.includes(COLUMN_NAME), `a page with no signal points at a column that says nothing: ${text}`);
  });

  it("states one verdict where every offer has held its terms", () => {
    const text = durabilityVerdictText(durabilitySplit(["stable", "stable"]), scope);
    assert.match(text, /All of them carry no recorded change to the terms we publish\./);
    assert.ok(!/no durability signal/.test(text), `a page with no withheld offer explains the withholding: ${text}`);
  });

  it("publishes no split where the page lists no offer", () => {
    const text = durabilityVerdictText(durabilitySplit([]), scope);
    assert.match(text, /No offer meets our criteria on this page today\./);
    assert.match(text, /There is no durability split to publish\./);
    assert.ok(!text.includes(DURABILITY_NOT_A_SIZE_RANKING), `an empty page still refuses a ranking: ${text}`);
  });

  it("drops the clause whose count is zero and keeps the ones that are not", () => {
    const text = durabilityVerdictText(durabilitySplit(["stable", "watch", null]), scope);
    assert.match(text, /1 carries no recorded change to the terms we publish, 1 a recorded narrowing, and we publish no durability signal for 1\./);
    assert.ok(!/recorded widening/.test(text), `a page with nothing widened names a widening: ${text}`);
  });

  it("counts an improving offer as a widening and a volatile one as a narrowing", () => {
    const split = durabilitySplit(["improving", "volatile", "watch", "stable", null]);
    assert.deepStrictEqual(split, { total: 5, held: 1, narrowed: 2, widened: 1, unknown: 1 });
  });

  it("leaves the guidance sentences out of a per-group verdict", () => {
    const split = durabilitySplit(["stable", "watch", null]);
    const brief = durabilityBriefText(split, { ...scope, where: "in this group" });
    assert.ok(!brief.includes(DURABILITY_NOT_A_SIZE_RANKING), brief);
    assert.ok(!brief.includes(COLUMN_NAME), brief);
    assert.ok(durabilityVerdictText(split, scope).includes(DURABILITY_NOT_A_SIZE_RANKING));
  });
});
