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

const COMPARISON = "/email-comparison-2026";

function rowCells(html: string, vendor: string): string[] {
  for (const [, row] of html.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/g)) {
    const cells = [...row.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/g)].map((m) => readableText(m[1]));
    if (cells[0] === vendor || cells[0]?.startsWith(`${vendor} `)) return cells;
  }
  assert.fail(`no table row names ${vendor}`);
}

function cardText(html: string, vendor: string): string {
  const card = html.match(new RegExp(`<h3>${vendor}\\b([\\s\\S]*?)(?=<h[23]\\b)`));
  assert.ok(card, `no card is headed ${vendor}`);
  return readableText(card![1]);
}

function recordFigures(vendor: string, pattern: RegExp): string[] {
  const description = recordFor(vendor).description;
  const match = description.match(pattern);
  assert.ok(match, `the ${vendor} record no longer matches ${pattern}: ${description}`);
  return match!.slice(1);
}

describe("an email free tier typed into a page states what the vendor's own record holds", () => {
  let proc: ChildProcess | undefined;
  const html: Record<string, string> = {};

  before(async () => {
    proc = await startServer();
    for (const route of [COMPARISON, "/email-service-alternatives", "/email-alternatives", "/free-frontend-stack"]) {
      html[route] = await (await fetch(`${base}${route}`)).text();
    }
  });

  after(() => { proc?.kill(); });

  it("gives Plunk's cloud plan the monthly allowance its record states", () => {
    const [allowance] = recordFigures("Plunk", /(\d[\d,]*) [a-z/]+ emails\/month/i);
    const card = cardText(html[COMPARISON], "Plunk");
    assert.strictEqual(rowCells(html[COMPARISON], "Plunk")[2], `${allowance}/mo (cloud)`);
    assert.match(card, new RegExp(`Free tier: ${allowance} emails/month on cloud`), `Plunk's card reads: ${card}`);
  });

  it("gives Mailchimp the contact allowance and daily cap its record states, on every page that names them", () => {
    const [contacts] = recordFigures("Mailchimp", /(\d[\d,]*) contacts/);
    const [daily] = recordFigures("Mailchimp", /\((\d[\d,]*)\/day cap\)/);
    const cells = rowCells(html[COMPARISON], "Mailchimp");
    const card = cardText(html[COMPARISON], "Mailchimp");
    assert.deepStrictEqual([cells[3], cells[4]], [`${daily}/day`, contacts]);
    assert.match(card, new RegExp(`Free tier: ${contacts} contacts, [\\d,]+ emails/month, ${daily}/day cap`), `Mailchimp's card reads: ${card}`);
    const outgrow = readableText(html["/free-frontend-stack"]).match(/Mailchimp gives ([\d,]+) contacts/);
    assert.strictEqual(outgrow?.[1], contacts);
  });

  it("gives Mailjet the contact allowance its record states, in both tables with a contacts column", () => {
    const [contacts] = recordFigures("Mailjet", /(\d[\d,]*) contacts/);
    const card = cardText(html[COMPARISON], "Mailjet");
    assert.strictEqual(rowCells(html[COMPARISON], "Mailjet")[4], contacts);
    assert.strictEqual(rowCells(html["/email-service-alternatives"], "Mailjet")[2], contacts);
    assert.match(card, new RegExp(`up to ${contacts} contacts`), `Mailjet's card reads: ${card}`);
  });

  it("gives Sweego the daily allowance its record states", () => {
    const [daily] = recordFigures("Sweego", /(\d[\d,]*) emails\/day/);
    const cells = rowCells(html[COMPARISON], "Sweego");
    const card = cardText(html[COMPARISON], "Sweego");
    assert.deepStrictEqual([cells[2].split(" ")[0], cells[3]], [`${daily}/day`, `${daily}/day`]);
    assert.match(card, new RegExp(`Free tier: ${daily} emails a day`), `Sweego's card reads: ${card}`);
  });

  it("presents Postmark's free plan as the allowance its record says never expires, not as a test sandbox", () => {
    const [allowance] = recordFigures("Postmark", /(\d[\d,]*) emails\/month free, never expires/);
    const cells = rowCells(html[COMPARISON], "Postmark");
    const card = cardText(html[COMPARISON], "Postmark");
    assert.strictEqual(cells[2], `${allowance}/mo`);
    assert.match(card, new RegExp(`Free tier: ${allowance} emails a month, never expires`), `Postmark's card reads: ${card}`);
    for (const surface of [cells.join(" | "), card]) {
      assert.doesNotMatch(surface, /test only|test emails|sandbox|not usable for production/i, `Postmark reads: ${surface}`);
    }
  });

  it("gives Mailtrap.io the sending allowance and daily cap its record states", () => {
    const [monthly, daily] = recordFigures("Mailtrap.io", /Email API\/SMTP: (\d[\d,]*) emails\/month \((\d[\d,]*)\/day cap\)/);
    assert.strictEqual(rowCells(html["/email-alternatives"], "Mailtrap.io")[2], `${monthly} emails/mo (${daily}/day)`);
  });

  it("gives MailerSend's free plan its own limits rather than the Hobby plan's", () => {
    const card = cardText(html[COMPARISON], "MailerSend");
    assert.match(card, /Free accounts get 1 sending domain and 100 daily API requests/, `MailerSend's card reads: ${card}`);
    assert.doesNotMatch(card, /1,000 daily API requests|10 templates|5 seats/, `MailerSend's card reads: ${card}`);
  });

  it("gives MailerSend the daily limit its record states, and never says it has no daily cap", () => {
    const [daily] = recordFigures("MailerSend.com", /at most (\d[\d,]*) a day/);
    const card = cardText(html[COMPARISON], "MailerSend");
    assert.strictEqual(rowCells(html[COMPARISON], "MailerSend")[3], `${daily} API requests`);
    assert.match(card, new RegExp(`${daily} daily API requests`), `MailerSend's card reads: ${card}`);
    assert.doesNotMatch(card, /no daily cap/i, `MailerSend's card reads: ${card}`);
  });

  it("states SendGrid's included Pro and Premier IP and optional additional IPs in the cell and paragraph", () => {
    const cell = rowCells(html[COMPARISON], "SendGrid")[8];
    const trap = readableText(html[COMPARISON]).match(/The dedicated IP trap: .*? This hidden cost/)?.[0] ?? "";
    for (const value of [cell, trap]) {
      assert.match(value, /(?:1|one) (?:included|dedicated IP)/);
      assert.match(value, /Pro \(from \$89\.95\/(?:mo|month)\)/);
      assert.match(value, /Premier/);
      assert.match(value, /(?:more|additional IPs).*add-on/);
      assert.doesNotMatch(value, /\$80/);
    }
  });

  it("labels Brevo's monthly Starter prices and bounds the daily free plan's monthly volume", () => {
    const growth = html[COMPARISON].match(/<h2 id="cost-trap">Growth Cost Trap<\/h2>([\s\S]*?)(?=<h2\b)/)?.[1] ?? "";
    assert.match(readableText(growth), /Brevo column: Starter, billed monthly/);
    assert.match(growth, /href="https:\/\/www\.brevo\.com\/pricing\/"[^>]*rel="nofollow noopener"/);
    const tenK = growth.match(/<tr>\s*<td><strong>10K emails<\/strong><\/td>([\s\S]*?)<\/tr>/)?.[1] ?? "";
    const lastCell = [...tenK.matchAll(/<td\b[^>]*>.*?<\/td>/g)].at(-1)?.[0] ?? "";
    assert.strictEqual(lastCell, "<td>$17.00</td>");
    const card = cardText(html[COMPARISON], "Brevo");
    assert.match(card, /300 emails\/day.*at most 9,300 a month/);
    assert.doesNotMatch(card, /no monthly cap/);
  });

  it("prices dedicated IPs as Resend and Maileroo sell them, and keeps Resend's free volume and daily cap", () => {
    const resend = rowCells(html[COMPARISON], "Resend");
    assert.deepStrictEqual([resend[2], resend[3], resend[8]], ["3,000/mo", "100/day", "$30/mo add-on (Scale)"]);
    assert.strictEqual(rowCells(html[COMPARISON], "Maileroo")[8], "Included (all plans)");
    const trap = readableText(html[COMPARISON]).match(/The dedicated IP trap: .*? This hidden cost/)?.[0] ?? "";
    assert.match(trap, /Resend offers dedicated IPs as a \$30\/month add-on on the Scale plan, for senders above 3,000 emails a day\./, `the dedicated IP paragraph reads: ${trap}`);
    assert.doesNotMatch(trap, /Pro \(\$80\/month\)/, `the dedicated IP paragraph reads: ${trap}`);
  });
});

