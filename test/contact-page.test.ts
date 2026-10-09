import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertPopulationFloor } from "./population-floor.ts";
import { CONTACT_EMAIL } from "../dist/contact.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(__dirname, "..");
const BASE_URL = "http://localhost";
const INVENTORY = path.join(mkdtempSync(path.join(tmpdir(), "contact-page-")), "inventory.json");
const FOOTERS = /<footer[\s\S]*?<\/footer>|<div class=\\?"footer\\?">[\s\S]*?<\/div>/g;
const CONTACT_LINK = /href=\\?"\/contact\\?"/g;

let proc: ChildProcess | null = null;
let base = "";

function startServer(): Promise<ChildProcess> {
  return new Promise((resolve, reject) => {
    const child = spawn("node", [path.join(REPO, "dist", "serve.js")], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, PORT: "0", BASE_URL, AGENTDEALS_PAGE_INVENTORY_OUT: INVENTORY },
    });
    const timeout = setTimeout(() => { child.kill(); reject(new Error("Server startup timeout")); }, 20000);
    child.stderr!.on("data", (data: Buffer) => {
      const m = data.toString().match(/running on http:\/\/localhost:(\d+)/);
      if (m) { base = `http://localhost:${m[1]}`; clearTimeout(timeout); resolve(child); }
    });
    child.on("error", (err) => { clearTimeout(timeout); reject(err); });
  });
}

const text = async (p: string) => (await fetch(`${base}${p}`)).text();

async function locs(sitemap: string): Promise<string[]> {
  return [...(await text(sitemap)).matchAll(/<loc>([^<]+)<\/loc>/g)].map(m => new URL(m[1]).pathname);
}

async function everySitemapPage(): Promise<string[]> {
  const pages: string[] = [];
  for (const sitemap of await locs("/sitemap.xml")) pages.push(...await locs(sitemap));
  return pages;
}

function visibleText(html: string): string {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&rsaquo;/g, "\u203a")
    .replace(/\s+/g, " ")
    .replace(/\u2019/g, "'");
}

function contactLinksInFooters(html: string): number[] {
  return (html.match(FOOTERS) ?? []).map(footer => (footer.match(CONTACT_LINK) ?? []).length);
}

before(async () => { proc = await startServer(); });
after(() => { if (proc) proc.kill(); });

describe("#1084 /contact", () => {
  it("answers 200 under the heading Contact and prints the address as text in each of the four places the page gives it", async () => {
    const res = await fetch(`${base}/contact`);
    assert.strictEqual(res.status, 200);
    const html = await res.text();
    assert.deepStrictEqual([...html.matchAll(/<h1>([^<]*)<\/h1>/g)].map(m => m[1]), ["Contact"]);
    const body = visibleText(html.slice(html.indexOf("<h1>")));
    assert.strictEqual(body.split(CONTACT_EMAIL).length - 1, 4);
    assert.ok(body.includes(`Email: ${CONTACT_EMAIL} `), "the address stands on its own line under the introduction");
  });

  it("gives correcting a listing first, then press and partnerships, then privacy", async () => {
    const html = await text("/contact");
    assert.deepStrictEqual([...html.matchAll(/<h2>([^<]*)<\/h2>/g)].map(m => m[1]), ["Correct a listing", "Press and partnerships", "Privacy"]);
  });

  it("says a vendor may write to correct the listing about its own product, and what a correction needs", async () => {
    const body = visibleText(await text("/contact"));
    assert.ok(body.includes("Anyone may write to correct a listing that is wrong or out of date. That includes the vendor whose product the listing describes."));
    assert.ok(body.includes(`Email ${CONTACT_EMAIL}. Include the AgentDeals page URL and a link to the vendor's own public page stating the current terms. We correct listings from vendors' public pages, so a correction needs a link to one.`));
  });

  it("names the address for press and privacy requests and links the privacy policy", async () => {
    const html = await text("/contact");
    const body = visibleText(html);
    assert.ok(body.includes(`Press and partnership enquiries go to ${CONTACT_EMAIL}.`));
    assert.ok(body.includes(`If you believe personal information about you has reached us, email ${CONTACT_EMAIL} and we will remove it. The privacy policy is at /privacy .`));
    assert.ok(html.includes('The privacy policy is at <a href="/privacy">/privacy</a>.'));
  });

  for (const moved of ["/about", "/feedback", "/corrections"]) {
    it(`answers ${moved} with a permanent redirect to /contact`, async () => {
      const res = await fetch(`${base}${moved}`, { redirect: "manual" });
      assert.strictEqual(res.status, 301);
      assert.strictEqual(res.headers.get("location"), `${BASE_URL}/contact`);
    });
  }

  it("lists /contact in the pages sitemap and in the page inventory the dates job reads", async () => {
    assert.ok((await locs("/sitemap-pages.xml")).includes("/contact"));
    assert.ok((JSON.parse(readFileSync(INVENTORY, "utf-8")) as string[]).includes("/contact"));
  });

  it("keeps the page inventory the dates job reads equal to the pages the sitemaps list", async () => {
    const inventory = JSON.parse(readFileSync(INVENTORY, "utf-8")) as string[];
    const listed = await everySitemapPage();
    assertPopulationFloor(listed.length, 1850, "pages the sitemaps list");
    assert.deepStrictEqual([...new Set(inventory)].sort(), [...new Set(listed)].sort());
  });
});

describe("#1084 every page links /contact from its footer", () => {
  it("puts one /contact link in every footer the source writes", () => {
    const source = readFileSync(path.join(REPO, "src", "serve.ts"), "utf-8");
    const counts = contactLinksInFooters(source);
    assertPopulationFloor(counts.length, 90, "footers in the source");
    const lines = (source.match(FOOTERS) ?? []).map((footer, i) => `${counts[i]} in ${footer.slice(0, 80)}`);
    assert.deepStrictEqual(lines.filter(line => !line.startsWith("1 in ")), []);
  });

  it("serves every page in the sitemaps with exactly one footer, and that footer links /contact once", async () => {
    const pages = await everySitemapPage();
    assertPopulationFloor(pages.length, 1850, "pages the sitemaps list");
    const wrong: string[] = [];
    for (let i = 0; i < pages.length; i += 16) {
      await Promise.all(pages.slice(i, i + 16).map(async page => {
        const res = await fetch(`${base}${page}`);
        if (!/^text\/html/.test(res.headers.get("content-type") ?? "")) { await res.arrayBuffer(); return; }
        const counts = contactLinksInFooters(await res.text());
        if (counts.length !== 1 || counts[0] !== 1) wrong.push(`${page}: ${JSON.stringify(counts)}`);
      }));
    }
    assert.deepStrictEqual(wrong.sort(), []);
  });
});
