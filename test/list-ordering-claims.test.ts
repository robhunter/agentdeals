import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import ts from "typescript";
import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertPopulationFloor, categoriesInTheCatalogue } from "./population-floor.ts";

const {
  ITEM_LIST_ASCENDING, ITEM_LIST_DESCENDING, ITEM_LIST_UNORDERED,
  listOrderProse, listOrderSentence, orderedClaim, rulesClaiming,
} = await import("../dist/list-order.js");
const { unrankedListingBasis } = await import("../dist/unranked.js");

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(__dirname, "..");
const SOURCE = readFileSync(path.join(REPO, "src", "serve.ts"), "utf-8");
const TYPE_MARKER = `"@type": "ItemList"`;
const CLAIMS = [ITEM_LIST_ASCENDING, ITEM_LIST_DESCENDING, ITEM_LIST_UNORDERED];

const BAND_CLAUSES = ["demoted with the reason named", "listed last behind a stated gate"];

const unquote = (text: string) => text.replace(/^["']|["']$/g, "");

function sourceFile(): ts.SourceFile {
  return ts.createSourceFile("serve.ts", SOURCE, ts.ScriptTarget.ES2022, true);
}

interface SourceSite {
  line: number;
  order: string | null;
}

function objectLiteralItemLists(): SourceSite[] {
  const source = sourceFile();
  const sites: SourceSite[] = [];
  const propertyNamed = (node: ts.ObjectLiteralExpression, name: string) =>
    node.properties.find(
      (p): p is ts.PropertyAssignment => ts.isPropertyAssignment(p) && unquote(p.name.getText()) === name,
    );
  const walk = (node: ts.Node) => {
    if (ts.isObjectLiteralExpression(node)) {
      const typed = propertyNamed(node, "@type");
      if (typed && unquote(typed.initializer.getText()) === "ItemList") {
        const order = propertyNamed(node, "itemListOrder");
        sites.push({
          line: source.getLineAndCharacterOfPosition(node.getStart()).line + 1,
          order: order ? order.initializer.getText() : null,
        });
      }
    }
    ts.forEachChild(node, walk);
  };
  walk(source);
  return sites;
}

function templateLiteralItemLists(): SourceSite[] {
  const source = sourceFile();
  const sites: SourceSite[] = [];
  const cookedText = (node: ts.TemplateExpression) =>
    [node.head.text, ...node.templateSpans.map((span) => span.literal.text)].join(" ");
  const walk = (node: ts.Node) => {
    if (ts.isTemplateExpression(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      const text = ts.isTemplateExpression(node) ? cookedText(node) : node.text;
      let at = text.indexOf(TYPE_MARKER);
      while (at >= 0) {
        const after = text.slice(at + TYPE_MARKER.length);
        const nextType = after.indexOf(`"@type"`);
        const ownProperties = nextType >= 0 ? after.slice(0, nextType) : after;
        sites.push({
          line: source.getLineAndCharacterOfPosition(node.getStart()).line + 1,
          order: ownProperties.includes(`"itemListOrder"`) ? `"itemListOrder"` : null,
        });
        at = text.indexOf(TYPE_MARKER, at + TYPE_MARKER.length);
      }
    }
    ts.forEachChild(node, walk);
  };
  walk(source);
  return sites;
}

describe("#1491 every list the page source builds declares how it is ordered", () => {
  it("accounts for every ItemList the source writes", () => {
    const written = SOURCE.split(TYPE_MARKER).length - 1;
    const found = objectLiteralItemLists().length + templateLiteralItemLists().length;
    assert.strictEqual(found, written, `the walk found ${found} of ${written} ItemList blocks in src/serve.ts`);
    assertPopulationFloor(written, 29, "ItemList blocks built in src/serve.ts");
  });

  it("declares an ordering claim at every site", () => {
    const silent = [...objectLiteralItemLists(), ...templateLiteralItemLists()]
      .filter((site) => site.order === null)
      .map((site) => `src/serve.ts:${site.line}`);
    assert.deepStrictEqual(silent, [], `ItemList blocks carrying no itemListOrder:\n${silent.join("\n")}`);
  });

  it("takes every claim from the ordering vocabulary rather than an inline URL", () => {
    const inline = objectLiteralItemLists()
      .filter((site) => site.order !== null && !/^(listOrderOf|bandedListOrder)\(/.test(site.order))
      .map((site) => `src/serve.ts:${site.line} declares ${site.order}`);
    assert.deepStrictEqual(inline, [], `ordering claims written outside list-order.ts:\n${inline.join("\n")}`);
  });
});

const LEAF_BEST_OF = "/best/free-error-tracking";
const HUB_BEST_OF = "/best/free-databases";

const PATHS = [
  "/", LEAF_BEST_OF, HUB_BEST_OF, "/category/databases", "/compare/10minutemail-vs-resend",
  "/alternative-to/vercel", "/alternatives", "/events", "/reports", "/guides",
  "/ai-free-tiers", "/free-llm-apis", "/hosting-alternatives", "/database-alternatives",
  "/monitoring-alternatives", "/ci-cd-alternatives", "/security-alternatives",
  "/testing-alternatives", "/storage-alternatives", "/analytics-alternatives",
  "/ai-ml-alternatives", "/email-alternatives", "/design-alternatives",
  "/project-management-alternatives", "/ide-code-editors-alternatives",
  "/api-development-alternatives", "/team-collaboration-alternatives",
  "/shutdowns", "/x402-services", "/stacks", "/stacks/saas-mvp",
  "/changes", "/expiring", "/deadlines", "/referral-programs", "/press",
];

interface RenderedList {
  path: string;
  trail: string;
  name: string | null;
  numberOfItems: number | null;
  elements: Record<string, unknown>[];
  itemListOrder: string | null;
}

function structuredData(html: string): unknown[] {
  const blocks: unknown[] = [];
  for (const match of html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)) {
    blocks.push(JSON.parse(match[1]));
  }
  return blocks;
}

function* listsIn(node: unknown, trail: string): Generator<{ node: Record<string, unknown>; trail: string }> {
  if (Array.isArray(node)) {
    for (const [i, member] of node.entries()) yield* listsIn(member, `${trail}[${i}]`);
    return;
  }
  if (!node || typeof node !== "object") return;
  const record = node as Record<string, unknown>;
  if (record["@type"] === "ItemList") yield { node: record, trail };
  for (const [key, value] of Object.entries(record)) {
    if (key !== "@type") yield* listsIn(value, `${trail}.${key}`);
  }
}

function listsOf(routePath: string, html: string): RenderedList[] {
  const lists: RenderedList[] = [];
  for (const [i, block] of structuredData(html).entries()) {
    for (const { node, trail } of listsIn(block, `$${i}`)) {
      lists.push({
        path: routePath,
        trail,
        name: typeof node.name === "string" ? node.name : null,
        numberOfItems: typeof node.numberOfItems === "number" ? node.numberOfItems : null,
        elements: Array.isArray(node.itemListElement) ? (node.itemListElement as Record<string, unknown>[]) : [],
        itemListOrder: typeof node.itemListOrder === "string" ? node.itemListOrder : null,
      });
    }
  }
  return lists;
}

function visibleText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/g, " ")
    .replace(/<style[\s\S]*?<\/style>/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&mdash;/g, "—")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ");
}

function firstItemName(list: RenderedList): string | null {
  const first = list.elements[0];
  if (!first) return null;
  const item = first.item as Record<string, unknown> | undefined;
  const name = (item && typeof item.name === "string" ? item.name : undefined)
    ?? (typeof first.name === "string" ? first.name : undefined);
  return name ?? null;
}

let server: ChildProcess | null = null;
let port = 0;
const rendered = new Map<string, string>();

function startServer(): Promise<{ child: ChildProcess; port: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn("node", [path.join(REPO, "dist", "serve.js")], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, PORT: "0", BASE_URL: "http://localhost", TZ: "UTC" },
    });
    const timeout = setTimeout(() => { child.kill(); reject(new Error("Server startup timeout")); }, 40000);
    child.stderr!.on("data", (data: Buffer) => {
      const m = data.toString().match(/running on http:\/\/localhost:(\d+)/);
      if (m) { clearTimeout(timeout); resolve({ child, port: parseInt(m[1], 10) }); }
    });
    child.on("error", (err) => { clearTimeout(timeout); reject(err); });
  });
}

