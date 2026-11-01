import { after, before, it } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
let server: ChildProcess;
let base = "";

before(async () => {
  server = spawn("node", [path.join(root, "dist/serve.js")], {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, PORT: "0", BASE_URL: "http://localhost", TZ: "UTC" },
  });
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => { server.kill(); reject(new Error("Server startup timeout")); }, 20000);
    let stderr = "";
    server.stderr!.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
      const match = stderr.match(/running on http:\/\/localhost:(\d+)/);
      if (match) { base = `http://localhost:${match[1]}`; clearTimeout(timeout); resolve(); }
    });
    server.once("error", (error) => { clearTimeout(timeout); reject(error); });
    server.once("exit", (code) => { clearTimeout(timeout); reject(new Error(`Server exited ${code}`)); });
  });
});

after(() => { server?.kill(); });

function text(html: string): string {
  return html.replace(/<[^>]*>/g, " ").replace(/&amp;/g, "&").replace(/&quot;/g, '\"')
    .replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/\s+/g, " ").trim();
}

function row(html: string, name: string): string[] {
  const matches = [...html.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/g)]
    .map(match => [...match[1].matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/g)].map(cell => text(cell[1])))
    .filter(cells => cells[0] === name);
  assert.equal(matches.length, 1, name);
  return matches[0];
}

it("DigitalOcean guide states service prices, backup schedules and spending controls", async () => {
  const response = await fetch(base + "/digitalocean-free-tier-2026");
  assert.equal(response.status, 200);
  const html = await response.text();
  for (const phrase of RETIRED) assert.ok(!html.includes(phrase), phrase);
  for (const [name, limits] of SERVICES) assert.equal(row(html, name)[1], limits, name);
  assert.deepEqual(row(html, "Managed Kubernetes"), [
    "Managed Kubernetes", "$12/mo", "Free control plane; worker nodes are Droplets from $12/mo each", "Per-second billing applies",
  ]);
  assert.deepEqual(row(html, "Managed Database (PostgreSQL)"), [
    "Managed Database (PostgreSQL)", "$15.15/mo", "1 vCPU, 1 GiB RAM, 10 GiB storage", "Not free tier — starts at $15.15",
  ]);
  const cards = [...html.matchAll(/<div class="diff-card"[^>]*>([\s\S]*?)<\/div>/g)];
  for (const [heading, description, cost] of GOTCHAS) {
    const matches = cards.filter(card => text(card[1].match(/<h3>([\s\S]*?)<\/h3>/)![1]).startsWith(heading + " "));
    assert.equal(matches.length, 1, heading);
    assert.equal(text(matches[0][1].match(/<h3>([\s\S]*?)<\/h3>/)![1]), `${heading} ${cost}`);
    assert.equal(text(matches[0][1].match(/<p class="diff-desc">([\s\S]*?)<\/p>/)![1]), description);
  }
  const body = text(html);
  assert.ok(body.includes("$6/mo Droplet (1 GB RAM) + $15.15/mo Managed PostgreSQL + free DNS. Total: $21.15/mo."));
  assert.ok(body.includes("Render ($7/mo + $6/mo for its smallest paid Postgres)"));
  assert.ok(body.includes("Free DOKS control plane + 3× $12/mo Droplet workers. Total: $36/mo. " + KUBERNETES));
  assert.ok(body.includes("Pro tip: " + SPEND_ALERT));
});

it("DigitalOcean comparison distinguishes Vultr's admitted free applicants and IPv4 price", async () => {
  const response = await fetch(base + "/digitalocean-free-tier-2026");
  assert.equal(response.status, 200);
  const html = await response.text();
  const rows = [...html.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/g)]
    .filter(match => /href="\/vendor\/vultr"/.test(match[1]));
  assert.equal(rows.length, 1);
  const cells = [...rows[0][1].matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/g)];
  assert.equal(text(cells[1][1]), "Free Tier Program: a free 1 vCPU, 512 MB instance for applicants Vultr admits; free DNS on any account; paid VPS from $2.50/mo (IPv6 only) or $3.50/mo with IPv4");
  assert.ok(!html.includes("cheapest VPS at $2.50/mo"));
});

const SERVICES = [
  [
    "DNS Management",
    "Free for all accounts, no active Droplet required; how many domains an account can add depends on its resource limits"
  ],
  [
    "Monitoring & Alerting",
    "Built-in metrics and alerts at no extra charge. Uptime checks cost $1.00 a month each, and one check a month is free"
  ]
];

const GOTCHAS = [
  [
    "Managed database is never free",
    "Despite the free credits, no managed database has a free tier. The smallest plans cost $15.00 a month for Valkey (DigitalOcean's Redis-compatible engine; it does not sell managed Redis), $15.15 for PostgreSQL or MySQL, $15.23 for MongoDB, $19.60 for OpenSearch and $148.80 for Kafka. This is the #1 gotcha — AWS, GCP, and Azure all offer always-free database options.",
    "$15/mo minimum"
  ],
  [
    "Backups cost extra",
    "Weekly Droplet backups cost 20% of the Droplet price and daily backups 30%, so backups for a $4/mo Droplet cost $0.80 or $1.20 a month. Usage-based backup plans start at $0.01 per GiB a month. Snapshots are $0.06/GiB/mo. Neither is included in the base price.",
    "20% weekly, 30% daily"
  ]
];

const RETIRED = [
  "Up to ~50 domains",
  "uptime checks, and alerting",
  "$4/mo per worker node",
  "Redis, MongoDB, Kafka",
  "A $4/mo Droplet's backup is $0.80/mo",
  "$7/mo DB",
  "control plane is unique",
  "50%, 80%, and 100%",
  "~20% savings"
];

const KUBERNETES = "Azure's AKS Free tier also has no control-plane fee, while AWS EKS charges $0.10 an hour (about $73 a month) per cluster.";

const SPEND_ALERT = "Set a spend alert immediately: on the Billing page's Spend alerts tab, set a monthly budget (say $5 or $10) and one or more percentage thresholds, and DigitalOcean emails you as spending crosses each. A spend alert is not a spending cap: usage continues past the budget. DigitalOcean sells no reserved Droplets. Its commitment savings plans are contracts, with the discount set in each contract.";
