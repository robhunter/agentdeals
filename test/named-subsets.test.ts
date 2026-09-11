import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertCoversPopulation, vendorsInTheCatalogue } from "./population-floor.ts";
import { NAMED_SUBSET_RULE, NAMED_SUBSET_FIELD_RULE } from "../dist/ranking.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(__dirname, "..");
const A_DAY_IN_MS = 86400000;

interface Surfaces {
  regions: Record<string, string[]>;
  vendorSequence: string[];
  metaDescription: string | null;
  itemListNames: string[];
  faqAnswers: string[];
}

function startServer(inventoryOut: string, clockShiftMs: number): Promise<{ proc: ChildProcess; base: string }> {
  return new Promise((resolve, reject) => {
    const args = clockShiftMs ? ["--import", path.join(REPO, "scripts", "shifted-clock.mjs")] : [];
    const proc = spawn("node", [...args, path.join(REPO, "dist", "serve.js")], {
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        TZ: "UTC",
        PORT: "0",
        BASE_URL: "http://localhost",
        AGENTDEALS_PAGE_INVENTORY_OUT: inventoryOut,
        AGENTDEALS_CLOCK_SHIFT_MS: String(clockShiftMs),
      },
    });
    const timeout = setTimeout(() => {
      proc.kill();
      reject(new Error("Server startup timeout"));
    }, 60000);
    proc.stderr!.on("data", (data: Buffer) => {
      const match = data.toString().match(/running on http:\/\/localhost:(\d+)/);
      if (match) {
        clearTimeout(timeout);
        resolve({ proc, base: `http://localhost:${match[1]}` });
      }
    });
    proc.on("error", err => {
      clearTimeout(timeout);
      reject(err);
    });
    proc.on("exit", code => {
      clearTimeout(timeout);
      reject(new Error(`The server exited with status ${code} before reporting a port`));
    });
  });
}

function stripTags(html: string): string {
  return html.replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim();
}

function jsonLdBlocks(body: string): unknown[] {
  const out: unknown[] = [];
  const re = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body))) {
    try {
      out.push(JSON.parse(m[1]!));
    } catch {
      out.push({ unparseable: m[1] });
    }
  }
  return out;
}

function walkJsonLd(body: string, visit: (node: Record<string, unknown>) => void): void {
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    if (!node || typeof node !== "object") return;
    visit(node as Record<string, unknown>);
    for (const value of Object.values(node)) walk(value);
  };
  jsonLdBlocks(body).forEach(walk);
}

export function vendorsByRegion(body: string): Record<string, string[]> {
  const regions = new Map<string, Set<string>>();
  const headings = [...body.matchAll(/<h[1-4][^>]*>([\s\S]*?)<\/h[1-4]>/g)]
    .map(m => ({ at: m.index!, text: stripTags(m[1]!) }));
  const headingFor = (index: number): string => {
    let current = "(above the first heading)";
    for (const heading of headings) {
      if (heading.at > index) break;
      current = heading.text;
    }
    return current;
  };
  for (const match of body.matchAll(/href="\/vendor\/([a-z0-9-]+)"/g)) {
    const region = headingFor(match.index!);
    if (!regions.has(region)) regions.set(region, new Set());
    regions.get(region)!.add(match[1]!);
  }
  return Object.fromEntries([...regions].map(([k, v]) => [k, [...v].sort()]));
}

function surfacesOf(body: string): Surfaces {
  const itemListNames: string[] = [];
  const faqAnswers: string[] = [];
  walkJsonLd(body, node => {
    if (node["@type"] === "ItemList" && Array.isArray(node.itemListElement)) {
      for (const el of node.itemListElement as Array<Record<string, any>>) {
        const name = el?.item?.name ?? el?.name;
        if (typeof name === "string") itemListNames.push(name);
      }
    }
    if (node["@type"] === "Question" && typeof (node.acceptedAnswer as any)?.text === "string") {
      faqAnswers.push(`${node.name} :: ${(node.acceptedAnswer as any).text}`);
    }
  });
  const meta = body.match(/<meta name="description" content="([^"]*)"/);
  return {
    regions: vendorsByRegion(body),
    vendorSequence: [...body.matchAll(/href="\/vendor\/([a-z0-9-]+)"/g)].map(m => m[1]!),
    metaDescription: meta ? meta[1]! : null,
    itemListNames: itemListNames.sort(),
    faqAnswers: faqAnswers.sort(),
  };
}

async function readEveryPage(base: string, paths: string[]): Promise<Map<string, Surfaces>> {
  const out = new Map<string, Surfaces>();
  for (const pagePath of paths) {
    const response = await fetch(base + pagePath);
    const body = await response.text();
    assert.equal(response.status, 200, `${pagePath} answered ${response.status}, so what it names cannot be compared`);
    out.set(pagePath, surfacesOf(body));
  }
  return out;
}

