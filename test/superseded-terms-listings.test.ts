import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const {
  STORED_TERMS_WITHHELD_PHRASE,
  STORED_TERMS_WITHHELD_META_PHRASE,
  supersedingChange,
  supersededTermsRecord,
} = await import("../dist/superseded-description.js");
const { toSlug } = await import("../dist/slug.js");
const { citedRecords } = await import("../dist/provenance.js");
const { getOfferDetails } = await import("../dist/data.js");

type Offer = import("../src/types.ts").Offer;
type DealChange = import("../src/types.ts").DealChange;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(__dirname, "..");

const offers: Offer[] = JSON.parse(readFileSync(path.join(REPO, "data", "index.json"), "utf-8")).offers;
const changes: DealChange[] = JSON.parse(
  readFileSync(path.join(REPO, "data", "deal_changes.json"), "utf-8"),
).changes;

const byVendor = new Map<string, DealChange[]>();
for (const change of changes) {
  const key = change.vendor.toLowerCase();
  const held = byVendor.get(key);
  if (held) held.push(change);
  else byVendor.set(key, [change]);
}
const changesFor = (vendor: string): DealChange[] => byVendor.get(vendor.toLowerCase()) ?? [];
const supersedingFor = (offer: Offer): DealChange | null => supersedingChange(offer, changesFor(offer.vendor));

const superseded = offers.filter((o) => supersedingFor(o) !== null);
const notSuperseded = offers.filter((o) => supersedingFor(o) === null);

const HEAD = 45;
const squash = (text: string): string => text.replace(/\s+/g, " ").trim();
const decodeEntities = (text: string): string =>
  text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&mdash;/g, "—")
    .replace(/&ldquo;/g, "“")
    .replace(/&rdquo;/g, "”")
    .replace(/&hellip;/g, "…")
    .replace(/&amp;/g, "&");
const withoutTags = (markup: string): string => decodeEntities(squash(markup.replace(/<[^>]*>/g, " ")));

const headOf = (offer: Offer): string => squash(offer.description).slice(0, HEAD);

function publishesStoredTerms(slot: string, offer: Offer): boolean {
  const shown = squash(slot).replace(/(\.\.\.|…)$/, "");
  const stored = squash(offer.description);
  if (shown.length < 25) return false;
  if (stored.startsWith(shown.slice(0, HEAD))) return true;
  return stored.length >= HEAD && shown.includes(stored.slice(0, HEAD));
}

const STACK_AND_TABLE_PAGES = [
  "/free-saas-stack", "/free-go-stack", "/free-fastapi-stack", "/free-django-stack",
  "/free-nextjs-stack", "/free-frontend-stack", "/free-devops-stack", "/free-ai-stack",
  "/free-startup-stack", "/x402-services", "/agent-payments", "/agent-stack",
  "/events/google-io-2026", "/events/microsoft-build-2026", "/events/google-cloud-next-2026",
  "/cloudinary-vs-imagekit", "/github-actions-vs-gitlab-ci", "/circleci-vs-github-actions",
  "/datadog-vs-grafana-cloud", "/datadog-vs-new-relic", "/vercel-vs-netlify",
  "/redis-alternatives", "/auth0-alternatives", "/vercel-alternatives", "/ai-free-tiers",
];

const SLOT_PATTERNS: RegExp[] = [
  /<td[^>]*>([\s\S]*?)<\/td>/g,
  /<td style="color:var\(--text-muted\)">([\s\S]*?)<\/td>/g,
  /<td style="color:var\(--text-muted\);max-width:300px">([\s\S]*?)<\/td>/g,
  /<td style="color:var\(--text-muted\);font-size:\.85rem">([\s\S]*?)<\/td>/g,
  /<p class="alt-card-desc">([\s\S]*?)<\/p>/g,
  /<p class="best-pick-review">([\s\S]*?)<\/p>/g,
  /<p class="pick-limits">([\s\S]*?)<\/p>/g,
  /<div class="result-desc">([\s\S]*?)<\/div>/g,
  /<div class="desc-block">([\s\S]*?)<\/div>/g,
  /<div class="faq-a">([\s\S]*?)<\/div>/g,
];

