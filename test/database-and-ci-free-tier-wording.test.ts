import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const { FIGURE_SOURCE_CLASS } = await import("../dist/source-citation.js");
const { SOURCE_MARKER_IN_A_CELL } = await import("../dist/page-reviews.js");

const PLANETSCALE_ESTIMATE = `"slug":"planetscale","name":"PlanetScale","free":"No free tier","starter":5,"growth":30,"scale":83,"notes":"No free plan. Pricing by cluster size. Storage included only on Metal. Backup and egress billed separately."`;
const PLANETSCALE_ESTIMATE_AT_39 = /"slug":"planetscale"[^}]*"starter":39|Free Hobby plan removed April 2024; every plan is paid/;

const WITHDRAWN: Record<string, Record<string, RegExp>> = {
  "/database-pricing": {
    "Weaviate's free cluster as a trial sandbox": /only has a trial sandbox|Sandbox \(limited\)|Free sandbox cluster|Sandbox is trial-only/,
    "Weaviate's paid plans from $25": /\$25\/mo \(Serverless\)/,
    "PlanetScale's cheapest plan as Scaler at $39": /minimum plan is now Scaler|\$39\/mo \(Scaler\)|The \$39\/mo Scaler plan/,
    "free PlanetScale databases deleted after a grace period": /All free databases were deleted/,
  },
  "/vector-database-pricing": {
    "Weaviate Cloud as a 14-day sandbox": /Sandbox only|Sandbox \(14-day\)|14-day free sandbox with full features/,
    "Weaviate Cloud's paid plans from $25": /\$25\/mo \(Shared\)|Shared cloud from \$25/,
  },
  "/ci-cd-pricing": {
    "Semaphore Cloud with no free tier": /No free cloud-hosted tier|Community plan is self-hosted only/,
    "Semaphore priced per user": /\$25\/user/,
  },
  "/database-free-tier-comparison-2026": {
    "free PlanetScale databases shut down or deleted after a grace period": /shut down all free Hobby plan databases|databases were deleted|30-day grace period/,
  },
  "/cicd-free-tier-comparison-2026": {
    "Semaphore CI's free tier as the self-hosted Community plan alone": /Community plan \(self-hosted, unlimited\)/,
  },
  "/estimate": { "PlanetScale estimated at $39 a month": PLANETSCALE_ESTIMATE_AT_39 },
  "/budget-builder": { "PlanetScale estimated at $39 a month": PLANETSCALE_ESTIMATE_AT_39 },
};

const STATED: Record<string, string[]> = {
  "/database-pricing": [
    "PlanetScale retired its free Hobby plan on 2024-04-08. Hobby databases that were not upgraded were put to sleep with their data kept. The cheapest plan is now $5 a month.",
    'Weaviate Cloud offers a "Free Forever" cluster with 100,000 objects, 1 GB memory, and 10 GB disk.',
    "Free Forever cluster with 100,000 objects, 1 GB memory, and 10 GB disk. No credit card required.",
  ],
  "/vector-database-pricing": [
    'Weaviate Cloud offers a "Free Forever" cluster with 100,000 objects, 1 GB memory, and 10 GB disk. Weaviate is also open source and free to self-host.',
  ],
  "/ci-cd-pricing": [
    "Semaphore Cloud gives every account a $15 credit each month, about 2,000 Ubuntu x64 2-vCPU minutes, and 20 concurrent jobs by default. Self-hosted Community Edition is free.",
  ],
  "/database-free-tier-comparison-2026": [
    'PlanetScale retired its Hobby plan on April 8, 2024. Its FAQ: "Databases which are not upgraded by April 8th will be put into sleep mode. If you need to retrieve your data after April 8th, you will be able to temporarily wake your database for 24 hours."',
  ],
};

const ROWS: Record<string, string[][]> = {
  "/database-pricing": [
    ["Weaviate", "Vector", "10 GB disk, 1 GB memory", "Unlimited", "$45/mo (Flex)"],
    ["Weaviate", "Always free (Free Forever)", "10 GB disk", "At 100,000 objects or 1 collection"],
    ["Weaviate", "$0 (Free Forever)", "$45+ (Flex)", 'Weaviate Cloud has a "Free Forever" plan. Flex plans start at $45 a month, pay as you go.'],
    ["PlanetScale", "Postgres and MySQL (Vitess)", "REMOVED", "N/A", "$5/mo (Postgres single node)"],
    ["PlanetScale", "$5", "$30+", "PlanetScale has no free plan. The cheapest plan is PlanetScale Postgres, single node, from $5 a month."],
  ],
  "/vector-database-pricing": [
    ["Weaviate Cloud", "Managed (Multi-model)", "100,000 objects", "10 GB disk, 1 GB memory", "Unlimited", "$45/mo (Flex)"],
    ["Weaviate Cloud", "$0 (Free Forever)", "$45+ (Flex)"],
  ],
  "/ci-cd-pricing": [
    ["Semaphore CI", "$15 credit (≈2,000 Ubuntu x64 2-vCPU min)", "20 jobs", "Community Edition free; agents $0.0025/min", "$0.003/min (Ubuntu ARM, 2 vCPU)", "Per-minute usage"],
    ["Semaphore CI", "Monthly credit", "≈2,000 (Ubuntu x64, 2 vCPU)", "When the $15 monthly credit is used"],
    ["Semaphore CI", "$0 within the $15 credit", "Usage-based", "Semaphore Cloud provides a $15 monthly credit. Compute is billed per minute after the credit is used."],
  ],
  "/cicd-free-tier-comparison-2026": [
    ["Semaphore CI", "Cloud: $15 monthly credit. Self-hosted Community Edition: free", "Unlimited (Community Edition); $0.0025/min on Cloud"],
  ],
};

