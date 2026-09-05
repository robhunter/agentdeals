import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  figuresInTables,
  figuresInSentences,
  disagreements,
} from "../dist/prose-record-crosscheck.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");

let server: ChildProcess;
let base = "";

function startServer(): Promise<ChildProcess> {
  return new Promise((resolve, reject) => {
    const proc = spawn("node", [path.join(root, "dist", "serve.js")], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, PORT: "0", BASE_URL: "http://localhost", TZ: "UTC" },
    });
    const timeout = setTimeout(() => {
      proc.kill();
      reject(new Error("Server startup timeout"));
    }, 20000);
    proc.stderr!.on("data", (data: Buffer) => {
      const match = data.toString().match(/running on http:\/\/localhost:(\d+)/);
      if (match) {
        base = `http://localhost:${match[1]}`;
        clearTimeout(timeout);
        resolve(proc);
      }
    });
    proc.on("error", (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });
}

const ENTITIES: Record<string, string> = {
  "&mdash;": "—", "&ndash;": "–", "&amp;": "&", "&quot;": '"', "&#39;": "'",
  "&nbsp;": " ", "&lt;": "<", "&gt;": ">", "&rarr;": "→", "&#10003;": " ", "&#10007;": " ",
};

function decode(text: string): string {
  return text.replace(/&[a-z#0-9]+;/gi, (e) => ENTITIES[e] ?? e).replace(/\s+/g, " ").trim();
}

function readableText(html: string): string {
  return decode(
    html
      .replace(/<(script|style|svg)\b[\s\S]*?<\/\1>/gi, " ")
      .replace(/<[^>]+>/g, " "),
  );
}

function metaAndStructuredData(html: string): string {
  const parts: string[] = [];
  for (const m of html.matchAll(/<meta[^>]+content="([^"]*)"/gi)) parts.push(m[1]);
  for (const m of html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/gi)) parts.push(m[1]);
  return decode(parts.join(" "));
}

const offers = JSON.parse(readFileSync(path.join(root, "data", "index.json"), "utf-8")).offers as Array<Record<string, any>>;
const changes = (() => {
  const parsed = JSON.parse(readFileSync(path.join(root, "data", "deal_changes.json"), "utf-8"));
  return (Array.isArray(parsed) ? parsed : (parsed.changes ?? parsed.deal_changes ?? [])) as Array<Record<string, any>>;
})();

const recordFor = (vendor: string, category: string) =>
  offers.find((o) => o.vendor === vendor && o.category === category)!;

function storedChangeProse(): string {
  return JSON.stringify(changes).replace(/\\"/g, '"').replace(/\s+/g, " ");
}

type Retired = { what: string; pattern: RegExp; replacedBy: RegExp; vendorRecord: () => string };

const RETIRED_FIGURES: Retired[] = [
  {
    what: "Deno Deploy free egress of 100 GB",
    pattern: /Deno Deploy[^.]{0,90}100 ?GB|100 ?GB[^.]{0,60}(?:egress|outbound bandwidth)[^.]{0,60}Deno/i,
    replacedBy: /20 ?GiB/,
    vendorRecord: () => recordFor("Deno Deploy", "Cloud Hosting").description,
  },
  {
    what: "Deno Deploy free CPU allowance of 15 hours",
    pattern: /15 ?(?:hrs?|hours)[^.,;]{0,16}CPU/i,
    replacedBy: /10 ?(?:hrs?|hours)[^.,;]{0,16}CPU/,
    vendorRecord: () => recordFor("Deno Deploy", "Cloud Hosting").description,
  },
  {
    what: "Deno Deploy request allowance quoted per day",
    pattern: /1M req\/day/i,
    replacedBy: /1M req\/mo/,
    vendorRecord: () => recordFor("Deno Deploy", "Cloud Hosting").description,
  },
  {
    what: "a Koyeb free web service",
    pattern: /Koyeb[^.]{0,120}(?:free web service|nano service free|1 vCPU, 512)/i,
    replacedBy: /Koyeb[^.]{0,160}(?:no free (?:web service|compute)|database.only|only a free Postgres)/i,
    vendorRecord: () => recordFor("Koyeb", "Databases").description,
  },
  {
    what: "Supabase free egress of 2 GB",
    pattern: /2 ?GB egress/i,
    replacedBy: /5 ?GB egress/,
    vendorRecord: () => recordFor("Supabase", "Databases").description,
  },
  {
    what: "a Fly.io free tier for new accounts",
    pattern: /Fly\.io(?:'s)?[^.]{0,70}(?:free tier includes|gives 3 shared|3 shared-cpu VMs)|3 shared-cpu-1x VMs, 160 ?GB|3 shared VMs free|3 shared VMs, 160 ?GB/i,
    replacedBy: /no free tier for new accounts|2 hrs? runtime|2 hours runtime|7-day trial/i,
    vendorRecord: () => recordFor("Fly.io", "Cloud Hosting").description,
  },
  {
    what: "a Sentry free session-replay allowance of 10K",
    pattern: /10K replays|10,000 (?:session )?replays/i,
    replacedBy: /50 (?:session )?replays/i,
    vendorRecord: () => recordFor("Sentry", "Monitoring").description,
  },
  {
    what: "Sentry's free data retention as 90 days",
    pattern: /Sentry[^.|]{0,60}90 days|90 days[^.|]{0,60}Sentry/i,
    replacedBy: /30 days/i,
    vendorRecord: () => recordFor("Sentry", "Monitoring").description,
  },
  {
    what: "a Better Stack free log allowance of 1 GB",
    pattern: /BetterStack[^.|]{0,40}1 ?GB logs|1 ?GB logs[^.|]{0,40}BetterStack/i,
    replacedBy: /3 ?GB logs/i,
    vendorRecord: () => recordFor("BetterStack", "Monitoring").description,
  },
  {
    what: "Railway's $5 Hobby credit described as free",
    pattern: /\$5\/(?:month|mo)(?: free)? credit|\$5 free credit|\$5 credit\/mo|Free \$5 monthly/i,
    replacedBy: /\$1\/(?:month|mo)|trial credit/i,
    vendorRecord: () => recordFor("Railway", "Cloud Hosting").description,
  },
];

type Hit = { route: string; surface: string; excerpt: string; what: string };

const hits: Hit[] = [];
const routes: string[] = [];
let scanned = 0;

async function locs(sitemap: string, seen: Set<string>): Promise<void> {
  const body = await (await fetch(`${base}${sitemap}`)).text();
  for (const m of body.matchAll(/<loc>([^<]+)<\/loc>/g)) {
    const route = m[1].replace(/^https?:\/\/[^/]+/, "");
    if (route.endsWith(".xml")) {
      if (!seen.has(route)) {
        seen.add(route);
        await locs(route, seen);
      }
    } else seen.add(route);
  }
}

function excerptAround(body: string, match: RegExpMatchArray): string {
  const start = Math.max(0, match.index! - 80);
  return body.slice(start, match.index! + match[0].length + 80);
}

const SHORTEST_TRACEABLE_QUOTE = 45;

function quotesStoredChangeRecord(excerpt: string, prose: string): boolean {
  for (let i = 0; i + SHORTEST_TRACEABLE_QUOTE <= excerpt.length; i++) {
    if (prose.includes(excerpt.slice(i, i + SHORTEST_TRACEABLE_QUOTE))) return true;
  }
  return false;
}

describe("hosting pages publish the free-tier figures our records hold (#1183)", () => {
  before(async () => {
    server = await startServer();
    const seen = new Set<string>();
    await locs("/sitemap.xml", seen);
    routes.push(...[...seen].filter((r) => !r.endsWith(".xml")));

    const prose = storedChangeProse();
    const queue = [...routes];
    const worker = async () => {
      while (queue.length) {
        const route = queue.shift()!;
        const res = await fetch(`${base}${route}`);
        if (res.status !== 200) continue;
        const html = await res.text();
        scanned++;
        for (const [surface, body] of [
          ["page", readableText(html)],
          ["metadata", metaAndStructuredData(html)],
        ] as const) {
          for (const retired of RETIRED_FIGURES) {
            const match = body.match(retired.pattern);
            if (!match) continue;
            const excerpt = excerptAround(body, match);
            if (quotesStoredChangeRecord(excerpt, prose)) continue;
            hits.push({ route, surface, excerpt: excerpt.trim(), what: retired.what });
          }
        }
      }
    };
    await Promise.all(Array.from({ length: 12 }, worker));
  });

  after(() => {
    server?.kill();
  });

  it("reads every published page rather than the pages the issue happened to name", () => {
    assert.ok(routes.length > 2000, `expected the whole sitemap, got ${routes.length} routes`);
    assert.ok(scanned > 2000, `expected to read the whole sitemap, read ${scanned}`);
  });

  it("publishes no free-tier figure the vendor has retired", () => {
    const published = hits
      .map((h) => `${h.route} (${h.surface}) states ${h.what}: ${h.excerpt}`)
      .sort();
    assert.deepStrictEqual(published, []);
  });

  it("states the current figure on every page that carried a retired one", async () => {
    const carried: Record<string, string[]> = {
      "Deno Deploy free egress of 100 GB": ["/hosting-free-tier-comparison-2026", "/serverless-free-tier-comparison-2026", "/hosting-pricing", "/vercel-alternatives"],
      "Deno Deploy free CPU allowance of 15 hours": ["/hosting-free-tier-comparison-2026", "/serverless-free-tier-comparison-2026", "/heroku-alternatives"],
      "a Koyeb free web service": ["/hosting-free-tier-comparison-2026", "/free-fastapi-stack"],
      "Supabase free egress of 2 GB": ["/database-free-tier-comparison-2026"],
      "a Fly.io free tier for new accounts": ["/hetzner-pricing-2026", "/free-django-stack", "/railway-vs-render", "/aws-app-runner-migration", "/free-tier-risk"],
      "a Sentry free session-replay allowance of 10K": ["/monitoring-comparison-2026"],
      "Sentry's free data retention as 90 days": ["/monitoring-comparison-2026"],
      "a Better Stack free log allowance of 1 GB": ["/monitoring-comparison-2026"],
      "Railway's $5 Hobby credit described as free": ["/hetzner-pricing-2026", "/hosting-pricing", "/hosting-alternatives"],
    };
    const missing: string[] = [];
    for (const [what, pages] of Object.entries(carried)) {
      const retired = RETIRED_FIGURES.find((r) => r.what === what)!;
      for (const route of pages) {
        const html = await (await fetch(`${base}${route}`)).text();
        const body = `${readableText(html)} ${metaAndStructuredData(html)}`;
        if (!retired.replacedBy.test(body)) missing.push(`${route} never states the current form of ${what}`);
      }
    }
    assert.deepStrictEqual(missing.sort(), []);
  });

  it("holds Render's bandwidth in the record its own change entry corrected", () => {
    const render = recordFor("Render", "Cloud Hosting");
    const correction = changes.find(
      (c) => c.vendor === "Render" && /Bandwidth for the Hobby tier/i.test(c.summary ?? ""),
    );
    assert.ok(correction, "no Render bandwidth change record to check the description against");
    const recorded = correction!.summary.match(/(\d[\d.]*)\s*GB included per month/i);
    assert.ok(recorded, `the Render change record no longer states an included allowance: ${correction!.summary}`);
    assert.match(
      render.description,
      new RegExp(`${recorded![1]} ?GB bandwidth/month included`),
      `the Render record publishes a bandwidth figure its own change entry replaced: ${render.description}`,
    );
  });
});

describe("the prose-record cross-check attributes a figure before comparing it (#1183 AC-7)", () => {
  const vendors = [...new Set(offers.map((o) => o.vendor).filter(Boolean))].sort((a, b) => b.length - a.length) as string[];
  const records = new Map<string, { tier: string; description: string }>();
  for (const offer of offers) {
    if (!offer.vendor || !offer.description) continue;
    const key = offer.vendor.toLowerCase();
    if (!records.has(key)) records.set(key, { tier: offer.tier ?? "", description: offer.description });
  }

  const comparisonTable = (bandwidthCell: string) => `
    <table><thead><tr><th>Feature</th><th>Vercel Hobby</th><th>Netlify Starter</th><th>Notes</th></tr></thead>
    <tbody><tr><td>Bandwidth</td><td>100 GB/mo Fast Data Transfer</td><td>${bandwidthCell}</td><td>Netlify meters bandwidth in credits</td></tr></tbody></table>`;

  it("flags the Netlify bandwidth rate this issue was filed about", () => {
    const figures = figuresInTables(comparisonTable("300 credits/mo (10 credits/GB)"), vendors);
    const found = disagreements("/vercel-vs-netlify", figures, records);
    assert.deepStrictEqual(
      found.map((f) => `${f.vendor} ${f.dimension} ${f.publishedFigure} vs ${f.recordFigure}`),
      ["Netlify bandwidth 10 credits/GB vs 20 credits/GB"],
    );
  });

  it("stops flagging it once the rate agrees with the record", () => {
    const figures = figuresInTables(comparisonTable("300 credits/mo (20 credits/GB)"), vendors);
    assert.deepStrictEqual(disagreements("/vercel-vs-netlify", figures, records), []);
  });

  it("reads a table cell from its column header, not from the vendors named in the row", () => {
    const figures = figuresInTables(comparisonTable("300 credits/mo (10 credits/GB)"), vendors);
    const netlify = figures.filter((f) => f.vendor === "Netlify").map((f) => f.quantity.text);
    assert.ok(netlify.includes("10 credits/GB"), `Netlify's own cell was not attributed to Netlify: ${JSON.stringify(netlify)}`);
    assert.ok(!netlify.includes("100 GB/mo"), "Vercel's cell was attributed to Netlify");
  });

  const notesTable = `
    <table><thead><tr><th>Provider</th><th>Bandwidth</th><th>Notes</th></tr></thead>
    <tbody><tr><td>Render</td><td>5 GB/mo</td><td>Vercel gives 100 GB on Hobby by comparison</td></tr></tbody></table>`;

  it("attributes the vendor's own column in a row-keyed table", () => {
    const figures = figuresInTables(notesTable, vendors);
    assert.ok(
      figures.some((f) => f.vendor === "Render" && f.quantity.text === "5 GB/mo"),
      `Render's own bandwidth cell was not attributed: ${JSON.stringify(figures.map((f) => f.quantity.text))}`,
    );
  });

  it("skips the Notes column, which discusses other vendors by design", () => {
    const attributed = figuresInTables(notesTable, vendors).map((f) => f.quantity.text);
    assert.ok(!attributed.includes("100 GB"), `a figure about another vendor was attributed from the Notes column: ${JSON.stringify(attributed)}`);
  });

  it("does not compare one clause of a rendered record against another clause of the same record", () => {
    const flyio = recordFor("Fly.io", "Cloud Hosting");
    const table = `
      <table><thead><tr><th>Provider</th><th>Tier</th><th>Free Tier Details</th></tr></thead>
      <tbody><tr><td>Fly.io</td><td>Legacy Free</td><td>${flyio.description}</td></tr></tbody></table>`;
    assert.deepStrictEqual(disagreements("/railway-vs-render", figuresInTables(table, vendors), records), []);
  });

  it("still flags a figure the record does not state, on a page that renders that record", () => {
    const flyio = recordFor("Fly.io", "Cloud Hosting");
    const table = `
      <table><thead><tr><th>Provider</th><th>Tier</th><th>Free Tier Details</th></tr></thead>
      <tbody><tr><td>Fly.io</td><td>Legacy Free</td><td>${flyio.description} Bandwidth is 500 GB transfer/month.</td></tr></tbody></table>`;
    const found = disagreements("/railway-vs-render", figuresInTables(table, vendors), records);
    assert.deepStrictEqual(found.map((f) => f.publishedFigure), ["500 GB"]);
  });

  it("does not let one dimension named in a sentence label the sentence's other figures", () => {
    const sentence = "Bitbucket Pipelines gives 50 build minutes/month, 5 users on the free plan.";
    const labelled = figuresInSentences(sentence, vendors)
      .filter((f) => f.dimension !== null)
      .map((f) => `${f.quantity.text} as ${f.dimension}`);
    assert.ok(!labelled.includes("5 users as build"), `a user count was labelled with the sentence's build dimension: ${JSON.stringify(labelled)}`);
  });

  it("does not read a sentence carrying a run of quantities as a claim about any one of them", () => {
    const flattened = "Firebase Database at 10 GB $25/mo (8 GB included) $1.56/mo for Firestore storage.";
    const figures = figuresInSentences(flattened, vendors);
    assert.deepStrictEqual(figures.filter((f) => f.dimension !== null), []);
  });

  it("does not compare a Pro-plan figure against a free-tier record", () => {
    const table = `
      <table><thead><tr><th>Feature</th><th>Neon</th><th>Supabase</th></tr></thead>
      <tbody><tr><td>Storage</td><td>10 GB (Launch)</td><td>8 GB database size (Pro)</td></tr></tbody></table>`;
    assert.deepStrictEqual(disagreements("/neon-vs-supabase", figuresInTables(table, vendors), records), []);
  });

  it("does not read a paid plan as the free tier just because other vendors give that name away", () => {
    const railway = recordFor("Railway", "Cloud Hosting");
    assert.match(railway.tier, /free/i, "Railway's record is no longer tiered Free, so this case has moved");
    assert.match(railway.description, /Hobby plan:/, "Railway's record no longer declares Hobby separately");
    const table = `
      <table><thead><tr><th>Feature</th><th>Railway Hobby</th><th>Render Hobby</th></tr></thead>
      <tbody><tr><td>Memory</td><td>48 GB RAM</td><td>512 MB RAM</td></tr></tbody></table>`;
    const found = disagreements("/hosting-pricing", figuresInTables(table, vendors), records);
    assert.deepStrictEqual(
      found.filter((f) => f.vendor === "Railway"),
      [],
      "Railway's paid Hobby plan was compared against its Free-tier record",
    );
  });

  it("does not compare a rate against a total in the same unit", () => {
    const table = `
      <table><thead><tr><th>Scenario</th><th>Render</th></tr></thead>
      <tbody><tr><td>Side project (1 GB/mo bandwidth)</td><td>$0</td></tr></tbody></table>`;
    assert.deepStrictEqual(disagreements("/cost-trap", figuresInTables(table, vendors), records), []);
  });

  it("treats a binary and a decimal spelling of one quantity as agreement", () => {
    const table = `
      <table><thead><tr><th>Service</th><th>Storage</th></tr></thead>
      <tbody><tr><td>Neon</td><td>512 MiB storage</td></tr></tbody></table>`;
    assert.deepStrictEqual(disagreements("/database-pricing", figuresInTables(table, vendors), records), []);
  });

  const bandwidthTable = (supabaseCell: string) => `
    <table><thead><tr><th>Feature</th><th>Supabase</th><th>Neon</th></tr></thead>
    <tbody><tr><td>Bandwidth</td><td>${supabaseCell}</td><td>Not metered</td></tr></tbody></table>`;

  it("extracts a figure from the cell these bandwidth assertions rest on", () => {
    const figures = figuresInTables(bandwidthTable("40 GB total egress"), vendors);
    assert.deepStrictEqual(
      figures.filter((f) => f.vendor === "Supabase").map((f) => `${f.dimension} ${f.quantity.text}`),
      ["bandwidth 40 GB"],
    );
  });

  it("reads a total that sums the record's own parts as agreement", () => {
    const figures = figuresInTables(bandwidthTable("10 GB total (5 GB cached + 5 GB uncached)"), vendors);
    assert.deepStrictEqual(disagreements("/supabase-vs-firebase", figures, records), []);
  });

  it("still flags a total the record's parts do not add up to", () => {
    const figures = figuresInTables(bandwidthTable("40 GB total egress"), vendors);
    const found = disagreements("/supabase-vs-firebase", figures, records);
    assert.deepStrictEqual(found.map((f) => `${f.vendor} ${f.publishedFigure}`), ["Supabase 40 GB"]);
  });

  it("only adds the record's parts up for a figure that says it is a total", () => {
    const figures = figuresInTables(bandwidthTable("10 GB egress"), vendors);
    const found = disagreements("/supabase-vs-firebase", figures, records);
    assert.deepStrictEqual(
      found.map((f) => `${f.vendor} ${f.publishedFigure} vs ${f.recordFigure}`),
      ["Supabase 10 GB vs 5 GB"],
    );
  });


  it("does not read a historical figure as a current claim", () => {
    const sentence = "Netlify previously metered bandwidth at 10 credits/GB before the September change.";
    assert.deepStrictEqual(disagreements("/changes", figuresInSentences(sentence, vendors), records), []);
  });

  it("does not compare a record against the page that renders that record", () => {
    const netlify = recordFor("Netlify", "Cloud Hosting");
    const rendered = `Netlify verified data: ${netlify.description}`;
    assert.deepStrictEqual(disagreements("/vercel-vs-netlify", figuresInSentences(rendered, vendors), records), []);
  });
});
