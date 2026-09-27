import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertPopulationFloor } from "./population-floor.ts";

const { toSlug } = await import("../dist/slug.js");
const { readModelRates } = await import("../dist/model-rates.js");

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(__dirname, "..");

const PAGES = ["/llm-api-pricing", "/free-llm-apis", "/ai-free-tiers", "/gemini-api-pricing-2026"];
const SUBJECT = "Groq";
const SUBJECT_SLUG = "groq";
const SYNTHETIC_TERMS = "Free plan: 17 requests a minute on Zorblax-9B. Zorblax-9B $0.13/$0.47.";
const SYNTHETIC_TIER = "Free (Zorblax)";
const BLANK_TERMS = "Terms replaced for this check.";
const BLANK_TIER = "Replaced tier";

type Offer = { vendor: string; tier: string; description: string };
type Catalogue = { offers: Offer[] };

const shipped: Catalogue = JSON.parse(readFileSync(path.join(REPO, "data", "index.json"), "utf8"));
const subjectOffer = shipped.offers.find((o) => o.vendor === SUBJECT)!;

function catalogueWith(change: (offer: Offer) => Offer): Catalogue {
  return { ...shipped, offers: shipped.offers.map(change) };
}

async function servePages(catalogue: Catalogue): Promise<Map<string, string>> {
  const dir = mkdtempSync(path.join(tmpdir(), "llm-tables-"));
  const indexPath = path.join(dir, "index.json");
  writeFileSync(indexPath, JSON.stringify(catalogue));
  const proc: ChildProcess = spawn("node", [path.join(REPO, "dist", "serve.js")], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, PORT: "0", BASE_URL: "http://localhost", TZ: "UTC", AGENTDEALS_INDEX_PATH: indexPath },
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
    const served = new Map<string, string>();
    for (const page of PAGES) served.set(page, await (await fetch(`${base}${page}`)).text());
    return served;
  } finally {
    proc.kill();
    rmSync(dir, { recursive: true, force: true });
  }
}

const ENTITIES: Record<string, string> = {
  "&mdash;": "—", "&ndash;": "–", "&amp;": "&", "&quot;": '"', "&#39;": "'", "&#x27;": "'",
  "&rsquo;": "’", "&nbsp;": " ", "&darr;": "↓", "&rarr;": "→", "&middot;": "·",
};