describe("the email growth table prices monthly sending volumes", () => {
  let proc: ChildProcess | undefined;
  let columns: string[];
  let rows: Map<string, string[]>;

  before(async () => {
    proc = await startServer();
    const response = await fetch(`${base}${COMPARISON}`, { redirect: "error" });
    assert.strictEqual(response.status, 200);
    const html = await response.text();
    const section = html.match(/<h2 id="cost-trap">Growth Cost Trap<\/h2>([\s\S]*?)(?=<h2\b)/);
    assert.ok(section, "the growth cost section is missing");
    const tables = [...section[1].matchAll(/<table\b[^>]*>([\s\S]*?)<\/table>/g)];
    assert.strictEqual(tables.length, 1);
    const table = tables[0][1];
    columns = [...table.matchAll(/<th\b[^>]*>([\s\S]*?)<\/th>/g)].map((m) => readableText(m[1]));
    rows = new Map();
    for (const [, row] of table.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/g)) {
      const cells = [...row.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/g)].map((m) => readableText(m[1]));
      if (!cells.length) continue;
      assert.strictEqual(cells.length, 8, cells.join(" | "));
      assert.ok(!rows.has(cells[0]), `duplicate volume: ${cells[0]}`);
      rows.set(cells[0], cells.slice(1));
    }
  });

  after(() => { proc?.kill(); });

  function price(volume: string, vendor: string): string {
    assert.ok(rows.has(`${volume} emails`), `missing volume: ${volume}`);
    const column = columns.indexOf(vendor);
    assert.ok(column > 0, `missing vendor: ${vendor}`);
    return rows.get(`${volume} emails`)![column - 1];
  }

  it("keeps all six volumes and all seven vendor columns", () => {
    assert.deepStrictEqual(columns, ["Monthly Volume", "Amazon SES", "Resend", "Maileroo", "MailerSend", "SendGrid", "Postmark", "Brevo"]);
    assert.deepStrictEqual([...rows.keys()], ["3K emails", "10K emails", "50K emails", "100K emails", "500K emails", "1M emails"]);
  });

  it("uses Maileroo's published monthly plans at 50K, 100K, 500K and 1M", () => {
    for (const [volume, expected] of [["50K", "$15.00"], ["100K", "$30.00"], ["500K", "$140.00"], ["1M", "$250.00"]]) {
      assert.strictEqual(price(volume, "Maileroo"), expected, `Maileroo at ${volume}`);
    }
  });

  it("uses Resend Pro at 100K and Scale at 500K and 1M", () => {
    for (const [volume, expected] of [["100K", "$35.00"], ["500K", "$350.00"], ["1M", "$650.00"]]) {
      assert.strictEqual(price(volume, "Resend"), expected, `Resend at ${volume}`);
    }
  });

  it("prices Brevo Starter with monthly billing and leaves unquoted volumes without an invented price", () => {
    for (const [volume, expected] of [["10K", "$17.00"], ["50K", "$56.00"], ["100K", "$82.00"], ["500K", "No public price"], ["1M", "No public price"]]) {
      assert.strictEqual(price(volume, "Brevo"), expected, `Brevo at ${volume}`);
    }
  });

  it("uses MailerSend's 100K monthly subscription", () => {
    assert.strictEqual(price("100K", "MailerSend"), "$68.00");
  });

  it("preserves every other price, including SES at one million emails", () => {
    const unchanged: Record<string, Array<string | null>> = {
      "3K": ["$0.30", "$0 (free)", "$0 (free)", "$7.00", "$19.95", "$15.00", "$0 (free)"],
      "10K": ["$1.00", "$20.00", "$10.00", "$28.00", "$19.95", "$15.00", null],
      "50K": ["$5.00", "$20.00", null, "$28.00", "$19.95", "$42.50", null],
      "100K": ["$10.00", null, null, null, "$89.95", "$70.00", null],
      "500K": ["$50.00", null, null, "$210.00", "$449.95", "$245.00", null],
      "1M": ["$100.00", null, null, "$360.00", "$749.95", "$400.00", null],
    };
    for (const [volume, expected] of Object.entries(unchanged)) {
      expected.forEach((value, column) => {
        if (value !== null) assert.strictEqual(price(volume, columns[column + 1]), value, `${columns[column + 1]} at ${volume}`);
      });
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
