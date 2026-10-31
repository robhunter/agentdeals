import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");

const offers = JSON.parse(readFileSync(path.join(root, "data", "index.json"), "utf-8")).offers as Array<Record<string, any>>;

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

function listingText(vendor: string): string {
  const record = offers.find((o) => o.vendor === vendor);
  assert.ok(record, `no listing is named ${vendor}`);
  return [record!.description, ...(record!.conditions ?? []).map((c: { text: string }) => c.text)].join(" ");
}

function listingFigures(vendor: string, pattern: RegExp): string[] {
  const text = listingText(vendor);
  const match = text.match(pattern);
  assert.ok(match, `the ${vendor} listing no longer matches ${pattern}: ${text}`);
  return match!.slice(1);
}

function sandboxFigures(): string[] {
  return listingFigures("Northflank", /free Sandbox includes (\d+) services, (\d+) jobs and (\d+) database, up to \$(\d+) a month of resources on Northflank Cloud/);
}

const inFull = (thousands: string) => (Number(thousands.replace(/K$/, "")) * 1000).toLocaleString("en-US");

function tableRows(html: string, header: string): string[][] {
  for (const [, table] of html.matchAll(/<table\b[^>]*>([\s\S]*?)<\/table>/g)) {
    const headers = [...table.matchAll(/<th\b[^>]*>([\s\S]*?)<\/th>/g)].map((m) => readableText(m[1]));
    if (!headers.includes(header)) continue;
    return [...table.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/g)]
      .map(([, row]) => [...row.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/g)].map((m) => readableText(m[1])))
      .filter((cells) => cells.length > 0);
  }
  assert.fail(`no table has a ${header} column`);
}

function rowStarting(rows: string[][], ...lead: string[]): string[] {
  const found = rows.find((cells) => lead.every((text, i) => cells[i] === text || cells[i]?.startsWith(`${text} `) || cells[i]?.startsWith(`${text}:`)));
  assert.ok(found, `no row starts ${lead.join(" | ")}`);
  return found!;
}

function cardText(html: string, vendor: string): string {
  const card = html.match(new RegExp(`<h3>(?:<a\\b[^>]*>)?${vendor}\\b([\\s\\S]*?)(?=<h[23]\\b)`));
  assert.ok(card, `no card is headed ${vendor}`);
  return readableText(card![1]);
}

let base = "";

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

const HOSTING = "/hosting-pricing";
const APP_RUNNER = "/aws-app-runner-migration";
const CLOUD = "/cloud-free-tier-comparison-2026";
const ALTERNATIVES = "/hosting-alternatives";
const STORAGE = "/storage-comparison-2026";
const FRONTEND_STACK = "/free-frontend-stack";
const NEXTJS_STACK = "/free-nextjs-stack";
const DIGITALOCEAN = "/digitalocean-free-tier-2026";
const VERCEL_ALTERNATIVES = "/vercel-alternatives";
const NETLIFY_ROUTES = [ALTERNATIVES, FRONTEND_STACK, NEXTJS_STACK, DIGITALOCEAN, VERCEL_ALTERNATIVES];

const BLOCK_END_OUTSIDE_ROWS = /<\/(?:p|li|tr|div|h[1-6]|dd|dt|section|article|table|ul|ol|summary|details|blockquote)>|<br\s*\/?>/i;

const sentencesAndTableRows = (html: string) => html
  .replace(/<(script|style|svg)\b[\s\S]*?<\/\1>/gi, " ")
  .split(BLOCK_END_OUTSIDE_ROWS)
  .flatMap((block) => readableText(block).split(/(?<=[.!?])\s+/));

