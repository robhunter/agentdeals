import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

type Offer = import("../src/types.ts").Offer;

const { conditionsHtml } = await import("../dist/listing-conditions.js");
const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const TODAY = new Date().toISOString().slice(0, 10);
const PAIRS = [
  ["cloudflare-pages-vs-vercel", "Cloudflare Pages", "Vercel"],
  ["backblaze-b2-vs-cloudflare-r2", "Backblaze B2", "Cloudflare R2"],
  ["supabase-vs-firebase", "Supabase", "Firebase"],
  ["vercel-vs-netlify", "Vercel", "Netlify"],
  ["neon-vs-supabase", "Neon", "Supabase"],
  ["railway-vs-render", "Railway", "Render"],
  ["datadog-vs-new-relic", "Datadog", "New Relic"],
] as const;
const SUBJECTS = new Set<string>(PAIRS.flatMap(([, a, b]) => [a, b]));
const catalogue = JSON.parse(readFileSync(path.join(REPO, "data/index.json"), "utf8"));
const fixtures: Offer[] = catalogue.offers.map((offer: Offer) => SUBJECTS.has(offer.vendor) ? {
  ...offer,
  tier: "Free",
  description: `${offer.vendor} includes one free project.`,
  verifiedDate: TODAY,
  conditions: [false, true, false, true].map((operating_detail, index) => ({
    text: `${offer.vendor} condition ${index}: accounts & projects <limited>.`,
    quote: `${offer.vendor} condition ${index}.`,
    url: `https://conditions.example/${encodeURIComponent(offer.vendor)}/${index}`,
    read_on: TODAY,
    ...(operating_detail ? { operating_detail } : {}),
  })),
} : offer);
const escaped = (text: string) => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
const dir = mkdtempSync(path.join(tmpdir(), "pair-conditions-"));
writeFileSync(path.join(dir, "index.json"), JSON.stringify({ ...catalogue, offers: fixtures }));
writeFileSync(path.join(dir, "changes.json"), JSON.stringify({ changes: [] }));

let proc: ChildProcess;
let base: string;

before(async () => {
  await new Promise<void>((resolve, reject) => {
    proc = spawn("node", [path.join(REPO, "dist/serve.js")], {
      env: { ...process.env, PORT: "0", BASE_URL: "http://localhost", TZ: "UTC",
        AGENTDEALS_INDEX_PATH: path.join(dir, "index.json"), AGENTDEALS_CHANGES_PATH: path.join(dir, "changes.json") },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const timer = setTimeout(() => { proc.kill(); reject(new Error("server startup timeout")); }, 60000);
    proc.stderr!.on("data", buffer => {
      const match = buffer.toString().match(/running on http:\/\/localhost:(\d+)/);
      if (match) { clearTimeout(timer); base = `http://localhost:${match[1]}`; resolve(); }
    });
    proc.once("error", error => { clearTimeout(timer); reject(error); });
    proc.once("exit", code => { clearTimeout(timer); reject(new Error(`server exited: ${code}`)); });
  });
});

after(async () => {
  if (proc && proc.exitCode === null) {
    await new Promise<void>(resolve => { proc.once("exit", () => resolve()); proc.kill(); });
  }
  rmSync(dir, { recursive: true, force: true });
});

async function page(route: string): Promise<string> {
  const response = await fetch(base + route);
  assert.equal(response.status, 200, route);
  return response.text();
}

describe("two-vendor comparison conditions", () => {
  for (const [slug, a, b] of PAIRS) {
    for (const route of [`/${slug}`, `/compare/${slug}`]) {
      it(`${route} keeps both subjects' complete ordered conditions in their own sections`, async () => {
        const html = await page(route);
        for (const vendor of [a, b]) {
          const offer = fixtures.find(offer => offer.vendor === vendor)!;
          assert.ok(offer?.conditions?.length === 4, vendor);
          const list = conditionsHtml(offer.conditions, escaped);
          const at = html.indexOf(list);
          assert.ok(at >= 0, `${route}: ${vendor} complete list`);
          const before = html.slice(0, at);
          assert.ok(before.endsWith(escaped(offer.description)) || before.endsWith(`${escaped(offer.description)}</p>`) || before.endsWith(`${escaped(offer.description)}</div>`), `${route}: ${vendor} list follows its own terms`);
        }
        for (const vendor of SUBJECTS) {
          if (vendor === a || vendor === b) continue;
          assert.ok(!html.includes(escaped(`${vendor} condition 1:`)), `${route}: unrelated ${vendor} detail`);
        }
      });
    }
  }

  for (const route of ["/category/cloud-hosting", "/hosting-alternatives"]) {
    it(`${route} retains ordinary conditions and excludes operating details`, async () => {
      const html = await page(route);
      assert.ok(html.includes(escaped("Vercel condition 0:")), `${route}: ordinary condition`);
      for (const vendor of SUBJECTS) {
        assert.ok(!html.includes(escaped(`${vendor} condition 1:`)), `${route}: ${vendor} detail`);
      }
    });
  }
});