describe("what a page names does not depend on the day it is served", () => {
  let inventory: string[] = [];
  let today: Map<string, Surfaces>;
  let tomorrow: Map<string, Surfaces>;
  let scratch = "";

  before(async () => {
    scratch = mkdtempSync(path.join(tmpdir(), "named-subsets-"));
    const inventoryOut = path.join(scratch, "inventory.json");
    const first = await startServer(inventoryOut, 0);
    inventory = JSON.parse(readFileSync(inventoryOut, "utf-8"));
    today = await readEveryPage(first.base, inventory);
    first.proc.kill();

    const ahead = await startServer(path.join(scratch, "inventory-ahead.json"), A_DAY_IN_MS);
    tomorrow = await readEveryPage(ahead.base, inventory);
    ahead.proc.kill();
  });

  after(() => {
    if (scratch) rmSync(scratch, { recursive: true, force: true });
  });

  it("reads every page this server publishes, not a sample of them", () => {
    const vendorPages = inventory.filter(p => p.startsWith("/vendor/"));
    assertCoversPopulation(vendorPages.length, vendorsInTheCatalogue(), "vendor pages read against a clock a day ahead");
  });

  it("reads a server whose clock really is a day ahead", () => {
    const inADifferentOrder = inventory.filter(pagePath => {
      const before = today.get(pagePath)!.vendorSequence;
      const after = tomorrow.get(pagePath)!.vendorSequence;
      return before.length > 1 && before.join("|") !== after.join("|");
    });
    assert.ok(
      inADifferentOrder.length > 0,
      "no page lists its vendors in a different order tomorrow, so the second server is not a day ahead and every comparison here passes for the wrong reason",
    );
  });

  it("names the same vendors under every heading it serves them under", () => {
    const moved: string[] = [];
    for (const pagePath of inventory) {
      const before = today.get(pagePath)!.regions;
      const after = tomorrow.get(pagePath)!.regions;
      for (const region of new Set([...Object.keys(before), ...Object.keys(after)])) {
        const named = (before[region] ?? []).join(", ");
        const namedTomorrow = (after[region] ?? []).join(", ");
        if (named !== namedTomorrow) moved.push(`${pagePath} under "${region}": ${named} becomes ${namedTomorrow}`);
      }
    }
    assert.deepEqual(moved.slice(0, 8), [], `${moved.length} of ${inventory.length} pages name a different set of vendors tomorrow`);
  });

  it("serves the same meta description tomorrow", () => {
    const moved = inventory.filter(p => today.get(p)!.metaDescription !== tomorrow.get(p)!.metaDescription);
    assert.deepEqual(
      moved.slice(0, 8).map(p => `${p}: ${today.get(p)!.metaDescription} becomes ${tomorrow.get(p)!.metaDescription}`),
      [],
      `${moved.length} of ${inventory.length} meta descriptions are a function of the day they are served`,
    );
  });

  it("puts the same names in its structured data tomorrow, whatever order it lists them in", () => {
    const moved = inventory.filter(p =>
      today.get(p)!.itemListNames.join("|") !== tomorrow.get(p)!.itemListNames.join("|"));
    assert.deepEqual(moved.slice(0, 8), [], `${moved.length} of ${inventory.length} pages publish an ItemList naming different members tomorrow`);
  });

  it("answers its own questions with the same words tomorrow", () => {
    const moved: string[] = [];
    for (const pagePath of inventory) {
      const before = today.get(pagePath)!.faqAnswers;
      const after = tomorrow.get(pagePath)!.faqAnswers;
      if (before.join("\n") === after.join("\n")) continue;
      const first = before.find((answer, i) => answer !== after[i]) ?? before[0];
      moved.push(`${pagePath}: ${first}`);
    }
    assert.deepEqual(moved.slice(0, 8), [], `${moved.length} of ${inventory.length} pages answer a question differently tomorrow`);
  });

});

describe("the rule that decides it is published where a reader can find it", () => {
  it("states the rule and the reason no field replaces it on /criteria", async () => {
    const scratch = mkdtempSync(path.join(tmpdir(), "named-subsets-criteria-"));
    const { proc, base } = await startServer(path.join(scratch, "inventory.json"), 0);
    try {
      const body = await (await fetch(`${base}/criteria`)).text();
      const text = stripTags(body).replace(/&mdash;/g, "—").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
      assert.ok(text.includes(NAMED_SUBSET_RULE), "/criteria does not state the rule the pages follow");
      assert.ok(text.includes(NAMED_SUBSET_FIELD_RULE), "/criteria does not say why no field picks the members instead");
      assert.ok(body.includes('id="subsets"'), "nothing on a page can link to the rule it says it follows");
    } finally {
      proc.kill();
      rmSync(scratch, { recursive: true, force: true });
    }
  });
});
