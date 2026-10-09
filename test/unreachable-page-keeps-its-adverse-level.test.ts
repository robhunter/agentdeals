import { describe, it, before } from "node:test";
import assert from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(__dirname, "..");

const { enrichOffers, loadOffers } = await import("../dist/data.js");
const { toSlug } = await import("../dist/slug.js");

type Row = { vendor: string; url: string; risk_level: string | null; link_unreachable: unknown; gate: unknown };

const rows = enrichOffers(loadOffers()) as Row[];
const listingsPerVendor = new Map<string, number>();
for (const row of rows) listingsPerVendor.set(row.vendor, (listingsPerVendor.get(row.vendor) ?? 0) + 1);
const subject = rows.find((row) =>
  (row.risk_level === "caution" || row.risk_level === "risky") &&
  row.link_unreachable === null &&
  row.gate === null &&
  listingsPerVendor.get(row.vendor) === 1,
);

const lastReachable = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
const LEVEL_SENTENCE: Record<string, string> = {
  caution: "requires caution because of one specific recorded change",
  risky: "is considered risky because of one specific recorded change",
};

function decoded(html: string): string {
  return html
    .replace(/&#39;|&rsquo;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

async function served(paths: string[]): Promise<string[]> {
  const dir = mkdtempSync(path.join(tmpdir(), "unreachable-adverse-"));
  const healthPath = path.join(dir, "link_health.json");
  const today = new Date().toISOString().slice(0, 10);
  writeFileSync(healthPath, JSON.stringify({
    generated_at: today,
    links: [{ url: subject!.url, checked: today, outcome: "unreachable", detail: "GET 404", terminal: false, last_reachable: lastReachable, consecutive_unreachable: 30 }],
  }));
  const proc: ChildProcess = spawn("node", [path.join(REPO, "dist", "serve.js")], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, PORT: "0", BASE_URL: "http://localhost", TZ: "UTC", AGENTDEALS_LINK_HEALTH_PATH: healthPath },
  });
  try {
    const base = await new Promise<string>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Server startup timeout")), 30000);
      proc.stderr!.on("data", (data: Buffer) => {
        const match = data.toString().match(/running on http:\/\/localhost:(\d+)/);
        if (match) {
          clearTimeout(timeout);
          resolve(`http://localhost:${match[1]}`);
        }
      });
      proc.on("error", (err) => {
        clearTimeout(timeout);
        reject(err);
      });
    });
    const bodies: string[] = [];
    for (const p of paths) {
      const response = await fetch(`${base}${p}`);
      assert.strictEqual(response.status, 200, `${p} answered ${response.status}`);
      bodies.push(await response.text());
    }
    return bodies;
  } finally {
    proc.kill();
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("a vendor whose pricing page stopped resolving keeps the adverse level its record earns, and says both", () => {
  let page = "";
  let details: { risk_level?: string | null; link_unreachable?: unknown } = {};
  let reliableAnswer = "";

  before(async () => {
    assert.ok(subject, "no reachable, ungated, single-listing vendor publishes an adverse level, so there is no subject to make unreachable");
    const slug = toSlug(subject.vendor);
    const [html, api] = await served([`/vendor/${slug}`, `/api/details/${slug}`]);
    page = html;
    details = JSON.parse(api).offer;
    for (const m of page.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)) {
      const block = JSON.parse(m[1]!);
      for (const node of [block, ...(block["@graph"] ?? [])]) {
        if (node["@type"] !== "FAQPage") continue;
        const question = (node.mainEntity ?? []).find((q: { name: string }) => /^Is .+ reliable\?$/.test(q.name));
        if (question) reliableAnswer = question.acceptedAnswer.text;
      }
    }
  });

  it("answers whether the free tier is reliable with the level and its recorded change, then the unreachable notice", () => {
    assert.ok(reliableAnswer, `${subject!.vendor}'s page holds no reliability question in its FAQPage JSON-LD`);
    assert.ok(reliableAnswer.includes(LEVEL_SENTENCE[subject!.risk_level!]!), reliableAnswer);
    assert.ok(reliableAnswer.endsWith(`${subject!.vendor}'s pricing page has not resolved for us since ${lastReachable}.`), reliableAnswer);
    assert.doesNotMatch(reliableAnswer, /We cannot say|not publishing a stability judgement/);
  });

  it("prints the same answer on the page as in its JSON-LD", () => {
    assert.ok(decoded(page).includes(reliableAnswer), "the page's FAQ section does not carry the JSON-LD answer");
  });

  it("publishes the same level through the API, beside the unreachable notice", () => {
    assert.strictEqual(details.risk_level, subject!.risk_level);
    assert.ok(details.link_unreachable, "the API row carries no unreachable notice");
  });
});
