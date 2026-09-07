import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");

const offers = JSON.parse(readFileSync(path.join(root, "data", "index.json"), "utf-8")).offers as Array<Record<string, any>>;
const changes = JSON.parse(readFileSync(path.join(root, "data", "deal_changes.json"), "utf-8")).changes as Array<Record<string, any>>;

const recordFor = (vendor: string) => offers.find((o) => o.vendor === vendor)!;
const newestChangeFor = (vendor: string) =>
  changes.filter((c) => c.vendor === vendor).sort((a, b) => String(a.date).localeCompare(String(b.date))).at(-1);

const ENTITIES: Record<string, string> = {
  "&mdash;": "—", "&ndash;": "–", "&amp;": "&", "&quot;": '"', "&#39;": "'",
  "&nbsp;": " ", "&lt;": "<", "&gt;": ">", "&rarr;": "→",
};

function readableText(html: string): string {
  return html
    .replace(/<(script|style|svg)\b[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&[a-z#0-9]+;/gi, (e) => ENTITIES[e] ?? e)
    .replace(/\s+/g, " ")
    .trim();
}

function startServer(): Promise<ChildProcess> {
  return new Promise((resolve, reject) => {
    const proc = spawn("node", [path.join(root, "dist", "serve.js")], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, PORT: "0", BASE_URL: "http://localhost", TZ: "UTC" },
    });
    const timeout = setTimeout(() => { proc.kill(); reject(new Error("Server startup timeout")); }, 20000);
    proc.stderr!.on("data", (data: Buffer) => {
      const match = data.toString().match(/running on http:\/\/localhost:(\d+)/);
      if (match) { base = `http://localhost:${match[1]}`; clearTimeout(timeout); resolve(proc); }
    });
    proc.on("error", (err) => { clearTimeout(timeout); reject(err); });
  });
}

let server: ChildProcess;
let base = "";
const pages: Record<string, string> = {};

const NHOST_STORAGE_GB = () => {
  const stated = recordFor("Nhost").description.match(/(\d+(?:\.\d+)?) GB storage/i);
  assert.ok(stated, `the Nhost record no longer states a storage allowance: ${recordFor("Nhost").description}`);
  return stated![1];
};

describe("the BaaS comparisons state the free limits our own record holds (#1367)", () => {
  before(async () => {
    server = await startServer();
    for (const slug of ["firebase-alternatives", "supabase-vs-firebase"]) {
      pages[slug] = readableText(await (await fetch(`${base}/${slug}`)).text());
    }
  });

  after(() => { server?.kill(); });

  it("gives Nhost the storage its record states in the hand-written comparison table", () => {
    const row = pages["firebase-alternatives"].match(/Nhost (1 GB Postgres [^]{1,60}?) MIT/);
    assert.ok(row, "the comparison table no longer carries an Nhost row");
    assert.strictEqual(
      row![1],
      `1 GB Postgres ${NHOST_STORAGE_GB()} GB Included Included 5 GB ✅ (GraphQL)`,
      "the hand-written row and the catalogue record state different free limits",
    );
  });

  it("gives Nhost the same storage on the page that renders the record rather than a table", () => {
    assert.match(pages["supabase-vs-firebase"], new RegExp(`Nhost Free [^]{0,120}?${NHOST_STORAGE_GB()} GB storage`));
  });

  it("keeps the record's figures in step with the newest change record we hold for that vendor", () => {
    const record = recordFor("Nhost");
    const change = newestChangeFor("Nhost");
    assert.ok(change?.current_state, "no Nhost change record states a current tier");
    for (const field of ["database", "storage"] as const) {
      const inChange = String(change!.current_state).match(new RegExp(`(\\d+(?:\\.\\d+)?) GB ${field}`, "i"));
      const inRecord = record.description.match(new RegExp(`(\\d+(?:\\.\\d+)?) GB ${field}`, "i"));
      assert.ok(inChange && inRecord, `${field} is stated by only one of the two: ${change!.current_state} / ${record.description}`);
      assert.strictEqual(
        inRecord![1],
        inChange![1],
        `the catalogue gives Nhost ${inRecord![1]} GB ${field} and our own ${change!.date} record gives ${inChange![1]} GB`,
      );
    }
  });

  it("publishes the withdrawn storage figure on neither page", () => {
    for (const [slug, text] of Object.entries(pages)) {
      assert.doesNotMatch(text, /Nhost 1 GB Postgres 5 GB/, slug);
      assert.doesNotMatch(text, /Nhost Free [^]{0,120}?5 GB storage/, slug);
    }
  });
});