describe("a hosting or cloud free tier typed into a page states what the vendor's own listing holds", () => {
  let proc: ChildProcess | undefined;
  const html: Record<string, string> = {};

  before(async () => {
    proc = await startServer();
    for (const route of new Set([HOSTING, APP_RUNNER, CLOUD, ALTERNATIVES, STORAGE, ...NETLIFY_ROUTES])) {
      html[route] = await (await fetch(`${base}${route}`)).text();
    }
  });

  after(() => { proc?.kill(); });

  it("gives Google Cloud Run the vCPU-seconds and GiB-seconds its listing states, on every page that types them", () => {
    const [memory, cpu] = listingFigures("Google Cloud Run", /([\d,]+K) GB-seconds memory, ([\d,]+K) vCPU-seconds compute/);
    assert.strictEqual(rowStarting(tableRows(html[HOSTING], "Free Compute"), "Google Cloud Run")[4], `2M requests/mo, ${cpu} vCPU-sec, ${memory} GiB-sec`);
    assert.match(cardText(html[HOSTING], "Google Cloud Run"), new RegExp(`2 million requests/month, ${inFull(cpu)} vCPU-seconds, ${inFull(memory)} GiB-seconds of memory`));
    assert.strictEqual(rowStarting(tableRows(html[APP_RUNNER], "Source Deploy"), "Google Cloud Run")[1], `2M requests/mo, ${cpu} vCPU-sec, ${memory} GiB-sec free`);
    assert.strictEqual(rowStarting(tableRows(html[APP_RUNNER], "Scaling Model"), "Google Cloud Run")[1], `2M req + ${cpu} vCPU-sec/mo`);
    const appRunner = readableText(html[APP_RUNNER]);
    assert.match(appRunner, new RegExp(`Google Cloud Run's free tier is 2 million requests/month, ${cpu} vCPU-seconds, and scale to zero`));
    assert.match(appRunner, new RegExp(`Google Cloud Run — 2M requests/month, ${cpu} vCPU-seconds, scale to zero`));
    assert.strictEqual(rowStarting(tableRows(html[CLOUD], "Free Compute"), "GCP", "Cloud Run")[3], `${cpu} vCPU-seconds, ${memory} GiB-seconds`);
    assert.strictEqual(rowStarting(tableRows(html[ALTERNATIVES], "Compute / Resources"), "Google Cloud Run")[2], `2M req/mo, ${cpu} vCPU-sec`);
  });

  it("never pairs Cloud Run's memory figure with vCPU-seconds or its vCPU figure with GiB-seconds", () => {
    const [memory, cpu] = listingFigures("Google Cloud Run", /([\d,]+K) GB-seconds memory, ([\d,]+K) vCPU-seconds compute/);
    const swapped = new RegExp(`(${memory}|${inFull(memory)}) vCPU|(${cpu}|${inFull(cpu)}) Gi?B`);
    for (const route of [HOSTING, APP_RUNNER, CLOUD, ALTERNATIVES]) {
      const mentions = readableText(html[route]).match(/Cloud Run[^.]*?\d[^.]*\./g) ?? [];
      assert.ok(mentions.length > 0, `${route} no longer states a figure after naming Cloud Run`);
      for (const mention of mentions) assert.doesNotMatch(mention, swapped, `${route} reads: ${mention}`);
    }
  });

  it("gives Render's free plan the build minutes its listing states, apart from its free instance hours", () => {
    const [hours] = listingFigures("Render", /(\d[\d,]*) free instance hours/);
    const [minutes] = listingFigures("Render", /(\d[\d,]*) build minutes\/month/);
    assert.strictEqual(rowStarting(tableRows(html[HOSTING], "Build Minutes"), "Render")[3], `${minutes} min/mo`);
    const card = cardText(html[HOSTING], "Render");
    assert.match(card, new RegExp(`${hours} free instance hours/month, ${minutes} build minutes/month`), `Render's card reads: ${card}`);
    assert.doesNotMatch(card, /build hours/, `Render's card reads: ${card}`);
  });

  it("gives Vercel Hobby no monthly build-minute quota", () => {
    assert.strictEqual(rowStarting(tableRows(html[HOSTING], "Build Minutes"), "Vercel")[3], "No monthly quota (45 min per build, 100 deployments/day)");
  });

  it("starts the wall where each vendor with no free plan actually starts charging", () => {
    const [koyebPro] = listingFigures("Koyeb", /Pro \(\$(\d+) a month/);
    const walls = tableRows(html[HOSTING], "When You Hit the Wall");
    assert.strictEqual(rowStarting(walls, "Fly.io")[4], "Immediately (pay-as-you-go after a trial of 2 machine hours or 7 days)");
    assert.strictEqual(rowStarting(walls, "Koyeb")[4], `Immediately ($${koyebPro}/mo Pro minimum)`);
    assert.strictEqual(rowStarting(walls, "Heroku")[4], "Immediately ($5/mo minimum)");
  });

  it("prices PythonAnywhere's and Northflank's cheapest paid plans as their listings do", () => {
    const [developer] = listingFigures("PythonAnywhere", /\$(\d+)-a-month Developer plan/);
    const [smallest] = listingFigures("Northflank", /the smallest plan, 0\.1 vCPU and 256 MB, is \$([\d.]+) a month/);
    const plans = tableRows(html[HOSTING], "Paid From");
    assert.strictEqual(rowStarting(plans, "PythonAnywhere")[2], `$${developer}/mo (Developer)`);
    assert.strictEqual(rowStarting(plans, "Northflank")[2], `$${smallest}/mo (0.1 vCPU, 256 MB)`);
    const costs = rowStarting(tableRows(html[HOSTING], "Solo Dev /mo"), "PythonAnywhere");
    assert.strictEqual(costs[1], `$0–${developer}`);
    assert.match(costs[3], new RegExp(`Jump from free to \\$${developer}/month`));
  });

  it("states Northflank's free Sandbox workloads and Cloud allowance in the hosting comparison row", () => {
    const [services, jobs, databases, allowance] = sandboxFigures();
    const row = rowStarting(tableRows(html[HOSTING], "Free Compute"), "Northflank");
    assert.strictEqual(row[1], `Sandbox: ${services} services, ${jobs} jobs, ${databases} database`);
    assert.strictEqual(row[4], `Up to $${allowance}/mo on Northflank Cloud; always on, no sleeping`);
  });

  it("states Northflank's included database and monthly resource allowance in its hosting card", () => {
    const [services, jobs, databases, allowance] = sandboxFigures();
    const card = html[HOSTING].match(/<h3><a\b[^>]*>Northflank<\/a>[\s\S]*?<p class="diff-desc">([\s\S]*?)<\/p>/);
    assert.ok(card, "no Northflank hosting card description");
    assert.strictEqual(readableText(card![1]), `Free Sandbox: ${services} services, ${jobs} jobs and ${databases} database, with up to $${allowance} a month of resources on Northflank Cloud. Always on, no sleeping. Supports containers, buildpacks, and databases. Auto-deploy from Git. Built-in secrets management, job scheduling, and observability.`);
  });

  it("includes Northflank's free database and Cloud resource allowance in the displayed cost factor", () => {
    const [services, jobs, databases, allowance] = sandboxFigures();
    const row = rowStarting(tableRows(html[HOSTING], "Solo Dev /mo"), "Northflank");
    const costs = `${services} services, ${jobs} jobs, ${databases} database; up to $${allowance}/mo on Northflank Cloud; always on. Scaling beyond free resources is usage-based.`;
    assert.strictEqual(row[3], costs);
    assert.match(row[3], /Northflank Cloud; always on\./);
  });

  it("states Northflank's free Sandbox and smallest paid compute plan in the migration comparison", () => {
    const [services, jobs, databases, allowance] = sandboxFigures();
    const [smallest] = listingFigures("Northflank", /the smallest plan, 0\.1 vCPU and 256 MB, is \$([\d.]+) a month/);
    const row = rowStarting(tableRows(html[APP_RUNNER], "Source Deploy"), "Northflank");
    assert.strictEqual(row[1], `Free Sandbox: ${services} services, ${jobs} jobs, ${databases} database; up to $${allowance}/mo on Northflank Cloud; always on, no sleeping`);
    assert.strictEqual(row[2], `$${smallest}/mo (0.1 vCPU, 256 MB)`);
  });

  it("gives Google Cloud Storage the free egress its listing states, in the comparison row and the storage card", () => {
    const [egress] = listingFigures("Google Cloud Storage", /(\d+) GB North America egress/);
    assert.strictEqual(rowStarting(tableRows(html[CLOUD], "CDN / Data Transfer"), "GCP", "Cloud Storage")[2], `${egress} GB egress from North America; Cloud CDN not free`);
    const card = cardText(html[STORAGE], "Google Cloud Storage");
    assert.match(card, new RegExp(`${egress} GB egress from North America per month`), `the Cloud Storage card reads: ${card}`);
  });

  it("gives Azure its 100 GB of free outbound transfer and ties the 12 months to Blob Storage alone", () => {
    const azure = rowStarting(tableRows(html[CLOUD], "CDN / Data Transfer"), "Azure", "Blob Storage");
    assert.deepStrictEqual(azure.slice(2, 4), ["Azure CDN not free-tier; first 100 GB/mo outbound free from North America and Europe", "12 months (Blob Storage)"]);
    assert.doesNotMatch(readableText(html[CLOUD]), /15 GB (of )?outbound/);
  });

  it("gives Netlify's Free plan the monthly credits its listing states, and only the bandwidth those credits buy", () => {
    const [credits, perGb] = listingFigures("Netlify", /limit of (\d+) credits per month[\s\S]*?bandwidth \((\d+) credits per GB\)/);
    const gb = Number(credits) / Number(perGb);
    assert.match(readableText(html[FRONTEND_STACK]), new RegExp(`Netlify's Free plan gives ${credits} credits a month for deploys, compute and bandwidth; at ${perGb} credits per GB, that is at most ${gb} GB of bandwidth\\. Accounts created before September 4, 2025 keep the legacy plan's 100 GB and 300 build minutes\\.`));
    assert.match(readableText(html[NEXTJS_STACK]), new RegExp(`Netlify's Free plan includes serverless functions and ${credits} credits a month, which cover at most ${gb} GB of bandwidth at ${perGb} credits per GB\\.`));
    assert.match(readableText(html[DIGITALOCEAN]), new RegExp(`while Cloudflare Pages has unlimited bandwidth and Netlify's Free plan covers up to ${gb} GB a month from its ${credits} credits\\.`));
    const row = rowStarting(tableRows(html[ALTERNATIVES], "Compute / Resources"), "Netlify");
    assert.deepStrictEqual(row.slice(2, 4), [`${credits} credits/mo (deploys, compute, bandwidth, requests)`, `Up to ${gb} GB/mo (${perGb} credits/GB)`]);
  });

  it("gives Netlify 100 GB of bandwidth or 300 build minutes only in a sentence or table row that names them as the legacy plan's", () => {
    let legacy = 0;
    for (const route of NETLIFY_ROUTES) {
      const naming = sentencesAndTableRows(html[route]).filter((sentence) => sentence.includes("Netlify"));
      assert.ok(naming.length > 0, `${route} no longer names Netlify`);
      for (const sentence of naming.filter((s) => /100 GB|300 build min/.test(s))) {
        assert.match(sentence, /legacy/, `${route} reads: ${sentence}`);
        legacy += 1;
      }
    }
    assert.ok(legacy > 0, "no page names Netlify's legacy allowance, so nothing here was checked");
  });
  it("prints every hosting cost note in full with the corrected plan names and rates", () => {
    const rows = tableRows(html[HOSTING], "Key Cost Factor");
    const expected: Record<string, string> = {
      "Railway": "The $5 trial credit is one-time — once the 30 days end the Free plan provides $1 of free credit per month. Hobby's $5 credit resets monthly but is what the $5 subscription buys, not a free allowance, and usage can exceed it. Service egress is billed at $0.05/GB from the first GB on every plan.",
      "Render": "Free web services spin down after 15 minutes without traffic and take about one minute to spin back up. Free Postgres expires after 30 days.",
      "Fly.io": "No free plan for new accounts: a trial of 2 machine hours or 7 days, whichever comes first, then pay-as-you-go. Legacy free allowances only for pre-Oct-2024 accounts on deprecated plans. Volume snapshots billed at $0.08/GB-month (first 10 GB free).",
      "Koyeb": "No free plan for new users since February 2026; Pro is $29 a month plus compute.",
      "Northflank": "2 services, 2 jobs, 1 database; up to $20/mo on Northflank Cloud; always on. Scaling beyond free resources is usage-based.",
      "Cloudflare Workers": "10ms CPU time limit is restrictive for compute-heavy tasks. Daily (not monthly) request quota means bursts get throttled. KV eventual consistency — not suitable for real-time state.",
      "Cloudflare Pages": "500 builds/month can be limiting for active repos with many commits. Functions share the Workers 100K/day limit. Large sites may hit the 25 MB per-file limit.",
      "Netlify": "Every action draws on one credit pool, so builds and traffic compete — and sites pause when the 300 credits run out. A site doing 10 builds a day and 20 GB of traffic burns roughly 4,900 credits.",
      "Deno Deploy": "1M requests/month is generous but production traffic can exceed it.",
      "Val Town": "Free tier vals are public. Private vals require Pro ($25/mo, or $21/mo billed yearly). Limited compute per val execution. Not designed for traditional full-stack apps.",
      "Vercel": "New Pro teams default to Elastic build machines, which scale between 4 and 30 vCPUs and bill $0.0035 per CPU minute. A fixed Turbo machine (30 vCPUs) costs $0.105 a minute and Standard (4 vCPUs) $0.014. Credit-based Pro plan ($20/mo credit pool, changed Jan 2026). Hobby plan is personal use only — commercial use requires Pro. Image Optimization has separate quotas.",
      "Google Cloud Run": "Google Cloud account required with billing enabled. Egress to other regions is expensive. Cloud Build minutes for container builds are separate (2,500 free a month). Cold starts for scaled-to-zero services.",
      "GitHub Pages": "Static sites only — no server-side code. Public repos only on free GitHub (private repos need GitHub Pro $4/mo for Pages). 1 GB storage limit. 100 GB/month bandwidth — sufficient for most projects.",
      "PythonAnywhere": "$5 Hacker tier was eliminated (Jan 2026). Jump from free to $10/month for custom domain and more resources. Limited outbound HTTP on free tier (whitelist only).",
      "Heroku": "No free tier at all. Add-on costs stack up fast (Postgres Essential-0 $5/mo, Key-Value Store Mini $3/mo). Eco dynos sleep and have shared compute. Basic dynos ($7) are the real minimum for production use."
};
    assert.deepStrictEqual(rows.map(([name]) => name).sort(), Object.keys(expected).sort());
    for (const [name, text] of Object.entries(expected)) assert.strictEqual(rowStarting(rows, name)[3], text, name);
    assert.deepStrictEqual(rows.filter((row) => row[3].endsWith("...")).map(([name]) => name), []);
  });

  it("states the hosting allowances on their own cards", () => {
    assert.ok(cardText(html[HOSTING], "Render").includes("Free PostgreSQL (30-day expiry, 1 GB storage)."));
    assert.ok(cardText(html[HOSTING], "Cloudflare Workers").includes("64 MiB Worker size (uncompressed)."));
    const python = cardText(html[HOSTING], "PythonAnywhere");
    assert.ok(python.includes("Built-in Bash console."));
    assert.doesNotMatch(python, /Built-in Bash console, MySQL database/);
  });

  it("prices Val Town and Fly.io in the plan and cost columns they belong to", () => {
    assert.strictEqual(rowStarting(tableRows(html[HOSTING], "Paid From"), "Val Town")[2], "$25/mo (Pro)");
    assert.deepStrictEqual(rowStarting(tableRows(html[HOSTING], "Solo Dev /mo"), "Val Town").slice(1, 3), ["$0–25", "From $200/mo (Business)"]);
    assert.strictEqual(rowStarting(tableRows(html[HOSTING], "Solo Dev /mo"), "Fly.io")[2], "Usage-based");
  });

  it("states Vercel's Elastic default in its visible FAQ, structured answer and gotcha", () => {
    const common = "New Pro teams default to Elastic build machines, which scale between 4 and 30 vCPUs and bill $0.0035 per CPU minute. A fixed Turbo machine (30 vCPUs) costs $0.105 a minute and Standard (4 vCPUs) $0.014.";
    const question = "What are the hidden costs of Vercel?";
    const faq = [...html[HOSTING].matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)]
      .flatMap(([, raw]) => { const value = JSON.parse(raw); return Array.isArray(value) ? value : [value]; })
      .find((entry) => entry["@type"] === "FAQPage");
    const answers = faq?.mainEntity.filter((entry: any) => entry.name === question);
    assert.strictEqual(answers?.length, 1);
    assert.ok(answers[0].acceptedAnswer.text.includes(common));
    const visible = readableText(html[HOSTING]);
    assert.ok(visible.includes(`${question} ${common}`));
    assert.ok(visible.includes("Vercel Builds: Billed per CPU Minute"));
    assert.ok(visible.includes("New Pro teams on Vercel default to Elastic build machines, which scale from 4 to 30 vCPUs and bill $0.0035 per CPU minute. A 5-minute build costs $0.07 on Standard (4 vCPUs) and $0.525 if it scales to Turbo (30 vCPUs). Pick a fixed machine type in project settings if you need predictable build costs."));
  });

  it("withdraws the replaced hosting sentences from raw and readable responses", () => {
    const old = /Free PostgreSQL \(30-day expiry, 256 MB\)|1 MB script size|Private vals require Pro \(\$10\/mo\)|New Pro projects(?: on Vercel)? default to Turbo build machines|Vercel Turbo Builds: 9x Cost Multiplier|Built-in Bash console, MySQL database|Postgres Mini \$5\/mo, Redis Mini \$3\/mo|50ms CPU limit per request/;
    assert.doesNotMatch(html[HOSTING], old);
    assert.doesNotMatch(readableText(html[HOSTING]), old);
  });

});
