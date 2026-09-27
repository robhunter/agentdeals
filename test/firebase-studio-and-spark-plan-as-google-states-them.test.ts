import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
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
    "New workspaces disabled since June 22, 2026.",
    "Existing workspaces keep working and can be migrated.",
    "New ones cannot be created.",
    "Generally available, with a $0 plan for individuals.",
    "Google Antigravity or AI Studio for Gemini prototyping.",
    "Verify everything works before March 22, 2027.",
    "June 22, 2026 (new workspaces and sign-ups disabled) and March 22, 2027 (data deletion)",
  ],
  "/q1-2026-developer-pricing-report": [
    "Google hit Firebase with a double blow: removing Cloud Storage from the free Spark plan (February 3) and announcing on March 19 that Firebase Studio will shut down (no new workspaces from June 22, 2026; shutdown March 22, 2027). Cloud Storage now requires the Blaze (pay-as-you-go) plan.",
    "Firebase Studio shutdown (no new workspaces from June 22, 2026; closes March 22, 2027) — cloud IDE going offline.",
  ],
  "/database-free-tier-comparison-2026": [
    "and Google announced in March that Firebase Studio (formerly Project IDX) will shut down on March 22, 2027.",
  ],
  "/supabase-vs-firebase": [
    "Firebase removed Cloud Storage from the Spark plan on February 3, 2026. Blaze includes 5 GB at no cost in us-central1, us-east1 and us-west1.",
    "Cloud Functions need the Blaze plan, which includes 2M invocations a month at no cost.",
    "360 MB/day Hosting, 10 GiB/mo Firestore egress",
    "$0 on Blaze (2M a month at no cost)",
    "Firebase needs Blaze for any function.",
  ],
  "/storage-comparison-2026": [
    "No free plan since February 3, 2026: Cloud Storage for Firebase needs the Blaze plan. On Blaze, buckets in us-central1, us-east1 and us-west1 include 5 GB stored, 100 GB downloaded, 5,000 uploads and 50,000 downloads a month at no cost.",
  ],
  "/vendor/firebase": [
    "At 1 GiB of Firestore data or 50K reads a day, you'll need Blaze.",
  ],
};

const WITHDRAWN: Record<string, string[]> = {
  "/firebase-studio-shutdown": [
    "until new workspace creation disabled",
    "Days to Workspace Freeze",
    "Read-only access to existing workspaces",
    "Can export but not create",
    "Still in early access",
    "(when available)",
    "before the June 22 freeze",
    "(workspace freeze)",
    "June 22, 2026 · Firebase stability",
  ],
  "/supabase-vs-firebase": [
    "Blaze includes 5 GB at no cost.",
    "1 GB/day Firestore download",
    "beyond 2M free",
    "both cover 1M in free/base tier",
  ],
  "/storage-comparison-2026": [
    "5 GB storage, 1 GB/day download bandwidth",
    "The 1 GB/day egress limit",
  ],
  "/vendor/firebase": ["At 10 GB storage"],
};

type ChangeRecord = {
  vendor: string;
  change_type: string;
  summary: string;
  current_state?: string;
  resolution?: { state?: string } | null;
};

const CHANGE_LOG: ChangeRecord[] = JSON.parse(readFileSync(path.join(REPO, "data", "deal_changes.json"), "utf8")).changes;

function isOurOwnRecord(change: ChangeRecord): boolean {
  return change.change_type === "record_corrected" || change.resolution?.state === "retracted";
}

const FIREBASE_TIMELINE_VENDORS = (change: ChangeRecord) => change.vendor === "Firebase" || change.vendor === "Google";

const GCP_TIMELINE_VENDORS = (change: ChangeRecord) =>
  change.current_state !== "Removed from index" &&
  (change.vendor === "Google Cloud" || change.vendor.startsWith("Google") || change.vendor === "Firebase" || change.vendor.includes("Gemini"));

const PAGES = [...new Set([...PAGES_DATING_THE_STUDIO_SHUTDOWN, ...Object.keys(STATED), "/gcp-free-tier-2026"])];

const SPARK_CELLS_THAT_NEED_BLAZE: Record<string, { row: string; columns: number[] }[]> = {
  "/supabase-vs-firebase": [
    { row: "Storage", columns: [2] },
    { row: "Functions", columns: [2] },
  ],
  "/firebase-alternatives": [{ row: "Firebase (Spark)", columns: [2, 4] }],
  "/database-free-tier-comparison-2026": [{ row: "Firebase ECOSYSTEM LOCK-IN", columns: [4] }],
  "/storage-comparison-2026": [{ row: "Firebase Storage", columns: [2, 3] }],
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
    .replace(/&middot;/g, "·")
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

function sectionText(html: string, id: string): string {
  const start = html.indexOf(`id="${id}"`);
  assert.ok(start >= 0, `the page has a #${id} section`);
  const end = html.indexOf("<h2", start + 1);
  return textOf(html.slice(start, end < 0 ? undefined : end));
}

function summaryProbe(change: ChangeRecord): string {
  return textOf(change.summary).slice(0, 50).trim();
}

const TIMELINES = [
  {
    page: "/firebase-studio-shutdown",
    section: "firebase-timeline",
    covers: FIREBASE_TIMELINE_VENDORS,
    countLine: (n: number) => `${n} Firebase/Google pricing changes tracked`,
  },
  {
    page: "/gcp-free-tier-2026",
    section: "changes",
    covers: GCP_TIMELINE_VENDORS,
    countLine: (n: number) => `and ${n} GCP/Google pricing changes`,
  },
];

describe("Firebase Studio's shutdown and the Spark plan, as Google states them", () => {
  it("prints none of the lines the corrections replace", () => {
    const left = Object.entries(WITHDRAWN).flatMap(([page, lines]) =>
      lines.filter((line) => textOf(served.get(page)!).includes(line)).map((line) => `${page}: ${line}`),
    );
    assert.deepStrictEqual(left, []);
  });

  it("lists and counts only changes the vendor made in the Firebase and GCP change timelines", () => {
    for (const { page, section, covers, countLine } of TIMELINES) {
      const subject = CHANGE_LOG.filter(covers);
      const ours = subject.filter(isOurOwnRecord);
      const theirs = subject.filter((change) => !isOurOwnRecord(change));
      assert.ok(ours.length > 0, `${page}: the change log holds a record of our own for these vendors, so there is something to leave out`);
      const timeline = sectionText(served.get(page)!, section);
      assert.ok(theirs.some((change) => timeline.includes(summaryProbe(change))), `${page}: the timeline lists a change the vendor made`);
      assert.deepStrictEqual(ours.map(summaryProbe).filter((probe) => timeline.includes(probe)), [], page);
      assert.ok(textOf(served.get(page)!).includes(countLine(theirs.length)), `${page} states "${countLine(theirs.length)}"`);
    }
  });

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

  it("does not mark Firebase Storage's allowance permanently free on the storage comparison, since Spark has none", () => {
    const table = rowsOf(served.get("/storage-comparison-2026")!);
    const header = table.find((cells) => cells.includes("Permanent Free"));
    assert.ok(header, "the storage comparison has a Permanent Free column");
    const column = header!.indexOf("Permanent Free");
    const firebase = table.find((cells) => cells[0]?.startsWith("Firebase Storage") && cells.length > column);
    assert.ok(firebase, "the storage comparison has a Firebase Storage row");
    assert.strictEqual(firebase![column], "Blaze only");
  });
});
