import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertPopulationFloor } from "./population-floor.ts";

const { loadOffers } = await import("../dist/data.js");

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(__dirname, "..");

const AN_ENTITY = /&(?:quot|amp|lt|gt|#39);/;
const AN_ESCAPED_ENTITY = /&amp;(?:quot|amp|lt|gt|#39);/;
const A_CHARACTER_THE_RENDER_MUST_ESCAPE = /["&<>]/;

const READERS = 12;

function startServer(): Promise<{ proc: ChildProcess; base: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn("node", [path.join(REPO, "dist", "serve.js")], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, PORT: "0", BASE_URL: "http://localhost", TZ: "UTC" },
    });
    const timeout = setTimeout(() => { child.kill(); reject(new Error("Server startup timeout")); }, 120000);
    child.stderr!.on("data", (data: Buffer) => {
      const m = data.toString().match(/running on http:\/\/localhost:(\d+)/);
      if (m) { clearTimeout(timeout); resolve({ proc: child, base: `http://localhost:${m[1]}` }); }
    });
    child.on("error", (err) => { clearTimeout(timeout); reject(err); });
  });
}

function answersInTheBody(html: string): string[] {
  return [...html.matchAll(/<div class="faq-a">([\s\S]*?)<\/div>/g)].map(([, body]) => body);
}

function answersInTheStructuredData(html: string): string[] {
  const found: string[] = [];
  for (const block of html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)) {
    let parsed: unknown;
    try { parsed = JSON.parse(block[1]!); } catch { continue; }
    const visit = (node: unknown): void => {
      if (!node || typeof node !== "object") return;
      if (Array.isArray(node)) { node.forEach(visit); return; }
      const record = node as Record<string, unknown>;
      if (record["@type"] === "Answer" && typeof record.text === "string") found.push(record.text);
      Object.values(record).forEach(visit);
    };
    visit(parsed);
  }
  return found;
}

describe("a served answer quotes a record once, whatever characters the record holds", () => {
  let server: { proc: ChildProcess; base: string } | null = null;
  const escapedTwice: string[] = [];
  const entityInStructuredData: string[] = [];
  let answersRead = 0;
  let structuredAnswersRead = 0;
  let pagesRead = 0;

  before(async () => {
    server = await startServer();
    const sitemap = await (await fetch(`${server.base}/sitemap-vendors.xml`)).text();
    const routes = [...sitemap.matchAll(/<loc>([^<]*\/vendor\/[^<]*)<\/loc>/g)]
      .map(([, url]) => new URL(url).pathname);

    let next = 0;
    await Promise.all(Array.from({ length: READERS }, async () => {
      while (next < routes.length) {
        const route = routes[next++];
        const response = await fetch(server!.base + route);
        if (!response.ok) continue;
        const html = await response.text();
        pagesRead += 1;
        for (const answer of answersInTheBody(html)) {
          answersRead += 1;
          if (AN_ESCAPED_ENTITY.test(answer)) {
            escapedTwice.push(`${route}: ${(answer.match(/.{0,40}&amp;(?:quot|amp|lt|gt|#39);.{0,40}/) ?? [""])[0]}`);
          }
        }
        for (const answer of answersInTheStructuredData(html)) {
          structuredAnswersRead += 1;
          if (AN_ENTITY.test(answer)) {
            entityInStructuredData.push(`${route}: ${(answer.match(/.{0,40}&(?:quot|amp|lt|gt|#39);.{0,40}/) ?? [""])[0]}`);
          }
        }
      }
    }));
  });

  after(() => { server?.proc.kill(); });

  it("reads every vendor page the sitemap publishes, and enough records holding a character the render escapes", () => {
    assertPopulationFloor(pagesRead, 1000, "vendor pages read for the sweeps below");
    assertPopulationFloor(answersRead, 3000, "answers read in the body of a vendor page");
    assertPopulationFloor(structuredAnswersRead, 3000, "answers read in a vendor page's structured data");
    assertPopulationFloor(
      loadOffers().filter((offer: { description?: string }) =>
        A_CHARACTER_THE_RENDER_MUST_ESCAPE.test(offer.description ?? "")).length,
      40,
      "records whose description holds a character the render must escape",
    );
  });

  it("escapes a record's own punctuation once, so the reader is not shown the entity", () => {
    assert.deepStrictEqual(escapedTwice.slice(0, 15), []);
  });

  it("hands structured data the characters themselves, because it is not read as markup", () => {
    assert.deepStrictEqual(entityInStructuredData.slice(0, 15), []);
  });
});
