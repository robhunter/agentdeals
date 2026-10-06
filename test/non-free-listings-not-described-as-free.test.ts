import { describe, it, before } from "node:test";
import assert from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertPopulationFloor } from "./population-floor.ts";

const { classifyTier } = await import("../dist/ranking.js");
const { offerRetired } = await import("../dist/retirement.js");

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(__dirname, "..");

const PAGES = [
  "/free-llm-apis",
  "/google-developer-program-2026",
  "/llm-api-pricing",
  "/gemini-api-pricing-2026",
  "/ai-ml-alternatives",
  "/ai-free-tiers",
];

type Offer = { vendor: string; tier: string; description?: string };
type Catalogue = { offers: Offer[] };

const shipped: Catalogue = JSON.parse(readFileSync(path.join(REPO, "data", "index.json"), "utf8"));
const changeLog: Record<string, unknown>[] = JSON.parse(readFileSync(path.join(REPO, "data", "deal_changes.json"), "utf8")).changes;

const A_DIMENSION_NOT_A_CLAIM = " (?:limits|details|credits?|removals?|analysis|comparison|data|changes)\\b";

const FREE_CLAIMS: RegExp[] = [
  new RegExp(`\\bfree (?:tiers?|plans?|inference|LLM inference|rate-limited tiers?)\\b(?!${A_DIMENSION_NOT_A_CLAIM})`, "gi"),
  /\bgenuinely free\b/gi,
  /\b\d[\d,.]*\s?[KMB]?\s?(?:tokens?|tok)\s?\/\s?(?:day|24h)\b/gi,
  /\bdaily token (?:volume|quota)\b/gi,
  /\b(?:no|without a) credit card\b/gi,
  /\b\d+ RPM free\b/gi,
  /\bfree (?:(?:AI|ML|AI\/ML|LLM|API|inference|and) ){1,4}(?:providers?|tools?|offers?|APIs?)\b/gi,
];

const DENIED_JUST_BEFORE = /\b(?:no|not a|never a)(?:\s+[a-z]+)?\s+$/i;

const PRODUCT_NAMES: Record<string, string[]> = {
  "Google Gemini API": ["Gemini"],
  "Anthropic API": ["Claude"],
  xAI: ["Grok"],
};

const ENTITIES: Record<string, string> = {
  "&mdash;": "—", "&ndash;": "–", "&amp;": "&", "&quot;": '"', "&#39;": "'", "&#x27;": "'",
  "&rsquo;": "’", "&lsquo;": "‘", "&nbsp;": " ", "&middot;": "·", "&rarr;": "→", "&nearr;": "↗", "&hellip;": "…",
  "&lt;": "<", "&gt;": ">", "&rsaquo;": ">",
};