function visibleTermSlots(html: string): string[] {
  const withoutStructuredData = html.replace(/<script type="application\/ld\+json">[\s\S]*?<\/script>/g, "");
  const slots: string[] = [];
  for (const pattern of SLOT_PATTERNS) {
    for (const match of withoutStructuredData.matchAll(pattern)) slots.push(withoutTags(match[1]));
  }
  return slots;
}

function structuredDescriptions(html: string): string[] {
  const found: string[] = [];
  const visit = (node: unknown): void => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) { node.forEach(visit); return; }
    const record = node as Record<string, unknown>;
    if (typeof record.description === "string") found.push(record.description);
    Object.values(record).forEach(visit);
  };
  for (const match of html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)) {
    try { visit(JSON.parse(match[1])); } catch { continue; }
  }
  return found;
}

function startServer(): Promise<{ proc: ChildProcess; port: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn("node", [path.join(REPO, "dist", "serve.js")], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, PORT: "0", BASE_URL: "http://localhost", TZ: "UTC" },
    });
    const timeout = setTimeout(() => { child.kill(); reject(new Error("Server startup timeout")); }, 60000);
    child.stderr!.on("data", (data: Buffer) => {
      const m = data.toString().match(/running on http:\/\/localhost:(\d+)/);
      if (m) { clearTimeout(timeout); resolve({ proc: child, port: parseInt(m[1], 10) }); }
    });
    child.on("error", (err) => { clearTimeout(timeout); reject(err); });
  });
}

