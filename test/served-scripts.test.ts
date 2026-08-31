import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let server: ChildProcess;
let base = "";

function startServer(): Promise<ChildProcess> {
  return new Promise((resolve, reject) => {
    const serverPath = path.join(__dirname, "..", "dist", "serve.js");
    const proc = spawn("node", [serverPath], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, PORT: "0", BASE_URL: "http://localhost" },
    });
    const timeout = setTimeout(() => {
      proc.kill();
      reject(new Error("Server startup timeout"));
    }, 15000);
    proc.stderr!.on("data", (data: Buffer) => {
      const match = data.toString().match(/running on http:\/\/localhost:(\d+)/);
      if (match) {
        base = `http://localhost:${match[1]}`;
        clearTimeout(timeout);
        resolve(proc);
      }
    });
    proc.on("error", (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });
}

async function body(route: string): Promise<string> {
  const response = await fetch(`${base}${route}`);
  return response.ok ? await response.text() : "";
}

function locsIn(xml: string): string[] {
  return [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map(
    (m) => m[1].replace(/^https?:\/\/[^/]+/, "") || "/",
  );
}

function inlineScripts(html: string): string[] {
  const blocks: string[] = [];
  const re = /<script([^>]*)>([\s\S]*?)<\/script>/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(html)) !== null) {
    const attrs = match[1];
    const source = match[2];
    const type = (attrs.match(/type\s*=\s*["']([^"']+)["']/i)?.[1] ?? "").toLowerCase();
    if (type.includes("json")) continue;
    if (/\bsrc\s*=/i.test(attrs)) continue;
    if (!source.trim()) continue;
    blocks.push(source);
  }
  return blocks;
}

function handlerNames(html: string): string[] {
  const names = new Set<string>();
  for (const attr of html.matchAll(/\son(?:click|input|change|submit)\s*=\s*"([^"]*)"/gi)) {
    for (const call of attr[1].matchAll(/([A-Za-z_$][\w$]*)\s*\(/g)) names.add(call[1]);
  }
  return [...names];
}

const TEMPLATE_SAMPLES = 5;

async function everyPageTemplate(): Promise<string[]> {
  const routes = new Set<string>(["/"]);
  for (const sitemap of locsIn(await body("/sitemap.xml"))) {
    const repeated = /vendors|comparisons/.test(sitemap);
    const locs = locsIn(await body(sitemap));
    for (const loc of repeated ? locs.slice(0, TEMPLATE_SAMPLES) : locs) routes.add(loc);
  }
  return [...routes].filter((route) => !route.endsWith(".xml"));
}

const INTERACTIVE_PAGES = [
  "/budget-builder",
  "/stack-check",
  "/compare-tool",
  "/estimate",
  "/setup",
  "/developers",
];

before(async () => {
  server = await startServer();
});
after(() => {
  server?.kill();
});

describe("served script blocks", () => {
  it("parse as JavaScript, on every page template the site publishes", async () => {
    const routes = await everyPageTemplate();
    assert.ok(routes.length > 1000, `expected the whole catalogue of templates, got ${routes.length}`);
    for (const page of INTERACTIVE_PAGES) {
      assert.ok(routes.includes(page), `${page} is outside the swept routes`);
    }

    const checked = new Set<string>();
    const unparseable: string[] = [];
    for (const route of routes) {
      for (const source of inlineScripts(await body(route))) {
        const digest = createHash("sha256").update(source).digest("hex");
        if (checked.has(digest)) continue;
        checked.add(digest);
        try {
          new vm.Script(source);
        } catch (error) {
          unparseable.push(`${route} (${source.length} bytes): ${(error as Error).message}`);
        }
      }
    }

    assert.ok(checked.size > 10, `expected many distinct blocks, got ${checked.size}`);
    assert.deepStrictEqual(unparseable, []);
  });
});

type StubNode = {
  value: string;
  innerHTML: string;
  textContent: string;
  disabled: boolean;
  style: Record<string, string>;
  dataset: Record<string, string>;
  classList: { toggle: () => void; add: () => void; remove: () => void };
  scrollIntoView: () => void;
};

