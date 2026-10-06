import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(__dirname, "..");
const { FIGURE_SOURCE_CLASS } = await import("../dist/source-citation.js");
const FIGURE_SOURCE_LINK = new RegExp(`<a\\b[^>]*class="${FIGURE_SOURCE_CLASS}"[^>]*>[\\s\\S]*?<\\/a>`, "g");

const STATED: Record<string, string[]> = {
  "/digitalocean-free-tier-2026": [
    "$5 Signup Credit",
    "New DigitalOcean accounts get a $5 signup credit, applied automatically to the first team and valid for 90 days after signup. It covers all products except SaaS Add-Ons, and you must add a payment method before you can create Droplets or other resources. Until April 2026, new accounts got $200 for 60 days.",
    "DigitalOcean's free offering is limited to $5 in trial credits (90 days)",
    "The $5 credit expires after 90 days.",
    "Payment method required to use the credit",
    "The $5 credit is applied automatically, but you must add a valid payment method before you can create Droplets or other resources.",
    "Using the $5 credit. It covers about nine days of the smallest Managed PostgreSQL node ($15.15 a month), so destroy test resources when you are done with them. App Platform hosts up to three static-site apps free. Charges to your payment method begin when the credit runs out or expires.",
    "$5 Free Credits (90 days)",
  ],
  "/cloud-free-tier-comparison-2026": [
    "$5–300 Trial Credits Range",
    "GCP offers the most generous trial: $300 over 90 days vs Azure's $200/30 days. AWS gives new accounts $100 in credits and up to $100 more for trying key services, on a Free plan that closes after 6 months or when the credits run out. DigitalOcean gives new accounts a $5 credit for 90 days. All require a credit card.",
  ],
  "/heroku-alternatives": ["DigitalOcean credit expires after 90 days."],
  "/storage-comparison-2026": ["Available during the $5/90-day trial."],
};

const DESCRIBED: Record<string, string> = {
  "/digitalocean-free-tier-2026": "Complete guide to DigitalOcean pricing and free tier in 2026. $5 free credits for 90 days,",
};

const WITHDRAWN = [
  "$200 Free Credits",
  "$200 free credits",
  "$200 in free credits",
  "$200 credit expires",
  "$200 in trial credits",
  "Free Credits (60 days)",
  "The 60-day window is tight",
  "day 55",
  "DigitalOcean's $200/60 days",
  "good middle ground on duration",
  "doesn't offer a blanket credit",
  "$200 credit (60 days)",
  "DigitalOcean credit expires after 60 days",
  "$200/60-day",
];

const REPLACED = [
  "How to maximize the trial",
  "Credit card required at signup",
  "Credit card required for free credits",
  "claim the $5 free credits",
  "None (service-level free tiers)",
  "Each service has individual limits",
];

const TRIAL_ROWS: Record<string, string[]> = {
  AWS: [
    "$100 + up to $100",
    "6 months (Free plan)",
    "New accounts only; the Free plan closes at 6 months or when the credits run out, and AWS erases the account 90 days later unless you upgrade",
    "Yes",
  ],
  GCP: ["$300", "90 days"],
  Azure: ["$200", "30 days"],
  DigitalOcean: ["$5", "90 days", "New accounts only", "Yes"],
};

const PAGES = Object.keys(STATED);

const ENTITIES: Record<string, string> = {
  "&mdash;": "—", "&ndash;": "–", "&amp;": "&", "&quot;": '"', "&#39;": "'", "&#x27;": "'",
  "&rsquo;": "’", "&nbsp;": " ", "&middot;": "·", "&rarr;": "→", "&gt;": ">", "&lt;": "<",
};

function decode(text: string): string {
  return text.replace(/&[a-z#0-9]+;/gi, (e) => ENTITIES[e] ?? e);
}

function readable(html: string): string {
  return decode(
    html
      .replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, " ")
      .replace(/<\/?(?:a|abbr|b|code|em|i|small|span|strong|sub|sup)\b[^>]*>/gi, "")
      .replace(/<[^>]+>/g, " "),
  ).replace(/\s+/g, " ").trim();
}

function rowsOf(html: string): string[][] {
  return [...html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)].map(([, row]) =>
    [...row.matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/g)].map(([, cell]) => readable(cell.replace(FIGURE_SOURCE_LINK, ""))),
  );
}

function rowFor(rows: string[][], provider: string, cells: string[]): boolean {
  return rows.some(([first, ...rest]) => first?.startsWith(provider) && cells.every((cell, i) => rest[i] === cell));
}

function descriptions(html: string): string[] {
  return [...html.matchAll(/<meta (?:name|property)="(?:description|og:description)" content="([^"]*)"/g)].map((m) => decode(m[1]));
}

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
  for (const page of [...PAGES, "/hetzner-pricing-2026"]) {
    const response = await fetch(`http://localhost:${port}${page}`);
    assert.strictEqual(response.status, 200, page);
    served.set(page, await response.text());
  }
});

after(() => { proc?.kill(); });

describe("the DigitalOcean guides state the $5 signup credit for 90 days", () => {
  it("renders each statement of the credit on its page", () => {
    const missing = Object.entries(STATED).flatMap(([page, lines]) =>
      lines.filter((line) => !readable(served.get(page)!).includes(line)).map((line) => `${page}: ${line}`),
    );
    assert.deepStrictEqual(missing, []);
  });

  it("describes the DigitalOcean guide with the $5 credit in its description and og:description", () => {
    for (const [page, opening] of Object.entries(DESCRIBED)) {
      const found = descriptions(served.get(page)!);
      assert.strictEqual(found.length, 2, `${page} carries a description and an og:description`);
      for (const description of found) assert.ok(description.startsWith(opening), description);
    }
  });

  it("links the DigitalOcean guide from another guide with the $5 credit", () => {
    const hetzner = readable(served.get("/hetzner-pricing-2026")!);
    assert.ok(hetzner.includes("Complete DigitalOcean guide — $5 free credits"), "the related-guides blurb names the $5 credit");
  });

  it("prints none of the withdrawn $200 statements on these pages or in their structured data", () => {
    const left = [...served.entries()].flatMap(([page, html]) =>
      WITHDRAWN.filter((claim) => readable(html).includes(claim) || decode(html).includes(claim)).map((claim) => `${page}: ${claim}`),
    );
    assert.deepStrictEqual(left, []);
  });

  it("prints none of the replaced trial advice, payment pitfall or AWS trial row on these pages or in their structured data", () => {
    const left = [...served.entries()].flatMap(([page, html]) =>
      REPLACED.filter((claim) => readable(html).includes(claim) || decode(html).includes(claim)).map((claim) => `${page}: ${claim}`),
    );
    assert.deepStrictEqual(left, []);
  });

  it("lists AWS's and DigitalOcean's credits beside GCP's and Azure's unchanged ones in the trial credits table", () => {
    const rows = rowsOf(served.get("/cloud-free-tier-comparison-2026")!);
    for (const [provider, cells] of Object.entries(TRIAL_ROWS)) {
      assert.ok(rowFor(rows, provider, cells), `${provider}: ${rows.filter(([first]) => first?.startsWith(provider)).map((r) => r.join(" | ")).join(" / ")}`);
    }
  });

  it("prices DigitalOcean's credit at $5 for 90 days in the Heroku alternatives table", () => {
    const rows = rowsOf(served.get("/heroku-alternatives")!);
    assert.ok(rowFor(rows, "DigitalOcean", ["$5 credit (90 days)"]), rows.filter(([first]) => first?.startsWith("DigitalOcean")).map((r) => r.join(" | ")).join(" / "));
  });
});
