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
  "&nbsp;": " ", "&lt;": "<", "&gt;": ">", "&rarr;": "→", "&#10003;": " ", "&#10007;": " ",
};

function readableText(html: string): string {
  return html
    .replace(/<(script|style|svg)\b[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&[a-z#0-9]+;/gi, (e) => ENTITIES[e] ?? e)
    .replace(/\s+/g, " ")
    .trim();
}

let server: ChildProcess;
let base = "";
let page = "";

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

describe("the email comparison states the free volumes our own records hold (#1183)", () => {
  before(async () => {
    server = await startServer();
    page = readableText(await (await fetch(`${base}/email-comparison-2026`)).text());
  });

  after(() => { server?.kill(); });

  it("gives MailerSend the send allowance its record states, on every surface that names one", () => {
    const record = recordFor("MailerSend.com");
    const allowance = record.description.match(/(\d[\d,]*) emails\/month/i);
    assert.ok(allowance, `the MailerSend record no longer states a send allowance: ${record.description}`);
    assert.match(page, new RegExp(`${allowance![1]} emails/month`));
    assert.doesNotMatch(page, /MailerSend Transactional 3,000\/mo/);
    assert.doesNotMatch(page, /Free tier: 3,000 emails\/month\. Built by the team behind MailerLite/);
  });

  it("prices 3,000 emails on MailerSend above zero, because its free plan stops at 500", () => {
    const row = page.match(/3K emails (.*?) 10K emails/);
    assert.ok(row, "the growth cost table no longer carries a 3K row");
    const cells = row![1].trim().split(/ (?=\$)/);
    assert.strictEqual(cells.length, 7, `the 3K row no longer has one cell per vendor: ${row![1]}`);
    assert.strictEqual(cells[3], "$7.00", `the MailerSend cell of the 3K row reads ${cells[3]}`);
  });

  it("gives MailerLite the subscriber and send allowances its record states", () => {
    const record = recordFor("MailerLite.com");
    const subscribers = record.description.match(/(\d[\d,]*) subscribers/i);
    const emails = record.description.match(/(\d[\d,]*) emails\/month/i);
    assert.ok(subscribers && emails, `the MailerLite record states no allowance: ${record.description}`);
    assert.match(page, new RegExp(`${subscribers![1]} subscribers`));
    assert.match(page, new RegExp(`${emails![1]} emails/month`));
    assert.doesNotMatch(page, /1,000 subscribers, 12,000 emails\/month/);
  });

  it("gives Resend the domain count its record states", () => {
    const record = recordFor("Resend");
    const domains = record.description.match(/(\d+) domains?/i);
    assert.ok(domains, `the Resend record states no domain count: ${record.description}`);
    assert.match(page, new RegExp(`${domains![1]} custom domains?`));
  });

  it("marks a vendor whose free tier shrank as one to watch, not as stable", () => {
    for (const vendor of ["MailerSend", "MailerLite"]) {
      const row = page.match(new RegExp(`${vendor} SHRINKING .*?(Stable|Watch|Volatile)`));
      assert.ok(row, `${vendor} no longer carries the badge its own change log justifies`);
      assert.strictEqual(row![1], "Watch", `${vendor}'s row is rated ${row![1]} on a free tier that shrank`);
    }
  });
});

describe("a catalogue record carries what its own newest change record states", () => {
  it("gives Resend the domain count its 2026-09-05 change record announced", () => {
    const change = newestChangeFor("Resend");
    assert.ok(change, "no Resend change record to check the description against");
    const domains = change!.current_state.match(/(\d+) domains?/i);
    assert.ok(domains, `the newest Resend change states no domain count: ${change!.current_state}`);
    assert.match(recordFor("Resend").description, new RegExp(`${domains![1]} domains?`));
  });

  it("gives Appwrite Cloud the project cap its 2026-09-05 change record announced", () => {
    const change = newestChangeFor("Appwrite Cloud");
    assert.ok(change, "no Appwrite Cloud change record to check the description against");
    const projects = change!.current_state.match(/limited to (\d+) projects/i);
    assert.ok(projects, `the newest Appwrite Cloud change states no project cap: ${change!.current_state}`);
    assert.match(recordFor("Appwrite Cloud").description, new RegExp(`${projects![1]} projects`));
  });
});
