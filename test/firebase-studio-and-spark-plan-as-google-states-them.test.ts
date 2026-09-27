import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getGuideBySlug } from "../dist/guides.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(__dirname, "..");

const PAGES_DATING_THE_STUDIO_SHUTDOWN = [
  "/firebase-alternatives",
  "/firebase-studio-shutdown",
  "/q1-2026-developer-pricing-report",
  "/database-free-tier-comparison-2026",
];

const STUDIO_DATED_AS_IT_WAS_NOT = [
  /Firebase Studio (?:was )?shut down (?:on )?March/,
  /shuts down June/,
  /effective June 2026/,
  /will be disabled on June 22/,
  /discontinued in March/,
  /lasted less than a year/,
];

const STATED: Record<string, string[]> = {
  "/firebase-alternatives": [
    "Firebase's free Spark plan lost Cloud Storage in February 2026, and Firebase Studio shuts down on March 22, 2027.",
    "Google announced on March 19, 2026 that Firebase Studio will shut down: it has taken no new workspaces since June 22, 2026, and it closes, deleting all remaining data, on March 22, 2027.",
    "Since February 3, 2026, Cloud Storage for Firebase requires the pay-as-you-go Blaze plan, and a Spark project has no access to any bucket, including its default one.",
  ],
  "/firebase-studio-shutdown": [
    "Firebase Studio has taken no new workspaces since June 22, 2026 and shuts down on March 22, 2027.",
    "New workspace creation has been disabled since June 22, 2026.",
  ],
  "/q1-2026-developer-pricing-report": [
    "Google hit Firebase with a double blow: removing Cloud Storage from the free Spark plan (February 3) and announcing on March 19 that Firebase Studio will shut down (no new workspaces from June 22, 2026; shutdown March 22, 2027). Cloud Storage now requires the Blaze (pay-as-you-go) plan.",
    "Firebase Studio shutdown (no new workspaces from June 22, 2026; closes March 22, 2027) — cloud IDE going offline.",
  ],
  "/database-free-tier-comparison-2026": [
    "and Google announced in March that Firebase Studio (formerly Project IDX) will shut down on March 22, 2027.",
  ],
  "/supabase-vs-firebase": [
    "Firebase removed Cloud Storage from the Spark plan on February 3, 2026. Blaze includes 5 GB at no cost.",
    "Cloud Functions need the Blaze plan, which includes 2M invocations a month at no cost.",
  ],
};

const PAGES = [...new Set([...PAGES_DATING_THE_STUDIO_SHUTDOWN, ...Object.keys(STATED)])];

const SPARK_CELLS_THAT_NEED_BLAZE: Record<string, { row: string; columns: number[] }[]> = {
  "/supabase-vs-firebase": [
    { row: "Storage", columns: [2] },
    { row: "Functions", columns: [2] },
  ],
  "/firebase-alternatives": [{ row: "Firebase (Spark)", columns: [2, 4] }],
  "/database-free-tier-comparison-2026": [{ row: "Firebase ECOSYSTEM LOCK-IN", columns: [4] }],
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

function decode(text: string): string {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&#39;|&#x27;|&rsquo;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&mdash;/g, "—")
    .replace(/&nbsp;/g, " ");
}

function textOf(html: string): string {
  return decode(
    html
      .replace(/<script(?![^>]*ld\+json)[\s\S]*?<\/script>/g, " ")
      .replace(/<style[\s\S]*?<\/style>/g, " ")
      .replace(/<[^>]+>/g, " "),
  ).replace(/\s+/g, " ").replace(/ ([,.:;])/g, "$1");
}

function rowsOf(html: string): string[][] {
  return [...html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)].map((row) =>
    [...row[1].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/g)].map((cell) => decode(cell[1].replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim()),
  );
}

describe("Firebase Studio's shutdown and the Spark plan, as Google states them", () => {
  it("dates Firebase Studio's shutdown March 22, 2027 and never says it shut down in March 2026 or shuts down in June", () => {
    for (const page of PAGES_DATING_THE_STUDIO_SHUTDOWN) {
      const text = textOf(served.get(page)!);
      assert.ok(text.includes("March 22, 2027"), page);
      assert.deepStrictEqual(STUDIO_DATED_AS_IT_WAS_NOT.filter((wrong) => wrong.test(text)).map(String), [], page);
    }
  });

  it("describes the Firebase Studio shutdown guide with the date it closes", () => {
    const guide = getGuideBySlug("firebase-studio-shutdown");
    assert.ok(guide, "the guide list carries the Firebase Studio shutdown guide");
    assert.strictEqual(
      guide!.description,
      "Firebase Studio shuts down March 22, 2027 — free cloud IDE alternatives with compute, storage, and collaboration limits compared",
    );
  });

  it("renders every replacement where it belongs", () => {
    const missing = Object.entries(STATED).flatMap(([page, lines]) =>
      lines.filter((line) => !textOf(served.get(page)!).includes(line)).map((line) => `${page}: ${line}`),
    );
    assert.deepStrictEqual(missing, []);
  });

  it("gives Firebase's free plan no Cloud Storage and no Cloud Functions in any comparison table", () => {
    for (const [page, rows] of Object.entries(SPARK_CELLS_THAT_NEED_BLAZE)) {
      const table = rowsOf(served.get(page)!);
      for (const { row, columns } of rows) {
        const cells = table.find((cells) => cells[0]?.startsWith(row) && cells.length > Math.max(...columns));
        assert.ok(cells, `${page} has a "${row}" row`);
        for (const column of columns) {
          assert.strictEqual(cells![column], "None on Spark (Blaze only)", `${page} "${row}" column ${column}`);
        }
      }
    }
    const database = rowsOf(served.get("/database-free-tier-comparison-2026")!).filter((cells) => cells[0]?.startsWith("Firebase"));
    assert.ok(database.length > 0, "the database comparison has a Firebase row");
    for (const cells of database) {
      assert.deepStrictEqual(cells.filter((cell) => /\binvocations\b|Cloud Functions/.test(cell)), [], cells.join(" | "));
    }
  });
});