const CARD_LABELS: Record<string, [string, string][]> = {
  "/database-pricing": [["weaviate", "Vector · Always free"]],
  "/ci-cd-pricing": [["semaphore-ci", "Monthly credit"]],
};

const COST_TABLES_WITH_STATED_KEY_COST_FACTORS: Record<string, string[]> = {
  "/database-pricing": ["Weaviate", "PlanetScale"],
  "/ci-cd-pricing": ["Semaphore CI"],
};

const PAGES = [...new Set([...Object.keys(WITHDRAWN), ...Object.keys(STATED), ...Object.keys(ROWS)])].sort();

let server: ChildProcess;
const html = new Map<string, string>();

function decode(text: string): string {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&#39;|&#x27;|&rsquo;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&mdash;/g, "—")
    .replace(/&times;/g, "×")
    .replace(/&nearr;/g, "")
    .replace(/&nbsp;/g, " ");
}

function textOf(markup: string): string {
  return decode(
    markup
      .replace(/<script[\s\S]*?<\/script>/g, " ")
      .replace(/<style[\s\S]*?<\/style>/g, " ")
      .replace(/<[^>]+>/g, " "),
  ).replace(/\s+/g, " ").replace(/ ([,.:;])/g, "$1").trim();
}

const CITATION_ANCHOR = new RegExp(`<a [^>]*class="${FIGURE_SOURCE_CLASS}"[^>]*>[\\s\\S]*?<\\/a>`, "g");

function namedFor(firstCell: string, name: string): boolean {
  return firstCell === name || firstCell.startsWith(`${name} `);
}

function rowsOf(markup: string): string[][] {
  return [...markup.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)]
    .map(([, row]) => [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map(([, cell]) =>
      textOf(cell.replace(CITATION_ANCHOR, "").replace(new RegExp(SOURCE_MARKER_IN_A_CELL.source, "g"), ""))))
    .filter((cells) => cells.length >= 2);
}

function costTableRows(page: string): string[][] {
  const markup = html.get(page)!;
  const section = markup.slice(markup.indexOf('id="cost-analysis"'));
  return rowsOf(section.slice(0, section.indexOf("</table>")));
}

describe("database, vector and CI/CD pricing pages state Weaviate's, PlanetScale's and Semaphore's plans as each vendor's page does", () => {
  before(async () => {
    server = spawn("node", [path.join(REPO, "dist", "serve.js")], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, PORT: "0", BASE_URL: "http://localhost", TZ: "UTC" },
    });
    const base = await new Promise<string>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Server startup timeout")), 30000);
      server.stderr!.on("data", (data: Buffer) => {
        const match = data.toString().match(/running on http:\/\/localhost:(\d+)/);
        if (match) {
          clearTimeout(timeout);
          resolve(`http://localhost:${match[1]}`);
        }
      });
      server.on("error", (err) => {
        clearTimeout(timeout);
        reject(err);
      });
    });
    for (const page of PAGES) {
      const response = await fetch(`${base}${page}`);
      assert.strictEqual(response.status, 200, page);
      html.set(page, await response.text());
    }
  });
  after(() => {
    server?.kill();
  });

  it("serves none of the withdrawn plans on the pages that carried them", () => {
    const found = Object.entries(WITHDRAWN).flatMap(([page, claims]) =>
      Object.entries(claims)
        .filter(([, pattern]) => pattern.test(html.get(page)!))
        .map(([claim, pattern]) => `${page}: ${claim} ("${html.get(page)!.match(pattern)![0].slice(0, 80)}")`));
    assert.deepStrictEqual(found, []);
  });

  it("states each vendor's plan in the sentences and labels given for it", () => {
    const missing = Object.entries(STATED).flatMap(([page, lines]) => {
      const text = textOf(html.get(page)!);
      return lines.filter((line) => !text.includes(line)).map((line) => `${page}: ${line}`);
    });
    assert.deepStrictEqual(missing, []);
  });

  it("puts each vendor's figures in its table rows", () => {
    const missing = Object.entries(ROWS).flatMap(([page, expected]) => {
      const rows = rowsOf(html.get(page)!);
      return expected
        .filter(([name, ...cells]) => !rows.some((row) => namedFor(row[0], name) && cells.every((cell) => row.includes(cell))))
        .map((cells) => `${page}: ${cells.join(" | ")}`);
    });
    assert.deepStrictEqual(missing, []);
  });

  it("labels each vendor's card with its kind of free tier", () => {
    const wrong = Object.entries(CARD_LABELS).flatMap(([page, cards]) => cards.flatMap(([slug, label]) => {
      const found = html.get(page)!.match(new RegExp(`<div class="diff-card"[^>]*><h3><a href="/vendor/${slug}"[^>]*>[^<]*</a> <span[^>]*>([^<]*)</span>`))?.[1];
      return found === label ? [] : [`${page} ${slug}: ${found}`];
    }));
    assert.deepStrictEqual(wrong, []);
  });

  it("gives the estimators PlanetScale's cheapest plans and the note on what they price", () => {
    assert.deepStrictEqual(["/estimate", "/budget-builder"].filter((page) => !html.get(page)!.includes(PLANETSCALE_ESTIMATE)), []);
  });

  it("still cuts every other row's key cost factor at 80 characters", () => {
    const uncut = Object.entries(COST_TABLES_WITH_STATED_KEY_COST_FACTORS).flatMap(([page, stated]) => {
      const others = costTableRows(page).filter(([name]) => !stated.some((vendor) => namedFor(name, vendor)));
      assert.ok(others.length > 10, `${page}: only ${others.length} other cost rows`);
      return others.filter((row) => row[3].length > 83).map((row) => `${page}: ${row[0]}`);
    });
    assert.deepStrictEqual(uncut, []);
  });
});
