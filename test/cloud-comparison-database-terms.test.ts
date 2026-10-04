import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const { FIGURE_SOURCE_CLASS } = await import("../dist/source-citation.js");
const { SOURCE_MARKER_IN_A_CELL } = await import("../dist/page-reviews.js");

const PAGE = "/cloud-free-tier-comparison-2026";

const AZURE_FLEXIBLE_SERVER = "750 hrs/mo Flexible Server B1MS, 32 GB storage, 32 GB backup";

const DATABASE_ROWS: string[][] = [
  ["AWS", "RDS (MySQL/PostgreSQL)", "Relational", "No allowance of its own: paid from the Free plan's credits (up to $200)", "Free plan, up to 6 months"],
  ["AWS", "Aurora PostgreSQL Serverless", "Relational (serverless)", "Up to 4 ACUs and 1 GiB per cluster, paid from the Free plan's credits", "Free plan, up to 6 months"],
  ["Azure", "SQL Database", "Relational", "Up to 10 serverless databases, each 100K vCore seconds/mo and 32 GB", "Always free"],
  ["Azure", "Database for PostgreSQL", "Relational", AZURE_FLEXIBLE_SERVER, "12 months"],
  ["Azure", "Database for MySQL", "Relational", AZURE_FLEXIBLE_SERVER, "12 months"],
];

const ON_A_TWELVE_MONTH_TERM = /\b12[- ]?mo(?:nths?)?\b/i;
const NAMES_RDS_OR_AURORA = /\bRDS\b|\bAurora\b/;

let server: ChildProcess;
let html = "";

function decode(text: string): string {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&#39;|&#x27;|&rsquo;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&mdash;/g, "—")
    .replace(/&nearr;/g, "")
    .replace(/&nbsp;/g, " ");
}

function textOf(markup: string): string {
  return decode(markup.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").replace(/ ([,.:;])/g, "$1").trim();
}

const CITATION_ANCHOR = new RegExp(`<a [^>]*class="${FIGURE_SOURCE_CLASS}"[^>]*>[\\s\\S]*?<\\/a>`, "g");

function rowsOf(markup: string): string[][] {
  return [...markup.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)]
    .map(([, row]) => [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map(([, cell]) =>
      textOf(cell.replace(CITATION_ANCHOR, "").replace(new RegExp(SOURCE_MARKER_IN_A_CELL.source, "g"), ""))))
    .filter((cells) => cells.length >= 2);
}

function namedFor(firstCell: string, name: string): boolean {
  return firstCell === name || firstCell.startsWith(`${name} `);
}

function databaseTable(): string[][] {
  const section = html.slice(html.indexOf('<h2 id="databases"'));
  return rowsOf(section.slice(0, section.indexOf("</table>")));
}

describe("the cloud comparison's database table gives each managed relational database the provider's current terms", () => {
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
    const response = await fetch(`${base}${PAGE}`);
    assert.strictEqual(response.status, 200);
    html = await response.text();
  });
  after(() => {
    server?.kill();
  });

  it("reads the database table", () => {
    assert.ok(databaseTable().length >= DATABASE_ROWS.length, `${databaseTable().length} rows`);
  });

  it("states RDS and Aurora on the Free plan's credits, SQL Database as always free, and Azure's PostgreSQL and MySQL for 12 months", () => {
    const rows = databaseTable();
    const missing = DATABASE_ROWS
      .filter(([provider, ...cells]) => !rows.some((row) => namedFor(row[0], provider) && row.slice(1).join(" | ") === cells.join(" | ")))
      .map((cells) => cells.join(" | "));
    assert.deepStrictEqual(missing, []);
  });

  it("gives no RDS or Aurora row in any of the page's tables a 12-month term", () => {
    const twelveMonth = rowsOf(html)
      .filter((cells) => cells.some((cell) => NAMES_RDS_OR_AURORA.test(cell)) && cells.some((cell) => ON_A_TWELVE_MONTH_TERM.test(cell)))
      .map((cells) => cells.join(" | "));
    assert.deepStrictEqual(twelveMonth, []);
  });
});
