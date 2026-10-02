import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const RETIRED = "Terrateam";
const SURVIVOR = "Stategraph";

function readJson(file: string) {
  return JSON.parse(readFileSync(path.join(REPO, "data", file), "utf8"));
}

function catalogueAfterTheRename() {
  const index = readJson("index.json");
  assert.ok(index.offers.some((offer: { vendor: string }) => offer.vendor === RETIRED || offer.vendor === SURVIVOR), `the catalogue lists ${RETIRED} or ${SURVIVOR}`);
  index.offers = index.offers.map((offer: { vendor: string }) => (offer.vendor === RETIRED ? { ...offer, vendor: SURVIVOR } : offer));
  return index;
}

function mergesAfterTheRename() {
  const merges = readJson("vendor_merges.json");
  if (!merges.merges.some((merge: { retired: string }) => merge.retired === RETIRED)) {
    merges.merges.push({ retired: RETIRED, survivor: SURVIVOR });
  }
  return merges;
}

function startServer(env: NodeJS.ProcessEnv): Promise<{ proc: ChildProcess; port: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn("node", [path.join(REPO, "dist", "serve.js")], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, PORT: "0", BASE_URL: "http://localhost:3000", ...env },
    });
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error("Server startup timeout"));
    }, 40000);
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

function linksTo(html: string, name: string): string[] {
  return [...html.matchAll(/<a href="([^"]*)"[^>]*>([^<]*)<\/a>/g)].filter(([, , label]) => label === name).map(([, href]) => href);
}

function sectionAfter(html: string, heading: string): string {
  const start = html.indexOf(`<h2>${heading}</h2>`);
  assert.ok(start >= 0, `the page has a section headed ${heading}`);
  const end = html.indexOf("<h2", start + 1);
  return html.slice(start, end === -1 ? undefined : end);
}

describe("the infrastructure-as-code pages after a listing is renamed", () => {
  let server: { proc: ChildProcess; port: number };
  let dir = "";
  const pages = new Map<string, string>();

  before(async () => {
    dir = mkdtempSync(path.join(tmpdir(), "iac-renamed-listing-"));
    const write = (file: string, value: unknown) => {
      writeFileSync(path.join(dir, file), JSON.stringify(value));
      return path.join(dir, file);
    };
    server = await startServer({
      AGENTDEALS_INDEX_PATH: write("index.json", catalogueAfterTheRename()),
      AGENTDEALS_MERGES_PATH: write("vendor_merges.json", mergesAfterTheRename()),
    });
    for (const route of ["/terraform-alternatives", "/ci-cd-alternatives"]) {
      const response = await fetch(`http://localhost:${server.port}${route}`, { redirect: "manual" });
      assert.strictEqual(response.status, 200, `${route} renders`);
      pages.set(route, await response.text());
    }
  });

  after(() => {
    server?.proc.kill();
    rmSync(dir, { recursive: true, force: true });
  });

  it("names and links the listing as the catalogue now publishes it in the Terraform alternatives table", () => {
    const html = pages.get("/terraform-alternatives")!;
    const table = [...html.matchAll(/<table[^>]*>[\s\S]*?<\/table>/g)].map(([t]) => t).find((t) => t.includes("<th>Platform</th>"));
    assert.ok(table, "the page has a table of platforms");
    assert.deepStrictEqual(linksTo(table, SURVIVOR), [`/vendor/${SURVIVOR.toLowerCase()}`]);
    assert.deepStrictEqual(linksTo(html, RETIRED), []);
  });

  it("gives the listing's free plan in the Terraform alternatives table: 3 users, 50 runs a month, drift detection, and OPA, Conftest and Checkov policies", () => {
    const html = pages.get("/terraform-alternatives")!;
    const row = [...html.matchAll(/<tr>([\s\S]*?)<\/tr>/g)].map(([, cells]) => cells).find((cells) => linksTo(cells, SURVIVOR).length > 0);
    assert.ok(row, `the table has a row for ${SURVIVOR}`);
    const cells = [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map(([, cell]) => cell.replace(/<[^>]+>/g, "").trim());
    assert.deepStrictEqual(cells, [SURVIVOR, "3", "—", "50/month", "✅ PR-driven", "✅", "✅ OPA + Conftest + Checkov"]);
  });

  it("keeps the listing in the CI/CD alternatives' infrastructure group", () => {
    const group = sectionAfter(pages.get("/ci-cd-alternatives")!, "Infrastructure &amp; Automation");
    const names = [...group.matchAll(/class="alt-card-name">([^<]*)</g)].map(([, name]) => name);
    assert.ok(names.includes(SURVIVOR), `the group lists ${names.join(", ")}`);
    assert.ok(!names.includes(RETIRED), `the group lists ${names.join(", ")}`);
  });

  it("names and links the listing as the catalogue now publishes it in the CI/CD alternatives' answers", () => {
    const html = pages.get("/ci-cd-alternatives")!;
    assert.ok(linksTo(html, SURVIVOR).includes(`/vendor/${SURVIVOR.toLowerCase()}`), "an answer links the listing's page");
    assert.deepStrictEqual(linksTo(html, RETIRED), []);
  });

  it("sends the retired name's vendor page to the listing's page", async () => {
    const response = await fetch(`http://localhost:${server.port}/vendor/${RETIRED.toLowerCase()}`, { redirect: "manual" });
    assert.strictEqual(response.status, 301);
    assert.match(response.headers.get("location") ?? "", new RegExp(`/vendor/${SURVIVOR.toLowerCase()}$`));
  });
});