function runPageScripts(html: string, search: string) {
  const nodes = new Map<string, StubNode>();
  const node = (): StubNode => ({
    value: "",
    innerHTML: "",
    textContent: "",
    disabled: false,
    style: {},
    dataset: {},
    classList: { toggle: () => {}, add: () => {}, remove: () => {} },
    scrollIntoView: () => {},
  });
  const document = {
    getElementById(id: string) {
      if (!nodes.has(id)) nodes.set(id, node());
      return nodes.get(id);
    },
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener: () => {},
  };
  const window = {
    location: { search, origin: base, href: base + "/budget-builder" + search },
    navigator: { clipboard: { writeText: async () => {} } },
  };
  const context = vm.createContext({
    window,
    document,
    navigator: window.navigator,
    URLSearchParams,
    console,
    setTimeout,
  });
  for (const source of inlineScripts(html)) vm.runInContext(source, context, { timeout: 10000 });
  return { context: context as Record<string, unknown>, nodes };
}

function summaryOf(nodes: Map<string, StubNode>): { value: string; label: string }[] {
  const html = nodes.get("summary-cards")?.innerHTML ?? "";
  return [...html.matchAll(/<div class="value">([^<]*)<\/div><div class="label">([^<]*)<\/div>/g)]
    .map((m) => ({ value: m[1], label: m[2] }));
}

function stackCardCount(nodes: Map<string, StubNode>): number {
  return (nodes.get("stack-cards")?.innerHTML.match(/class="stack-card"/g) ?? []).length;
}

async function categoriesOffered(): Promise<string[]> {
  const html = await body("/budget-builder");
  return [...html.matchAll(/class="cat-toggle"[^>]*data-cat="([^"]+)"/g)].map((m) => m[1]);
}

describe("budget builder", () => {
  it("defines every function the controls on its own page call", async () => {
    const html = await body("/budget-builder");
    const named = handlerNames(html);
    assert.ok(named.length >= 5, `expected the page to bind controls, found ${named.length}`);

    const { context } = runPageScripts(html, "");
    const undefinedHandlers = named.filter((name) => typeof context[name] !== "function");
    assert.deepStrictEqual(undefinedHandlers, []);
  });

  it("builds one card per category from the parameters in a shared link", async () => {
    const categories = (await categoriesOffered()).slice(0, 3);
    assert.strictEqual(categories.length, 3);
    const search = `?budget=25&categories=${categories.join(",")}`;

    const { nodes } = runPageScripts(await body("/budget-builder" + search), search);

    assert.strictEqual(stackCardCount(nodes), categories.length);
    assert.deepStrictEqual(
      summaryOf(nodes).map((card) => card.label),
      ["Total Monthly Cost", "Services", "Free Services", "Paid Services"],
    );
    const [total, services, free, paid] = summaryOf(nodes).map((card) => card.value);
    assert.strictEqual(services, String(categories.length));
    assert.strictEqual(Number(free) + Number(paid), categories.length);
    assert.match(total, /^\$\d+$/);
    assert.strictEqual(nodes.get("budget-bar-label")?.textContent, "of $25/mo budget");
    assert.strictEqual(nodes.get("share-url")?.textContent, base + "/budget-builder" + search);
    assert.strictEqual(nodes.get("results")?.style.display, "block");
  });

  it("charges nothing and counts every service free when the budget is zero", async () => {
    const categories = await categoriesOffered();
    assert.ok(categories.length >= 4, `expected several categories, got ${categories.length}`);
    const search = `?budget=0&categories=${categories.join(",")}`;

    const { nodes } = runPageScripts(await body("/budget-builder" + search), search);

    const [total, services, free, paid] = summaryOf(nodes).map((card) => card.value);
    assert.strictEqual(total, "$0");
    assert.strictEqual(services, String(categories.length));
    assert.strictEqual(free, String(categories.length));
    assert.strictEqual(paid, "0");
    assert.strictEqual(nodes.get("budget-bar-label")?.textContent, "Free tier only");
    assert.strictEqual(nodes.get("budget-bar-fill")?.textContent, "$0/mo");
    assert.strictEqual(stackCardCount(nodes), categories.length);
  });

  it("leaves the page idle until a category is chosen", async () => {
    const { nodes } = runPageScripts(await body("/budget-builder"), "");

    assert.deepStrictEqual(summaryOf(nodes), []);
    assert.strictEqual(stackCardCount(nodes), 0);
    assert.strictEqual(nodes.get("results")?.style.display, undefined);
    assert.strictEqual(nodes.get("share-bar")?.style.display, undefined);
  });
});
