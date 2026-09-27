import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(__dirname, "..");

const NO_RATING = "—";

let proc: ChildProcess | null = null;
let port = 0;

const get = async (p: string) => (await fetch(`http://localhost:${port}${p}`)).text();

before(async () => {
  const child = spawn("node", [path.join(REPO, "dist", "serve.js")], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, PORT: "0", BASE_URL: "http://localhost", TZ: "UTC" },
  });
  proc = child;
  port = await new Promise<number>((resolve, reject) => {
    const timeout = setTimeout(() => { child.kill(); reject(new Error("Server startup timeout")); }, 30000);
    child.stderr!.on("data", (data: Buffer) => {
      const m = data.toString().match(/running on http:\/\/localhost:(\d+)/);
      if (m) { clearTimeout(timeout); resolve(parseInt(m[1], 10)); }
    });
  });
});

after(() => { proc?.kill(); });

function textOf(html: string): string {
  return html.replace(/<[^>]+>/g, " ").replace(/&mdash;/g, "—").replace(/\s+/g, " ").trim();
}

async function riskRows(): Promise<Array<{ slug: string; rating: string }>> {
  const page = await get("/gemini-api-pricing-2026");
  const header = page.indexOf("<th>Risk</th>");
  assert.ok(header > 0, "/gemini-api-pricing-2026 has no Risk column");
  const table = page.slice(header, page.indexOf("</table>", header));
  return [...table.matchAll(/<tr>([\s\S]*?)<\/tr>/g)].map(([, row]) => {
    const cells = [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((cell) => cell[1]);
    const slug = cells[0].match(/href="\/vendor\/([^"]+)"/)?.[1];
    assert.ok(slug, `a row links to no vendor page: ${textOf(cells[0])}`);
    return { slug, rating: textOf(cells[cells.length - 1]) };
  });
}

async function headingRating(slug: string): Promise<string> {
  const h1 = (await get(`/vendor/${slug}`)).match(/<h1>[\s\S]*?<\/h1>/)?.[0] ?? "";
  return h1.match(/<span class="risk-badge"[^>]*>([^<]*)<\/span>/)?.[1] ?? NO_RATING;
}

describe("/gemini-api-pricing-2026 rates each alternative the way its vendor page does", () => {
  it("states the vendor page's heading rating in every Risk cell, and no rating where the page states none", async () => {
    const rows = await riskRows();
    assert.ok(rows.length >= 5, `the Risk column has ${rows.length} rows`);
    const disagreeing: string[] = [];
    for (const { slug, rating } of rows) {
      const heading = await headingRating(slug);
      if (rating !== heading) disagreeing.push(`${slug}: table "${rating}", vendor page "${heading}"`);
    }
    assert.deepStrictEqual(disagreeing, []);
    assert.ok(rows.some((row) => row.rating !== NO_RATING), "no row states a rating, so the comparison proves nothing");
  });
});
