import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";

const repo = fileURLToPath(new URL("..", import.meta.url));
const route = "/monitoring-comparison-2026";
let child: ChildProcess;
let html = "";
const pages = new Map<string, string>();
const plain = (s: string) => s.replace(/<a\b[^>]*class="[^"]*(?:figure-source|record-source|unsourced-tag)[^"]*"[^>]*>[\s\S]*?<\/a>/g, "")
  .replace(/<span\b[^>]*class="[^"]*(?:unsourced-tag|compiled-figure)[^"]*"[^>]*>[\s\S]*?<\/span>/g, "")
  .replace(/<[^>]+>/g, " ").replace(/&rsquo;|&#39;|&#x27;/g, "'")
  .replace(/&ndash;/g, "–").replace(/&mdash;/g, "—").replace(/&rarr;/g, "→")
  .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&").replace(/&nbsp;/g, " ")
  .replace(/\s+/g, " ").trim();

function table(id: string): string[][] {
  const start = html.indexOf(`id="${id}"`);
  assert.ok(start >= 0, id);
  const source = html.slice(start).match(/<table\b[^>]*>([\s\S]*?)<\/table>/)?.[1];
  assert.ok(source, id);
  return [...source.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/g)]
    .map(r => [...r[1].matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/g)].map((c, index) => plain(index === 0 ? c[1].replace(/<a\b[^>]*href="[^"]*#changes"[^>]*>[\s\S]*?<\/a>/g, "").replace(/<span\b[^>]*>[\s\S]*?<\/span>/g, "") : c[1])))
    .filter(r => r.length > 1);
}

function row(id: string, name: string): string[] {
  const rows = table(id).filter(r => r[0] === name);
  assert.equal(rows.length, 1, `${id}: ${name}`);
  return rows[0];
}

function section(id: string, next: string): string {
  const start = html.indexOf(`id="${id}"`), end = html.indexOf(`id="${next}"`, start + 1);
  assert.ok(start >= 0 && end > start);
  return plain(html.slice(start, end));
}

function paragraph(lead: string): string {
  const paragraphs = [...html.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/g)].map(m => plain(m[1]));
  const found = paragraphs.filter(p => p.startsWith(lead));
  assert.equal(found.length, 1, lead);
  return found[0];
}

describe("monitoring free plans, alert channels and list prices", () => {
  before(async () => {
    let stderr = "";
    child = spawn(process.execPath, ["dist/serve.js"], { cwd: repo, env: { ...process.env, PORT: "0", BASE_URL: "http://localhost", TZ: "UTC" }, stdio: ["ignore", "pipe", "pipe"] });
    child.stdout!.resume();
    const port = await new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error(stderr)); }, 60000);
      child.stderr!.on("data", chunk => {
        stderr += chunk;
        const match = stderr.match(/running on http:\/\/localhost:(\d+)/);
        if (match) { clearTimeout(timer); resolve(Number(match[1])); }
      });
      child.once("error", error => { clearTimeout(timer); reject(error); });
      child.once("exit", code => { clearTimeout(timer); reject(new Error(`server exited ${code}: ${stderr}`)); });
    });
    const response = await fetch(`http://localhost:${port}${route}`, { redirect: "error" });
    assert.equal(response.status, 200);
    html = await response.text();
    pages.set(route, html);
    for (const path of ["/state-of-free-tiers", "/datadog-vs-sentry", "/free-nextjs-stack"]) {
      const other = await fetch(`http://localhost:${port}${path}`, { redirect: "error" });
      assert.equal(other.status, 200);
      pages.set(path, await other.text());
    }
  });
  after(() => child?.kill("SIGKILL"));


  it("retains the complete free-plan provider roster without the paid Sematext plan", () => {
    assert.deepEqual(table("main-comparison").map(r => r[0]), ["Datadog", "Grafana Cloud", "New Relic", "Axiom", "Middleware.io", "BetterStack", "Sentry", "AppSignal", "UptimeRobot", "StatusCake", "PagerDuty", "incident.io", "Healthchecks.io", "Cronitor", "Prometheus", "Jaeger", "Netdata", "Elastic (ELK)", "SigNoz", "HyperDX", "Checkly", "Rollbar", "Bugsnag"]);
  });

  it("keeps the control allowances and Pingbreak webhook channel", () => {
    assert.equal(row("main-comparison", "BetterStack")[1], "3 GB logs");
    assert.equal(row("main-comparison", "Sentry")[1], "5K errors/mo + 50 replays");
    assert.deepEqual(row("uptime-monitoring", "Pingbreak").slice(1, 4), ["3", "5 min", "Email, webhook"]);
    assert.deepEqual(row("uptime-monitoring", "UptimeRobot").slice(1, 3), ["50", "5 min"]);
  });

  const cells: [string, string, number, string][] = [
    ["main-comparison", "Axiom", 5, "1 user"],
    ["main-comparison", "Middleware.io", 1, "100GB/mo"],
    ["main-comparison", "Middleware.io", 2, "14 days"],
    ["main-comparison", "Middleware.io", 3, "14 days"],
    ["main-comparison", "Middleware.io", 4, "N/A (volume-based)"],
    ["main-comparison", "AppSignal", 1, "30K requests"],
    ["main-comparison", "AppSignal", 2, "5 days"],
    ["main-comparison", "AppSignal", 3, "5 days"],
    ["main-comparison", "Checkly", 4, "10 uptime monitors, 1,000 browser + 10,000 API checks"],
    ["main-comparison", "Rollbar", 5, "Unlimited"],
    ["uptime-monitoring", "Hyperping", 1, "20"],
    ["uptime-monitoring", "Hyperping", 2, "5 min"],
    ["uptime-monitoring", "Pulsetic", 2, "5 min"],
    ["uptime-monitoring", "Checkly", 1, "10 uptime monitors"],
    ["uptime-monitoring", "Checkly", 2, "2 min"],
    ["uptime-monitoring", "OnlineOrNot", 1, "3"],
    ["uptime-monitoring", "UptimeRobot", 3, "Email, Google Chat, Discord, Pushover, Pushbullet, Splunk"],
    ["uptime-monitoring", "UptimeRobot", 5, "&#10007;"],
    ["cron-monitoring", "Cronitor", 3, "Email, Slack, webhooks"],
  ];
  for (const [id, provider, column, expected] of cells) {
    it(`${provider} states ${expected} in ${id} column ${column}`, () => {
      assert.equal(row(id, provider)[column], expected);
    });
  }

  it("shows the vendors' list prices and billing terms in the replacement cost table", () => {
    assert.ok(html.includes("List Prices Beyond the Free Tier"));
    const start = html.indexOf('id="cost-trap"');
    const costTable = html.slice(start).match(/<table class="growth-table">([\s\S]*?)<\/table>/)?.[1];
    assert.ok(costTable);
    const rows = [...costTable.matchAll(/<tr>([\s\S]*?)<\/tr>/g)].map(r => [...r[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map(c => plain(c[1]))).filter(r => r.length);
    assert.deepEqual(rows, [
      ["Datadog", "Infrastructure Pro $15/host/mo billed annually ($18 on-demand); Enterprise $23 ($27 on-demand); APM $31/host/mo with Infrastructure ($36 on-demand); logs $0.10/GB ingested, $1.70 per million events indexed (15-day retention)"],
      ["Grafana Cloud", "Pro $19/mo platform fee; metrics $6.50 per 1k series above 10k; Application Observability $0.025/host hour ($18/host) above 2,232 host hours"],
      ["New Relic", "100 GB/mo of data free, then $0.40/GB; full platform users: 1 free, Standard $10 for the first and $99 for each additional (up to 5), Pro $349/user/mo billed annually"],
      ["Better Stack", "Responder licence $29/mo; logs and traces 3 GB/mo included, then priced per GB ingested"],
      ["Self-Hosted (Prometheus/SigNoz)", "Software free; you pay for servers and storage"],
    ]);
  });

  const statements: [string, string][] = [
  [
    "/monitoring-comparison-2026",
    "500 GB/month data loading, 10 GB-hours query compute, 25 GB storage, 30-day retention, 1 user, 3 datasets, 3 monitors, Email and Discord notifiers."
  ],
  [
    "/monitoring-comparison-2026",
    "30K requests a month, 1 GB logging, 5-day retention."
  ],
  [
    "/monitoring-comparison-2026",
    "Up to 100 GB of data a month, 1,000 RUM sessions, 20,000 synthetic checks, 10 browser test runs, unlimited users, 14-day retention."
  ],
  [
    "/monitoring-comparison-2026",
    "The 100 GB data limit makes it suitable for small projects."
  ],
  [
    "/monitoring-comparison-2026",
    "10 uptime monitors, maximum frequency 2 minutes, 6 locations, 1,000 Browser/Playwright checks and 10,000 API checks."
  ],
  [
    "/monitoring-comparison-2026",
    "Hyperping's free plan gives 20 monitors with 5-minute checks."
  ],
  [
    "/monitoring-comparison-2026",
    "Axiom's 500GB"
  ],
  [
    "/monitoring-comparison-2026",
    "Free plan includes email alerts plus Google Chat, Discord, Pushover, Pushbullet and Splunk. Webhooks, Slack, Mattermost, Telegram, MS Teams, Zapier, PagerDuty and SSL monitoring require a paid plan."
  ],
  [
    "/monitoring-comparison-2026",
    "UptimeRobot's free plan includes Google Chat, Discord, Pushover, Pushbullet and Splunk. Webhooks, Slack, Mattermost, Telegram, MS Teams, Zapier and PagerDuty require paid plans. Grafana Cloud Free accounts opened from April 20, 2026 can only send email alerts to users within the Grafana instance. Webhooks remain functional."
  ],
  [
    "/monitoring-comparison-2026",
    "3 users, at most 1,000 dashboards and 1,000 folders per stack, alerting included. Grafana Cloud free accounts opened from April 20, 2026 can only send email alerts to users within the Grafana instance."
  ],
  [
    "/state-of-free-tiers",
    "At 100 hosts and list price, Datadog Infrastructure Pro costs $1,500 a month billed annually ($1,800 on-demand). With APM, it costs $4,600 a month billed annually ($5,400 on-demand). Grafana Cloud Application Observability for 100 hosts costs about $1,800 a month plus a $19 platform fee. Logs are not included in either."
  ],
  [
    "/monitoring-comparison-2026",
    "At list price, 100 hosts with APM cost $4,600/mo (annual billing) on Datadog. Grafana Cloud Application Observability for 100 hosts is ~$1,800/mo plus $19 platform fee. Logs excluded."
  ],
  [
    "/monitoring-comparison-2026",
    "The table lists vendor list prices. Prices were read from vendor pages on 2026-11-02."
  ],
  [
    "/monitoring-comparison-2026",
    "Datadog Infrastructure Pro is $15 per host per month, Enterprise $23. APM is $31 per host per month with Infrastructure Monitoring, billed annually."
  ],
  [
    "/monitoring-comparison-2026",
    "Grafana Cloud bills Application Observability at $18 per host per month above 2,232 free host hours. New Relic bills $0.40 per GB of data ingested beyond 100 GB a month. Better Stack bills logs and traces per GB ingested."
  ],
  [
    "/monitoring-comparison-2026",
    "Datadog includes 100 custom metrics per host on Pro, 200 on Enterprise. Usage beyond that is billed at an unpublished rate."
  ],
  [
    "/monitoring-comparison-2026",
    "Datadog ($15-23/host/mo for infrastructure, billed annually) and Sematext"
  ],
  [
    "/monitoring-comparison-2026",
    "scales your Datadog bill to $3,000/mo at list price (Infrastructure Pro, billed annually)"
  ],
  [
    "/monitoring-comparison-2026",
    "Datadog includes 100 custom metrics per host on Pro, 200 on Enterprise. Usage beyond that is billed at an unpublished rate."
  ],
  [
    "/datadog-vs-sentry",
    "At 100 hosts, Datadog Infrastructure Pro costs $1,500 a month, and with APM $4,600 a month, billed annually."
  ],
  [
    "/free-nextjs-stack",
    "At 100 hosts with APM, Datadog costs $4,600 a month at list price, billed annually."
  ],
  [
    "/monitoring-comparison-2026",
    "<strong>Sematext has no free plan.</strong> A 14-day free trial requires no credit card. Logs Basic starts at $5/month for 500MB/day and 7-day retention. Infrastructure Basic starts at $2.8/host/month with 1-day retention. Logs and infrastructure are in one platform."
  ],
  [
    "/monitoring-comparison-2026",
    "5K occurrences + 1K sessions/month, unlimited users and projects, 30-day retention."
  ],
  [
    "/monitoring-comparison-2026",
    "Sentry&rsquo;s free plan also allows 5K errors/month and 1 user."
  ],
  [
    "/monitoring-comparison-2026",
    "SigNoz Community is free to self-host. Code outside of ee/ and cmd/enterprise/ is MIT licensed. Code in those directories is licensed under ee/LICENSE."
  ],
  [
    "/monitoring-comparison-2026",
    "SigNoz Teams costs $49/month, including $49 of usage."
  ]
];
  for (const [path, expected] of statements) {
    it(`${path} states ${plain(expected)}`, () => {
      assert.ok(plain(pages.get(path)!).includes(plain(expected)), expected);
    });
  }

  it("does not publish the superseded monitoring claims in any response markup", () => {
    for (const retired of ["100K requests", "100,000 requests/month", "1 host, 1-day", "single host limit", "5 browser checks", "5 browser + 10 API", "fastest simple check interval", "500GB with unlimited users", "Email + webhook alerts", "supports webhooks on free", "all notification channels on free tier", "unlimited dashboards", "~$5,500/mo", "$300-800/mo", "Annual Cost by Scale", "$15-31/host/mo", "$330K+/year", "$0.05/custom metric", "$0.05/metric/month", "$2,500/mo", "$6,000+/mo", "Apache 2.0 or AGPL", "Cloud tier starts at $199/mo", "<td>Email, Slack, PagerDuty</td>", "1-user limit", "5 hosts for infrastructure monitoring"]) {
      assert.ok(!html.toLowerCase().includes(retired.toLowerCase()), retired);
    }
    const axiom = html.match(/<h3>Axiom[\s\S]*?<\/h3>\s*<div class="diff-desc">([\s\S]*?)<\/div>/)?.[1];
    assert.ok(axiom);
    assert.ok(!axiom.includes("Unlimited users."));
    assert.ok(!pages.get("/state-of-free-tiers")!.includes("~$5,500/mo"));
    assert.ok(!pages.get("/state-of-free-tiers")!.includes("~$300&ndash;$800/mo"));
    for (const path of ["/datadog-vs-sentry", "/free-nextjs-stack"]) assert.ok(!pages.get(path)!.includes("$5,500"), path);
  });
});
