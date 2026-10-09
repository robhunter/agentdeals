import { describe, it, before } from "node:test";
import assert from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(__dirname, "..");

const { changesByVendor, enrichOffers, loadOffers, refusalsForVendor } = await import("../dist/data.js");
const { toSlug } = await import("../dist/slug.js");
const { LEVEL_WITHHOLDING_OUTCOMES, WHEN_WE_LOOKED, levelWithheldReason, withheldLevelSentence } = await import("../dist/source-check.js");
const { vendorVerdictContextFrom } = await import("../dist/vendor-verdict-input.js");
const { freeTierClaim } = await import("../dist/vendor-verdict.js");

type Row = { vendor: string; url: string; link_unreachable: unknown; gate: unknown; source_check?: { outcome: string } | null };
type Subject = Row & { level: string };

const offers = loadOffers();
const rows = enrichOffers(offers) as Row[];
const changes = changesByVendor();
const servedOn = new Date().toISOString().slice(0, 10);
const listingsPerVendor = new Map<string, number>();
for (const row of rows) listingsPerVendor.set(row.vendor, (listingsPerVendor.get(row.vendor) ?? 0) + 1);

function claimedLevel(vendor: string): string | null {
  const context = vendorVerdictContextFrom({
    vendor,
    vendorOffers: offers.filter((o: { vendor: string }) => o.vendor === vendor),
    vendorChanges: changes.get(vendor.toLowerCase()) ?? [],
    refusedReads: refusalsForVendor(vendor),
    servedOn,
  });
  const claim = context ? freeTierClaim(context.input) : null;
  return claim?.states === "offered" ? claim.level : null;
}

const adverseAndNothingWithheld: Subject[] = rows
  .filter((row) =>
    row.link_unreachable === null &&
    levelWithheldReason({ source_check: row.source_check ?? undefined }, null) === null &&
    row.gate === null &&
    listingsPerVendor.get(row.vendor) === 1)
  .map((row) => ({ ...row, level: claimedLevel(row.vendor) ?? "" }))
  .filter((row) => row.level === "caution" || row.level === "risky");
const subject = adverseAndNothingWithheld[0];
const sourceCheckSubjects = LEVEL_WITHHOLDING_OUTCOMES.map((outcome: string, i: number) => ({ outcome, row: adverseAndNothingWithheld[i + 1] }));

const lastReachable = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
const SOURCE_CHECKED = "2026-09-14";
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

function reliabilityAnswerOf(html: string): string {
  for (const m of html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)) {
    const block = JSON.parse(m[1]!);
    for (const node of [block, ...(block["@graph"] ?? [])]) {
      if (node["@type"] !== "FAQPage") continue;
      const question = (node.mainEntity ?? []).find((q: { name: string }) => /^Is .+ reliable\?$/.test(q.name));
      if (question) return question.acceptedAnswer.text;
    }
  }
  return "";
}

function headingBadgeOf(html: string): string | null {
  const heading = html.match(/<h1>([\s\S]*?)<\/h1>/)?.[1] ?? "";
  return heading.match(/<span class="risk-badge"[^>]*>([^<]*)<\/span>/)?.[1] ?? null;
}

async function served(paths: string[], fixtures: Record<string, unknown>): Promise<string[]> {
  const dir = mkdtempSync(path.join(tmpdir(), "adverse-level-withheld-"));
  const fixtureEnv: Record<string, string> = {};
  for (const [variable, content] of Object.entries(fixtures)) {
    const file = path.join(dir, `${variable}.json`);
    writeFileSync(file, JSON.stringify(content));
    fixtureEnv[variable] = file;
  }
  const proc: ChildProcess = spawn("node", [path.join(REPO, "dist", "serve.js")], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, PORT: "0", BASE_URL: "http://localhost", TZ: "UTC", ...fixtureEnv },
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
    const today = new Date().toISOString().slice(0, 10);
    const [html, api] = await served([`/vendor/${slug}`, `/api/details/${slug}`], {
      AGENTDEALS_LINK_HEALTH_PATH: {
        generated_at: today,
        links: [{ url: subject.url, checked: today, outcome: "unreachable", detail: "GET 404", terminal: false, last_reachable: lastReachable, consecutive_unreachable: 30 }],
      },
    });
    page = html;
    details = JSON.parse(api).offer;
    reliableAnswer = reliabilityAnswerOf(page);
  });

  it("answers whether the free tier is reliable with the level and its recorded change, then the unreachable notice", () => {
    assert.ok(reliableAnswer, `${subject!.vendor}'s page holds no reliability question in its FAQPage JSON-LD`);
    assert.ok(reliableAnswer.includes(LEVEL_SENTENCE[subject!.level]!), reliableAnswer);
    assert.ok(reliableAnswer.endsWith(`${subject!.vendor}'s pricing page has not resolved for us since ${lastReachable}.`), reliableAnswer);
    assert.doesNotMatch(reliableAnswer, /We cannot say|not publishing a stability judgement/);
  });

  it("prints the same answer on the page as in its JSON-LD", () => {
    assert.ok(decoded(page).includes(reliableAnswer), "the page's FAQ section does not carry the JSON-LD answer");
  });

  it("publishes the same level through the API, beside the unreachable notice", () => {
    assert.strictEqual(details.risk_level, subject!.level);
    assert.ok(details.link_unreachable, "the API row carries no unreachable notice");
  });
});

describe("a vendor whose cited page a source check could not confirm keeps the adverse level its record earns, and says both", () => {
  const pages = new Map<string, string>();

  before(async () => {
    for (const { outcome, row } of sourceCheckSubjects) {
      assert.ok(row, `no reachable, ungated, single-listing vendor publishing an adverse level is left to carry a source check that reads ${outcome}`);
    }
    const catalogue = JSON.parse(readFileSync(path.join(REPO, "data", "index.json"), "utf-8"));
    for (const { outcome, row } of sourceCheckSubjects) {
      const listing = catalogue.offers.find((offer: { vendor: string }) => offer.vendor === row!.vendor);
      listing.source_check = { checked: SOURCE_CHECKED, outcome, detail: "a reading held as a fixture" };
    }
    const bodies = await served(sourceCheckSubjects.map(({ row }) => `/vendor/${toSlug(row!.vendor)}`), { AGENTDEALS_INDEX_PATH: catalogue });
    sourceCheckSubjects.forEach(({ outcome }, i) => pages.set(outcome, bodies[i]!));
  });

  for (const { outcome, row } of sourceCheckSubjects) {
    it(`gives the level and its recorded change, then the source check's reading, where that reading is ${outcome}`, () => {
      const page = pages.get(outcome)!;
      const answer = reliabilityAnswerOf(page);
      assert.ok(answer, `${row!.vendor}'s page holds no reliability question in its FAQPage JSON-LD`);
      assert.strictEqual(headingBadgeOf(page), row!.level);
      assert.ok(answer.includes(LEVEL_SENTENCE[row!.level]!), answer);
      assert.ok(answer.endsWith(withheldLevelSentence(outcome, row!.vendor, WHEN_WE_LOOKED(SOURCE_CHECKED))), answer);
      assert.doesNotMatch(answer, /We cannot say|not publishing a stability judgement/);
      assert.ok(decoded(page).includes(answer), "the page's FAQ section does not carry the JSON-LD answer");
    });
  }
});