function decode(text: string): string {
  return text.replace(/&[a-z#0-9]+;/gi, (e) => ENTITIES[e] ?? e);
}

function sentencesOnThePage(html: string): string[] {
  const body = html
    .replace(/<div class="more-guides"[\s\S]*$/i, " ")
    .replace(/<(nav|footer)\b[\s\S]*?<\/\1>/gi, " ")
    .replace(/<a\b[^>]*class="related-page-link"[\s\S]*?<\/a>/gi, " ")
    .replace(/<head[\s\S]*?<\/head>/gi, " ")
    .replace(/<(script|style|svg|thead)\b[\s\S]*?<\/\1>/gi, " ")
    .replace(/<th\b[\s\S]*?<\/th>/gi, " ")
    .replace(/<\/(?:tr|li|dd|dt|p|h[1-6]|div)>|<br\s*\/?>/gi, " \u2029 ")
    .replace(/<\/?(?:a|abbr|b|code|em|i|small|span|strong|sub|sup)\b[^>]*>/gi, "")
    .replace(/<[^>]+>/g, " ");
  const structured: string[] = [];
  for (const m of html.matchAll(/<meta[^>]+content="([^"]*)"/gi)) structured.push(m[1]);
  for (const [, raw] of html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/gi)) {
    const walk = (value: unknown): void => {
      if (typeof value === "string") structured.push(value);
      else if (value && typeof value === "object") Object.values(value).forEach(walk);
    };
    try {
      walk(JSON.parse(raw));
    } catch {
      continue;
    }
  }
  return [body, ...structured]
    .map(decode)
    .flatMap((block) => block.split(/\u2029|(?<=[.!?])\s+(?=[A-Z0-9"“($])/))
    .map((s) => s.replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

function vendorIsFree(catalogue: Catalogue): Map<string, boolean> {
  const free = new Map<string, boolean>();
  for (const offer of catalogue.offers) {
    const thisOne = !offerRetired(offer) && classifyTier(offer.tier).class === "free";
    free.set(offer.vendor, (free.get(offer.vendor) ?? false) || thisOne);
  }
  return free;
}

function aliasesOf(vendor: string): string[] {
  const short = vendor.replace(/(?: API| AI|\.io| Cloud)$/, "");
  return [...new Set([vendor, short, ...(PRODUCT_NAMES[vendor] ?? [])])].filter((name) => name.length >= 3);
}

type Mention = { at: number; end: number; vendor: string };

function escaped(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function mentionsIn(sentence: string, vendors: string[]): Mention[] {
  const found: Mention[] = [];
  for (const vendor of vendors) {
    for (const alias of aliasesOf(vendor)) {
      if (!sentence.includes(alias)) continue;
      for (const m of sentence.matchAll(new RegExp(`(?<![\\w-])${escaped(alias)}(?![\\w-])`, "g"))) {
        found.push({ at: m.index!, end: m.index! + alias.length, vendor });
      }
    }
  }
  found.sort((a, b) => a.at - b.at || b.end - a.end);
  return found.filter((m, i) => !found.slice(0, i).some((earlier) => earlier.at <= m.at && m.end <= earlier.end));
}

const LIST_JOIN = /^\s*(?:,|,?\s+and|,?\s+or|&)\s*$/;

function listContaining(mentions: Mention[], index: number, sentence: string): Mention[] {
  let first = index;
  while (first > 0 && LIST_JOIN.test(sentence.slice(mentions[first - 1].end, mentions[first].at))) first--;
  let last = index;
  while (last < mentions.length - 1 && LIST_JOIN.test(sentence.slice(mentions[last].end, mentions[last + 1].at))) last++;
  return mentions.slice(first, last + 1);
}

function storedSentences(catalogue: Catalogue): string[] {
  const strings: string[] = [];
  const walk = (value: unknown): void => {
    if (typeof value === "string") strings.push(value);
    else if (value && typeof value === "object") Object.values(value).forEach(walk);
  };
  walk(catalogue.offers.map((o) => o.description ?? ""));
  walk(changeLog);
  return [...new Set(strings.flatMap((s) => s.split(/(?<=[.!?])\s+/)).map((s) => s.trim()).filter((s) => s.length >= 20))];
}

const CUT_SHORT = "...";

function quotesItCutShort(sentence: string, at: number, end: number, s: string): boolean {
  const cut = sentence.indexOf(CUT_SHORT, end);
  if (cut < 0) return false;
  const opening = s.slice(0, 20);
  for (let from = sentence.lastIndexOf(opening, at); from >= 0; from = from === 0 ? -1 : sentence.lastIndexOf(opening, from - 1)) {
    if (s.startsWith(sentence.slice(from, cut))) return true;
  }
  return false;
}

function quotesAStoredSentence(sentence: string, at: number, end: number, stored: string[]): boolean {
  return stored.some((s) => {
    for (let from = sentence.indexOf(s); from >= 0; from = sentence.indexOf(s, from + 1)) {
      if (from <= at && end <= from + s.length) return true;
    }
    return quotesItCutShort(sentence, at, end, s);
  });
}

type Scan = { violations: string[]; claimsRead: number; nonFreeVendorsNamed: Set<string> };

function scan(page: string, html: string, catalogue: Catalogue): Scan {
  const free = vendorIsFree(catalogue);
  const vendors = [...free.keys()];
  const stored = storedSentences(catalogue);
  const result: Scan = { violations: [], claimsRead: 0, nonFreeVendorsNamed: new Set() };
  for (const sentence of sentencesOnThePage(html)) {
    const mentions = mentionsIn(sentence, vendors);
    if (mentions.length === 0) continue;
    for (const m of mentions) if (!free.get(m.vendor)) result.nonFreeVendorsNamed.add(m.vendor);
    for (const pattern of FREE_CLAIMS) {
      for (const claim of sentence.matchAll(pattern)) {
        const at = claim.index!;
        const end = at + claim[0].length;
        const justBefore = sentence.slice(Math.max(0, at - 40), at);
        if (DENIED_JUST_BEFORE.test(justBefore)) continue;
        if (quotesAStoredSentence(sentence, at, end, stored)) continue;
        result.claimsRead++;
        const before = mentions.map((m, i) => ({ m, i })).filter(({ m }) => m.end <= at).pop();
        const after = mentions.map((m, i) => ({ m, i })).find(({ m }) => m.at >= end);
        const nearest = before ?? after;
        if (!nearest) continue;
        for (const named of listContaining(mentions, nearest.i, sentence)) {
          if (free.get(named.vendor)) continue;
          result.violations.push(`${page} ${named.vendor} "${claim[0]}": ${sentence.slice(Math.max(0, at - 90), end + 50)}`);
        }
      }
    }
  }
  return result;
}

async function servePages(catalogue: Catalogue): Promise<Map<string, string>> {
  const dir = mkdtempSync(path.join(tmpdir(), "non-free-listings-"));
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
    for (const page of PAGES) {
      const response = await fetch(`${base}${page}`);
      assert.strictEqual(response.status, 200, `${page} answered ${response.status}`);
      served.set(page, await response.text());
    }
    return served;
  } finally {
    proc.kill();
    rmSync(dir, { recursive: true, force: true });
  }
}

function statCard(html: string, label: string): number {
  const m = html.match(new RegExp(`<div class="stat-number[^"]*">(\\d+)</div><div class="stat-label">${escaped(label)}</div>`));
  assert.ok(m, `no "${label}" stat card`);
  return Number(m[1]);
}

function bestFreeTiersBox(html: string): string {
  const box = html.match(/<div class="highlight-box">\s*<h3>Best Free Tiers<\/h3>[\s\S]*?<\/div>/);
  assert.ok(box, "no Best Free Tiers box");
  return decode(box[0].replace(/<[^>]+>/g, " "));
}

const SUBJECT = "Groq";

describe("a vendor whose listing is not a free tier is not described as free on the AI guides", () => {
  let shippedPages = new Map<string, string>();
  let subjectOnATrial = new Map<string, string>();

  before(async () => {
    shippedPages = await servePages(shipped);
    subjectOnATrial = await servePages({
      ...shipped,
      offers: shipped.offers.map((o) => (o.vendor === SUBJECT ? { ...o, tier: "Trial" } : o)),
    });
  });

  it("finds no free-tier claim on any page attributed to a vendor whose listing's tier class is not free", () => {
    const scans = [...shippedPages].map(([page, html]) => scan(page, html, shipped));
    const namedNonFree = new Set(scans.flatMap((s) => [...s.nonFreeVendorsNamed]));
    assertPopulationFloor(namedNonFree.size, 6, "vendors whose listing is not free, named on these pages");
    assertPopulationFloor(scans.reduce((n, s) => n + s.claimsRead, 0), 30, "free-tier claims read on these pages");
    assert.deepStrictEqual([...new Set(scans.flatMap((s) => s.violations))], []);
  });

  it(`stops naming ${SUBJECT} as free on /llm-api-pricing once its listing is a trial, and counts it as one`, () => {
    const before = shippedPages.get("/llm-api-pricing")!;
    const after = subjectOnATrial.get("/llm-api-pricing")!;
    assert.ok(bestFreeTiersBox(before).includes(SUBJECT), `${SUBJECT} is not in the Best Free Tiers box to begin with`);
    assert.ok(!bestFreeTiersBox(after).includes(SUBJECT), `${SUBJECT} stays in the Best Free Tiers box on a trial listing`);
    assert.strictEqual(statCard(after, "Generous Free Tier"), statCard(before, "Generous Free Tier") - 1);
    assert.strictEqual(statCard(after, "Credits / Limited / Trial"), statCard(before, "Credits / Limited / Trial") + 1);
    const intro = after.match(/Free tiers range from genuinely production-viable \(([^)]*)\)/);
    assert.ok(!intro || !intro[1].includes(SUBJECT), `the free-tier section still calls ${SUBJECT} production-viable free: ${intro?.[0]}`);
    const trends = after.match(/Inference providers \(([^)]*)\) are commoditizing/);
    assert.ok(trends && !trends[1].includes(SUBJECT), `the key trends list still names ${SUBJECT}: ${trends?.[0]}`);
  });
});