before(async () => {
  const started = await startServer();
  server = started.child;
  port = started.port;
  for (const routePath of PATHS) {
    const res = await fetch(`http://localhost:${port}${routePath}`, {
      redirect: "manual",
      headers: { "user-agent": "agentdeals-internal/1.0 (list-ordering-test)" },
    });
    assert.strictEqual(res.status, 200, `${routePath} returned ${res.status}`);
    rendered.set(routePath, await res.text());
  }
});

after(() => { if (server) server.kill(); });

function everyRenderedList(): RenderedList[] {
  return [...rendered].flatMap(([routePath, html]) => listsOf(routePath, html));
}

describe("#1491 the served list says the same thing to a reader and to a machine", () => {
  it("publishes an ordering claim on every list it serves", () => {
    const silent = everyRenderedList()
      .filter((list) => list.itemListOrder === null)
      .map((list) => `${list.path} ${list.trail} (${list.elements.length} items)`);
    assert.deepStrictEqual(silent, [], `served lists carrying no itemListOrder:\n${silent.join("\n")}`);
    assertPopulationFloor(everyRenderedList().length, 35, "ItemList blocks served over the sampled routes");
  });

  it("publishes a claim schema.org defines", () => {
    const unknown = everyRenderedList()
      .filter((list) => !CLAIMS.includes(list.itemListOrder!))
      .map((list) => `${list.path} ${list.trail} claims ${list.itemListOrder}`);
    assert.deepStrictEqual(unknown, [], `ordering claims outside the schema.org vocabulary:\n${unknown.join("\n")}`);
  });

  it("states the rule in prose wherever it tells a machine the order ranks", () => {
    const unstated: string[] = [];
    for (const [routePath, html] of rendered) {
      const text = visibleText(html);
      if (BAND_CLAUSES.some((clause) => text.includes(clause))) continue;
      for (const list of listsOf(routePath, html)) {
        if (!orderedClaim(list.itemListOrder!)) continue;
        const firstName = firstItemName(list);
        if (!firstName || !text.includes(firstName)) continue;
        const stated = rulesClaiming(list.itemListOrder!).some((rule) => text.includes(listOrderProse(rule)));
        if (!stated) unstated.push(`${routePath} ${list.trail} claims ${list.itemListOrder} and states no rule`);
      }
    }
    assert.deepStrictEqual(unstated, [], `ordered lists whose page states no ordering rule:\n${unstated.join("\n")}`);
  });

  it("states the rotation wherever it tells a machine the order ranks nothing", () => {
    const contradictions: string[] = [];
    for (const [routePath, html] of rendered) {
      const text = visibleText(html);
      const rotating = text.includes("carry no recorded demerit") || text.includes("none is distinguishable");
      if (!rotating) continue;
      for (const list of listsOf(routePath, html)) {
        if (list.itemListOrder !== ITEM_LIST_UNORDERED) continue;
        if (!text.includes(listOrderProse("rotates-daily"))) {
          contradictions.push(`${routePath} ${list.trail} claims no order and the page states none`);
        }
      }
    }
    assert.deepStrictEqual(contradictions, [], contradictions.join("\n"));
  });

  it("keeps the band vocabulary the listing sentence renders", () => {
    const sentence = unrankedListingBasis(2, 1, 1);
    assert.ok(sentence.includes(listOrderProse("rotates-daily")), sentence);
    for (const clause of BAND_CLAUSES) assert.ok(sentence.includes(clause), sentence);
  });

  it("claims an order on a listing whose bands differ and none on a listing whose bands do not", () => {
    const html = rendered.get("/alternative-to/vercel")!;
    const text = visibleText(html);
    const [list] = listsOf("/alternative-to/vercel", html);
    const banded = BAND_CLAUSES.some((clause) => text.includes(clause));
    assert.strictEqual(
      list.itemListOrder,
      banded ? ITEM_LIST_ASCENDING : ITEM_LIST_UNORDERED,
      `the page states ${banded ? "bands" : "one band"} and the list claims ${list.itemListOrder}`,
    );
  });

  it("renders the ordering sentence from the value the claim is read from", () => {
    for (const routePath of ["/changes", "/deadlines", "/press", "/reports"]) {
      const html = rendered.get(routePath)!;
      const text = visibleText(html);
      const [list] = listsOf(routePath, html);
      const rule = rulesClaiming(list.itemListOrder!).find((candidate) => text.includes(listOrderSentence(candidate)));
      assert.ok(rule, `${routePath} claims ${list.itemListOrder} and renders no sentence naming that rule`);
    }
  });
});