function readable(html: string): string {
  return html.replace(/<[^>]+>/g, " ").replace(/&[a-z#0-9]+;/gi, (e) => ENTITIES[e] ?? e).replace(/\s+/g, " ").trim();
}

function listingTables(html: string): string[] {
  return [...html.matchAll(/<table\b[^>]*data-figures="index"[^>]*>[\s\S]*?<\/table>/gi)].map((m) => m[0]);
}

function bodyRows(table: string): string[][] {
  const body = table.slice(table.indexOf("<tbody>"));
  return [...body.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)].map((row) =>
    [...row[1].matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map((cell) => cell[1]),
  );
}

function rowFor(table: string, slug: string): string[] | undefined {
  return bodyRows(table).find((cells) => cells[0]?.includes(`href="/vendor/${slug}"`));
}

const NOTICES = /<span class="(?:listing-terms-unconfirmed|listing-terms-free-price|listing-read-contradicts)"[^>]*>[\s\S]*?<\/span>/gi;

describe("the LLM provider tables on the AI guides read each vendor's listing", () => {
  let changed = new Map<string, string>();
  let blanked = new Map<string, string>();

  before(async () => {
    changed = await servePages(catalogueWith((o) => (o.vendor === SUBJECT ? { ...o, tier: SYNTHETIC_TIER, description: SYNTHETIC_TERMS } : o)));
    blanked = await servePages(catalogueWith((o) => ({ ...o, tier: BLANK_TIER, description: BLANK_TERMS })));
  });

  it("has a listing-backed table on every page, each with a row for the subject vendor", () => {
    for (const page of PAGES) {
      const tables = listingTables(changed.get(page)!);
      assert.ok(tables.some((table) => rowFor(table, SUBJECT_SLUG)), `${page} has no listing-backed table with a ${SUBJECT} row`);
    }
  });

  it("renders a changed listing's terms, tier and rate in every table, and none of the listing's shipped text", () => {
    const shippedOpening = subjectOffer.description.split(/(?<=[.!?])\s+/)[0];
    const problems: string[] = [];
    for (const page of PAGES) {
      for (const table of listingTables(changed.get(page)!)) {
        const cells = rowFor(table, SUBJECT_SLUG);
        if (!cells) continue;
        const row = readable(cells.join(" "));
        const expected = [
          ...(table.includes("<th>Free Tier</th>") ? ["17 requests a minute on Zorblax-9B"] : []),
          ...(table.includes("<th>Paid Rate</th>") ? ["$0.13/$0.47 (Zorblax-9B)"] : []),
          ...(table.includes("<th>Recorded Tier</th>") ? [SYNTHETIC_TIER] : []),
        ];
        if (expected.length === 0) problems.push(`${page}: a listing-backed table shows neither terms, rate nor tier`);
        for (const text of expected) {
          if (!row.includes(text)) problems.push(`${page}: no "${text}" in ${row}`);
        }
        if (row.includes(shippedOpening)) problems.push(`${page}: still prints "${shippedOpening}"`);
      }
    }
    assert.deepStrictEqual(problems, []);
  });

  it("prints each row's recorded tier, and only rates its own listing states", () => {
    const bySlug = new Map<string, Offer>();
    for (const offer of shipped.offers) if (!bySlug.has(toSlug(offer.vendor))) bySlug.set(toSlug(offer.vendor), offer);
    const problems: string[] = [];
    let compared = 0;
    for (const page of PAGES) {
      for (const table of listingTables(changed.get(page)!)) {
        const headers = [...table.matchAll(/<th\b[^>]*>([\s\S]*?)<\/th>/gi)].map((m) => readable(m[1]));
        const tierAt = headers.indexOf("Recorded Tier");
        const rateAt = headers.indexOf("Paid Rate");
        for (const cells of bodyRows(table)) {
          const slug = cells[0]?.match(/href="\/vendor\/([^"#]+)"/)?.[1];
          if (!slug || slug === SUBJECT_SLUG || cells.length !== headers.length) continue;
          const record = bySlug.get(slug);
          if (!record) {
            problems.push(`${page}: no listing for ${slug}`);
            continue;
          }
          compared++;
          if (tierAt > 0 && readable(cells[tierAt]) !== record.tier) problems.push(`${page}: ${slug} tier "${readable(cells[tierAt])}", listing "${record.tier}"`);
          if (rateAt > 0) {
            const listed = new Set(readModelRates(record.description).map((r: { input: string; output: string | null }) => `${r.input}/${r.output}`));
            for (const pair of readable(cells[rateAt]).match(/\$[\d.,]+\/\$[\d.,]+/g) ?? []) {
              if (!listed.has(pair)) problems.push(`${page}: ${slug} prints ${pair}, which its listing does not state`);
            }
          }
        }
      }
    }
    assertPopulationFloor(compared, 30, "listing-backed rows compared with their own listing");
    assert.deepStrictEqual(problems, []);
  });

  it("types no figure into a table cell, so blanking every listing leaves no number beside a provider's name", () => {
    const typed: string[] = [];
    let rows = 0;
    for (const page of PAGES) {
      for (const table of listingTables(blanked.get(page)!)) {
        for (const cells of bodyRows(table)) {
          rows++;
          const rest = readable(cells.slice(1).join(" | ").replace(NOTICES, " "));
          if (/\d/.test(rest)) typed.push(`${page}: ${readable(cells[0] ?? "")} | ${rest}`);
        }
      }
    }
    assert.ok(rows >= PAGES.length, `read only ${rows} rows`);
    assert.deepStrictEqual(typed, []);
  });
});
