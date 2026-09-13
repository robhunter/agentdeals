import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadDealChanges } from "../dist/data.js";
import { resolveVendorSlug, servedVendorSlugForName, toSlug } from "../dist/vendor-slug.js";
import { assertCoversPopulation, type Population } from "./population-floor.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const SURFACES = [
  "/",
  "/changes",
  "/pricing-changes",
  "/expiring",
  "/deadlines",
  "/this-week",
  "/free-tier-tracker",
  "/free-tier-risk",
  "/q1-2026-developer-pricing-report",
  "/q2-pricing-preview-2026",
];

function changeLogNames(): string[] {
  const names = new Set<string>();
  for (const change of loadDealChanges()) {
    names.add(change.vendor);
    for (const alternative of change.alternatives ?? []) names.add(alternative);
  }
  return [...names];
}

function namesAVendorPageAnswers(): Population {
  const answered = changeLogNames().filter((name) => servedVendorSlugForName(name) !== null);
  return { size: answered.length, read: "names in the change log a vendor page answers" };
}

function linkedVendorSlugs(html: string): string[] {
  const rendered = html.replace(/<script[\s\S]*?<\/script>/g, "");
  return [...rendered.matchAll(/href="\/vendor\/([^"#?]*)/g)].map((m) => m[1]!.replace(/\/$/, ""));
}

describe("the change log links no vendor page we do not serve", () => {
  let proc: ChildProcess;
  let base: string;
  const pages = new Map<string, string>();

  before(async () => {
    const serverPath = path.join(__dirname, "..", "dist", "serve.js");
    const started = await new Promise<{ proc: ChildProcess; port: number }>((resolve, reject) => {
      const child = spawn("node", [serverPath], {
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env, PORT: "0", BASE_URL: "http://127.0.0.1" },
      });
      const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("startup timeout")); }, 60000);
      child.stderr?.on("data", (b: Buffer) => {
        const m = b.toString().match(/running on http:\/\/localhost:(\d+)/);
        if (m) { clearTimeout(timer); resolve({ proc: child, port: parseInt(m[1]!, 10) }); }
      });
      child.on("error", (e) => { clearTimeout(timer); reject(e); });
    });
    proc = started.proc;
    base = `http://127.0.0.1:${started.port}`;
    for (const surface of SURFACES) {
      const res = await fetch(base + surface);
      assert.strictEqual(res.status, 200, `${surface} answers ${res.status}`);
      pages.set(surface, await res.text());
    }
  });

  after(() => { proc?.kill("SIGKILL"); });

  for (const surface of SURFACES) {
    it(`serves every vendor page ${surface} links to`, () => {
      const unserved = [...new Set(linkedVendorSlugs(pages.get(surface)!))]
        .filter((slug) => resolveVendorSlug(slug).type === "none");
      assert.deepStrictEqual(unserved, [], `${surface} links ${unserved.length} vendor pages that answer 404`);
    });
  }

  it("renders a change-log name no vendor page answers as text, on every surface", () => {
    const unanswered = changeLogNames().filter((name) => servedVendorSlugForName(name) === null);
    const linked: string[] = [];
    for (const [surface, html] of pages) {
      const slugs = new Set(linkedVendorSlugs(html));
      for (const name of unanswered) {
        if (slugs.has(toSlug(name))) linked.push(`${surface} links ${name}`);
      }
    }
    assert.deepStrictEqual(linked, []);
  });

  it("shows the reader a name no vendor page answers rather than dropping it", () => {
    const html = pages.get("/changes")!;
    const missing = [...new Set(loadDealChanges().map((c) => c.vendor))]
      .filter((name) => servedVendorSlugForName(name) === null)
      .filter((name) => !html.includes(`<span class="chg-vendor">${name}</span>`));
    assert.deepStrictEqual(missing, [], `${missing.length} change-log vendors reach the reader neither as a link nor as text`);
  });

  it("still links every change-log name a vendor page does answer", () => {
    const slugs = new Set(linkedVendorSlugs(pages.get("/changes")!));
    const answered = changeLogNames()
      .map((name) => servedVendorSlugForName(name))
      .filter((slug): slug is string => slug !== null);
    assertCoversPopulation(
      answered.filter((slug) => slugs.has(slug)).length,
      namesAVendorPageAnswers(),
      "names the change log still links",
    );
  });
});