describe("#1491 a list counts what its name says it holds", () => {
  it("names the subtype groups the best-of hub list holds", () => {
    const html = rendered.get(HUB_BEST_OF)!;
    const [outer, ...groups] = listsOf(HUB_BEST_OF, html);
    assert.ok(outer.name!.includes("by labelled function"), `the hub list is named ${outer.name}`);
    assert.strictEqual(outer.numberOfItems, outer.elements.length);
    assert.ok(groups.length > 1, `the hub list holds ${groups.length} groups`);
    for (const group of groups) assert.strictEqual(group.numberOfItems, group.elements.length, `${group.name}`);
  });

  it("counts offers on a best-of page that holds no groups", () => {
    const html = rendered.get(LEAF_BEST_OF)!;
    const lists = listsOf(LEAF_BEST_OF, html);
    assert.strictEqual(lists.length, 1, `${LEAF_BEST_OF} publishes ${lists.length} lists`);
    assert.strictEqual(lists[0].numberOfItems, lists[0].elements.length);
  });

  it("counts categories on the home page list of categories", () => {
    const lists = listsOf("/", rendered.get("/")!);
    const byCategory = lists.find((list) => list.name?.includes("Categories"));
    assert.ok(byCategory, `the home page publishes ${lists.map((l) => l.name).join(", ")}`);
    assert.strictEqual(byCategory!.numberOfItems, categoriesInTheCatalogue().size);
    assert.ok(byCategory!.elements.length < byCategory!.numberOfItems!);
  });
});