describe("#1395 the listing surfaces answer the stored-terms question the way the vendor page answers it", () => {
  let server: { proc: ChildProcess; port: number } | null = null;
  const pages = new Map<string, string>();
  let base = "";

  const categoryPaths = [...new Set(offers.map((o) => `/category/${toSlug(o.category)}`))];
  const searchPaths = superseded.slice(0, 40).map((o) => `/search?q=${encodeURIComponent(o.vendor)}`);
  const alternativePaths = [...new Set(superseded.map((o) => `/alternative-to/${toSlug(o.vendor)}`))];

  before(async () => {
    server = await startServer();
    base = `http://localhost:${server.port}`;
    const queue = [
      ...categoryPaths,
      ...searchPaths,
      ...alternativePaths,
      ...STACK_AND_TABLE_PAGES,
      "/best/free-testing",
      "/best/free-monitoring",
    ];
    let next = 0;
    await Promise.all(
      Array.from({ length: 12 }, async () => {
        while (next < queue.length) {
          const pathname = queue[next++];
          const response = await fetch(base + pathname);
          if (response.ok) pages.set(pathname, await response.text());
        }
      }),
    );
  });

  after(() => { server?.proc.kill(); });

  it("has records on both sides of the question, so neither direction below is vacuous", () => {
    assert.ok(superseded.length > 100, `only ${superseded.length} records carry superseded stored terms`);
    assert.ok(notSuperseded.length > 1000, `only ${notSuperseded.length} records carry current stored terms`);
    assert.strictEqual(
      pages.size,
      categoryPaths.length + searchPaths.length + alternativePaths.length + STACK_AND_TABLE_PAGES.length + 2,
    );
  });

  it("publishes no superseded stored terms in a visible listing slot", () => {
    const published: string[] = [];
    for (const [pathname, html] of pages) {
      const slots = visibleTermSlots(html);
      for (const offer of superseded) {
        if (slots.some((slot) => publishesStoredTerms(slot, offer))) published.push(`${pathname} ${offer.vendor}`);
      }
    }
    assert.deepStrictEqual(published.slice(0, 25), []);
  });

  it("publishes no superseded stored terms in structured data either", () => {
    const published: string[] = [];
    for (const [pathname, html] of pages) {
      const descriptions = structuredDescriptions(html).map(decodeEntities);
      for (const offer of superseded) {
        if (descriptions.some((description) => publishesStoredTerms(description, offer))) {
          published.push(`${pathname} ${offer.vendor}`);
        }
      }
    }
    assert.deepStrictEqual(published.slice(0, 25), []);
  });

  it("still publishes the stored terms of the records the vendor page publishes", () => {
    let publishing = 0;
    for (const html of pages.values()) {
      const slots = visibleTermSlots(html);
      for (const offer of notSuperseded) {
        if (slots.some((slot) => publishesStoredTerms(slot, offer))) publishing++;
      }
    }
    assert.ok(publishing > 300, `only ${publishing} listing slots publish stored terms that are current`);
  });

  it("names the change that superseded the terms wherever a category row withholds them", () => {
    const silent: string[] = [];
    for (const offer of superseded) {
      const html = pages.get(`/category/${toSlug(offer.category)}`);
      if (!html) continue;
      const row = new RegExp(
        `<td[^>]*><a href="/vendor/${toSlug(offer.vendor)}"[\\s\\S]*?</tr>`,
      ).exec(html)?.[0];
      if (!row) continue;
      const text = withoutTags(row);
      if (!text.includes(STORED_TERMS_WITHHELD_PHRASE)) silent.push(offer.vendor);
    }
    assert.deepStrictEqual(silent.slice(0, 25), []);
  });

  it("keeps the category table cell and its structured description saying the same thing", () => {
    const disagreeing: string[] = [];
    for (const offer of superseded) {
      const html = pages.get(`/category/${toSlug(offer.category)}`);
      if (!html) continue;
      const named = structuredDescriptions(html)
        .filter((description) => description.includes(offer.vendor))
        .map(decodeEntities);
      if (named.some((description) => publishesStoredTerms(description, offer))) disagreeing.push(offer.vendor);
    }
    assert.deepStrictEqual(disagreeing.slice(0, 25), []);
  });

  it("shortens the withholding rather than the stored terms in a search result", async () => {
    const withStoredTerms: string[] = [];
    for (const offer of superseded.slice(0, 40)) {
      const html = pages.get(`/search?q=${encodeURIComponent(offer.vendor)}`);
      if (!html) continue;
      const slots = [...html.matchAll(/<div class="result-desc">([\s\S]*?)<\/div>/g)].map((m) => withoutTags(m[1]));
      if (slots.some((slot) => publishesStoredTerms(slot, offer))) withStoredTerms.push(offer.vendor);
      assert.ok(
        slots.some((slot) => slot.includes(STORED_TERMS_WITHHELD_META_PHRASE) || slot.includes(STORED_TERMS_WITHHELD_PHRASE)),
        `no search result for ${offer.vendor} says the stored terms are superseded`,
      );
    }
    assert.deepStrictEqual(withStoredTerms, []);
  });

  it("marks the superseded record on every offer the API returns", async () => {
    const payload = await (await fetch(`${base}/api/offers?limit=2000`)).json();
    const rows: Record<string, any>[] = payload.offers;
    assert.strictEqual(rows.length, offers.length);

    const unmarked = rows
      .filter((row) => superseded.some((o) => o.vendor === row.vendor && o.category === row.category))
      .filter((row) => !row.terms_superseded)
      .map((row) => row.vendor);
    assert.deepStrictEqual(unmarked.slice(0, 25), []);

    const wronglyMarked = rows
      .filter((row) => notSuperseded.some((o) => o.vendor === row.vendor && o.category === row.category))
      .filter((row) => row.terms_superseded)
      .map((row) => row.vendor);
    assert.deepStrictEqual(wronglyMarked.slice(0, 25), []);
  });

  it("carries the reading behind the change and the sentence the vendor page prints", async () => {
    const offer = superseded.find((o) => {
      const change = supersedingFor(o)!;
      return change.source_url && change.current_state;
    })!;
    const change = supersedingFor(offer)!;
    const payload = await (await fetch(`${base}/api/details/${encodeURIComponent(offer.vendor)}`)).json();
    const marked = payload.offer.terms_superseded;
    assert.deepStrictEqual(marked, supersededTermsRecord(offer.vendor, change));
    assert.strictEqual(marked.change_date, change.date);
    assert.strictEqual(marked.summary, change.summary);
    assert.strictEqual(marked.reading.url, change.source_url);
    assert.strictEqual(marked.reading.terms, change.current_state!.trim());
    assert.ok(marked.notice.includes(change.current_state!.trim().slice(0, 40)));
    assert.ok(marked.notice.includes(STORED_TERMS_WITHHELD_PHRASE));
  });

  it("counts a reading on nearly every marked record, so the field above is not an exception", async () => {
    const payload = await (await fetch(`${base}/api/offers?limit=2000`)).json();
    const marked: Record<string, any>[] = payload.offers.filter((row: any) => row.terms_superseded);
    const withAReading = marked.filter((row) => row.terms_superseded.reading);
    assert.ok(
      withAReading.length > marked.length * 0.9,
      `only ${withAReading.length} of ${marked.length} marked records carry the reading behind the change`,
    );
  });

  it("does not lead a category on a record whose terms it withholds", () => {
    const leading: string[] = [];
    for (const [pathname, html] of pages) {
      if (!pathname.startsWith("/category/")) continue;
      const intro = /<div class="cat-intro">([\s\S]*?)<\/div>/.exec(html)?.[1] ?? "";
      const text = withoutTags(intro);
      for (const offer of superseded) {
        if (text.includes(`${offer.vendor} leads with`)) leading.push(`${pathname} ${offer.vendor}`);
      }
    }
    assert.deepStrictEqual(leading, []);
  });

  it("returns the verdict fields on a single vendor that the listing endpoint returns", async () => {
    const fields = ["risk_level", "risk_cause", "rating_withheld", "recent_change", "stability", "terms_superseded"];
    const missing: string[] = [];
    for (const offer of offers.slice(0, 40)) {
      const payload = await (await fetch(`${base}/api/details/${encodeURIComponent(offer.vendor)}`)).json();
      if (!payload.offer) continue;
      for (const field of fields) {
        if (!(field in payload.offer)) missing.push(`${offer.vendor}.${field}`);
      }
    }
    assert.deepStrictEqual(missing.slice(0, 25), []);
  });

  it("gives the vendor tool the same fields the endpoint gives", () => {
    const offer = superseded[0];
    const result = getOfferDetails(offer.vendor, true) as { offer: Record<string, unknown> };
    for (const field of ["risk_level", "risk_cause", "rating_withheld", "recent_change", "stability", "terms_superseded"]) {
      assert.ok(field in result.offer, `getOfferDetails omits ${field}`);
    }
    assert.ok(result.offer.terms_superseded);
    assert.ok((result.offer.alternatives as Record<string, unknown>[]).every((a) => "risk_level" in a));
  });

  it("counts a record as withheld when the site declines to publish its terms", () => {
    const stored = { vendor: "Quotacorp", verifiedDate: "2026-08-01", category: "Cloud Hosting" };
    assert.strictEqual(citedRecords({ offer: { ...stored } })[0].withheld, false);
    assert.strictEqual(
      citedRecords({ offer: { ...stored, terms_superseded: { notice: "..." } } })[0].withheld,
      true,
    );
    assert.strictEqual(citedRecords({ offer: { ...stored, risk_level: null } })[0].withheld, true);
    assert.strictEqual(
      citedRecords({ offer: { ...stored, rating_withheld: { reason: "no_source", records: 1 } } })[0].withheld,
      true,
    );
    assert.strictEqual(citedRecords({ offer: { ...stored, risk_level: "stable" } })[0].withheld, false);
  });

  it("counts fewer records as verified than it holds, on the endpoint that returns them all", async () => {
    const payload = await (await fetch(`${base}/api/offers?limit=2000`)).json();
    const provenance = payload._provenance;
    const rows: Record<string, any>[] = payload.offers;
    const withheld = rows.filter(
      (row) =>
        (row.gate && typeof row.gate.code === "string") ||
        row.terms_superseded ||
        row.rating_withheld ||
        row.risk_level === null,
    );
    assert.strictEqual(provenance.withheld_records, withheld.length);
    assert.strictEqual(provenance.verified_records, rows.length - withheld.length);
    assert.ok(provenance.verified_records < 1413, `verified_records is ${provenance.verified_records}`);
  });
});
