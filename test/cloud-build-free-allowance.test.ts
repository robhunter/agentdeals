import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(__dirname, "..");

const PAGES = ["/ci-cd-pricing", "/hosting-pricing", "/cicd-free-tier-comparison-2026"];

const WITHDRAWN = [
  "120 min/day",
  "120 build minutes/day",
  "120 build-min/day",
  "120/day (Cloud Build)",
  "120 free/day",
  "~3,600",
];

const STATED: Record<string, string[]> = {
  "/ci-cd-pricing": [
    "2,500 min/mo",
    "2,500 build-minutes a month per billing account, on e2-standard-2 machines in the default pool. Google calls this free tier promotional and subject to change.",
    "The free minutes cover e2-standard-2 only. Also:",
    "Google Cloud Build offers 2,500 build-minutes a month on e2-standard-2 machines for free.",
    "Google Cloud Build's 2,500 min/month",
    "(2,500 min/month free)",
  ],
  "/hosting-pricing": ["2,500/mo (Cloud Build)"],
  "/cicd-free-tier-comparison-2026": [
    "2,500 min/mo (e2-standard-2)",
    "2,500 build-min/mo (e2-standard-2)",
    "Google Cloud Build gives 2,500 build-minutes a month per billing account.",
  ],
};

let proc: ChildProcess | null = null;
const served = new Map<string, string>();

before(async () => {
  const child = spawn("node", [path.join(REPO, "dist", "serve.js")], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, PORT: "0", BASE_URL: "http://localhost", TZ: "UTC" },
  });
  proc = child;
  const port = await new Promise<number>((resolve, reject) => {
    const timeout = setTimeout(() => { child.kill(); reject(new Error("Server startup timeout")); }, 30000);
    child.stderr!.on("data", (data: Buffer) => {
      const m = data.toString().match(/running on http:\/\/localhost:(\d+)/);
      if (m) { clearTimeout(timeout); resolve(parseInt(m[1], 10)); }
    });
  });
  for (const page of PAGES) {
    served.set(page, await (await fetch(`http://localhost:${port}${page}`)).text());
  }
});

after(() => { proc?.kill(); });

function textOf(html: string): string {
  return html
    .replace(/<script(?![^>]*ld\+json)[\s\S]*?<\/script>/g, " ")
    .replace(/<style[\s\S]*?<\/style>/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#39;|&#x27;|&rsquo;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&mdash;/g, "—")
    .replace(/\s+/g, " ");
}

function alwaysFreeColumn(html: string): { vendorPage: string; cell: string }[] {
  const table = html.split("<th>Always Free?</th>")[1]?.split("</table>")[0] ?? "";
  return [...table.matchAll(/<tr>([\s\S]*?)<\/tr>/g)].map((row) => {
    const cells = [...row[1].matchAll(/<td[^>]*>[\s\S]*?<\/td>/g)].map((m) => m[0]);
    const vendorPage = (cells[0] ?? "").match(/href="(\/vendor\/[^"]+)"/)?.[1] ?? "";
    return { vendorPage, cell: cells[cells.length - 1] ?? "" };
  });
}

function openingTag(cell: string): string {
  return cell.match(/^<td[^>]*>/)?.[0] ?? "";
}

describe("the CI/CD and hosting pages state Cloud Build's free allowance as Google does", () => {
  it("answers Always Free? for Cloud Build as a promotional yes, styled like the table's other yes rows", () => {
    const rows = alwaysFreeColumn(served.get("/cicd-free-tier-comparison-2026")!);
    const cloudBuild = rows.filter((row) => row.vendorPage === "/vendor/google-cloud-build");
    assert.strictEqual(cloudBuild.length, 1, "one Cloud Build row under the Always Free? column");
    assert.strictEqual(textOf(cloudBuild[0].cell).trim(), "Yes (promotional)");
    const otherYesTags = new Set(
      rows
        .filter((row) => row.vendorPage !== "/vendor/google-cloud-build" && /^Yes\b/.test(textOf(row.cell).trim()))
        .map((row) => openingTag(row.cell)),
    );
    assert.ok(otherYesTags.size > 0, "the table answers yes for at least one other provider");
    assert.deepStrictEqual([...otherYesTags], [openingTag(cloudBuild[0].cell)]);
  });

  it("prints none of the daily allowance, in the body or the structured data", () => {
    const left = PAGES.flatMap((page) =>
      WITHDRAWN.filter((phrase) => textOf(served.get(page)!).includes(phrase)).map((phrase) => `${page}: ${phrase}`),
    );
    assert.deepStrictEqual(left, []);
  });

  it("does not call Cloud Build's allowance stable", () => {
    for (const page of PAGES) {
      const sentences = textOf(served.get(page)!).split(/(?<=[.!?])\s+/);
      assert.deepStrictEqual(sentences.filter((s) => /Cloud Build/.test(s) && /remained stable/.test(s)), [], page);
    }
  });

  it("renders every replacement where it belongs", () => {
    const missing = Object.entries(STATED).flatMap(([page, lines]) =>
      lines.filter((line) => !textOf(served.get(page)!).includes(line)).map((line) => `${page}: ${line}`),
    );
    assert.deepStrictEqual(missing, []);
  });
});
