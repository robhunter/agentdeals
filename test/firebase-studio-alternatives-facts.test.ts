import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

const PAGE = "/firebase-studio-shutdown";
const IDE_GUIDE = "/ide-code-editors-alternatives";
const SITEMAPS_OF_GUIDES_AND_REPORTS = ["/sitemap-pages.xml", "/sitemap-reports.xml", "/sitemap-misc.xml"];

const NAMED_ALTERNATIVE = /Replit|CodeSandbox|\bv0\b|Lovable|StackBlitz|Gitpod|Codespaces/;
const NEARBY = 250;

const WITHDRAWN: Record<string, RegExp> = {
  "Gitpod's 50 free hours a month": /\b50 hours\/month/gi,
  "CodeSandbox's 400 free VM credits": /400 VM credits/gi,
  "v0's 200 free generations": /200 free generations/gi,
  "Lovable's 5 free generations": /\b5 free generations/gi,
  "Replit's 10 GiB per Repl": /10 GiB per Repl/gi,
  "Replit's retired Ghostwriter": /Ghostwriter/gi,
  "StackBlitz with no quotas": /No server, no quotas/gi,
  "StackBlitz's unlimited free usage": /unlimited free usage/gi,
  "Live Share built into Codespaces": /Live Share built-in/gi,
  "a .gitpod.yml for Gitpod": /\.gitpod\.yml for Gitpod/gi,
};

const TABLE_ROWS: Record<string, string[]> = {
  "GitHub Codespaces": ["120 core hours/month on GitHub Free personal accounts (60 hours on 2 cores)", "15 GB/month", "Live Share (VS Code extension)"],
  "Ona (formerly Gitpod)": ["No free plan; $100 in starting credits (Core from $20/month)", "None free", "Core plan", "Core plan"],
  Replit: ["Not published for Starter", "2 GB (Starter)", "None on Starter (0 seats)", "Replit Agent (daily credits, monthly cap)"],
  CodeSandbox: ["No VM credits on the free plan", "20 GB", "Live sessions (VM Sandboxes only; need VM credits)"],
  StackBlitz: ["Runs in the browser; unlimited public projects", "1 MB uploads per project"],
  "Devin Desktop (formerly Windsurf)": ["Local (light agent quota)", "Local", "N/A", "Agents, unlimited Tab completions and inline edits"],
  Lovable: ["5 build credits/day (up to 30/month)"],
  "v0 (Vercel)": ["$5 of monthly credits, 7 messages/day"],
};

const STATED_ON_THE_PAGE = [
  "Firebase Studio (launched in preview in April 2025, taking over Project IDX) is being wound down",
  "Google recommends migrating to Antigravity or Google AI Studio. Antigravity is a desktop app; Google AI Studio runs in the browser. Google recommends Antigravity, which runs locally, if you mainly used Firebase Studio's Code View.",
  "AI Studio — Full-Stack Apps in the Browser",
  "Google AI Studio builds full-stack web apps from prompts in the browser, with Cloud Firestore and Firebase Authentication built in. Google recommends it if you built your app with Firebase Studio's App Prototyping agent and value rapid, prompt-based prototyping.",
  "Best for: apps built with Firebase Studio's App Prototyping agent, if you value rapid, prompt-based prototyping",
  "Both can keep your existing Firebase App Hosting URL: Antigravity's agent publishes to it, and Google AI Studio reaches it through GitHub sync. AI Studio's own Publish button deploys to Cloud Run at a new URL. Antigravity is a desktop application, while Google AI Studio runs in the browser.",
  "Free terms of 8 alternatives: 6 cloud IDEs (GitHub Codespaces, Ona, Replit, CodeSandbox, StackBlitz, Coder) and 2 local AI editors (Cursor, Devin Desktop). Click provider names for full vendor profiles with the limits we hold.",
  "GitHub Codespaces runs VMs, with 120 core hours a month on a GitHub Free personal account. Ona has no free plan. StackBlitz runs Node.js in the browser. Replit's free plan has daily Agent credits; CodeSandbox's no longer includes VM time. Coder is self-hosted. Cursor and Devin Desktop are local editors.",
  "GitHub Codespaces: cloud VMs with VS Code in the browser. A GitHub Free personal account includes 120 core hours a month (60 hours on a 2-core machine); organization plans include no free quota. Live Share works through the VS Code extension.",
  "Browser-only Node.js projects: StackBlitz: the free Personal plan includes unlimited public projects and up to 1MB of file uploads per project. Localhost backends and CORS-protected APIs need Pro.",
  "Replit's free Starter plan: Replit: the free Starter plan includes 2GB of file storage, 1 published app (taken down after 30 days) and daily Agent credits up to a monthly cap, with Lite builds only. It has no collaboration seats; Core ($20 a month) has 5.",
  "Cursor or Devin Desktop (formerly Windsurf): local editors, not cloud IDEs. Cursor's free Hobby plan includes limited Agent requests. Devin Desktop's free plan includes a light agent quota, limited models, and unlimited Tab completions and inline edits.",
  "Google Antigravity (a local, code-first desktop app) or Google AI Studio (full-stack apps in the browser), Google's two recommended paths.",
  "(for example devcontainer.json for Codespaces)",
  "Key insight: Firebase Studio offered free access to 3 workspaces per user, or 10 with a Google Developer Program profile. Ona has no free plan (it offers $100 in credits to start), and CodeSandbox's free plan no longer includes VM time.",
];

const WITHDRAWN_FROM_THE_PAGE = ["Best for open-source projects", "productivity loss", "retraining cost", "Hidden Costs of Migration", "Team retraining"];

const TITLE = "Firebase Studio Shutdown: Migration Paths & Free IDE Alternatives";
const META_DESCRIPTION = "Firebase Studio has taken no new workspaces since June 22, 2026 and shuts down on March 22, 2027. Compare Google's two recommended paths (Antigravity and Google AI Studio) with the free terms of GitHub Codespaces, Replit, CodeSandbox, StackBlitz and Coder, plus a migration checklist.";
const WITHDRAWN_FROM_THE_HEAD = /Migration Cost Guide|Compare migration costs|Hidden costs of switching/;

const STATED_ON_THE_IDE_GUIDE: Record<string, string> = {
  Replit: "2 GB storage on the free Starter plan; no collaboration seats",
  Windsurf: "Devin Desktop (formerly Windsurf): light agent quota, unlimited Tab completions and inline edits",
};

let server: ChildProcess;
let base = "";
const served = new Map<string, string>();

async function routesIn(sitemap: string): Promise<string[]> {
  const xml = await (await fetch(`${base}${sitemap}`)).text();
  return [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map(([, loc]) => new URL(loc).pathname);
}

function decode(text: string): string {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&#39;|&#x27;|&rsquo;|’/g, "'")
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
  ).replace(/\s+/g, " ").replace(/ ([,.:;])/g, "$1").trim();
}

function rowsOf(html: string): string[][] {
  return [...html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)]
    .map(([, row]) => [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map(([, cell]) => textOf(cell)))
    .filter((cells) => cells.length >= 2);
}

describe("the Firebase Studio shutdown guide states each alternative's free terms as the vendor does", () => {
  before(async () => {
    server = spawn("node", [path.join(REPO, "dist", "serve.js")], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, PORT: "0", BASE_URL: "http://localhost", TZ: "UTC" },
    });
    base = await new Promise<string>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Server startup timeout")), 30000);
      server.stderr!.on("data", (data: Buffer) => {
        const match = data.toString().match(/running on http:\/\/localhost:(\d+)/);
        if (match) {
          clearTimeout(timeout);
          resolve(`http://localhost:${match[1]}`);
        }
      });
      server.on("error", (err) => {
        clearTimeout(timeout);
        reject(err);
      });
    });
    const routes = new Set<string>([PAGE, IDE_GUIDE]);
    for (const sitemap of SITEMAPS_OF_GUIDES_AND_REPORTS) for (const route of await routesIn(sitemap)) routes.add(route);
    for (const route of routes) {
      const response = await fetch(`${base}${route}`);
      if (response.status === 200) served.set(route, await response.text());
    }
  });
  after(() => {
    server?.kill();
  });

  it("reads the guide, the IDE guide and the rest of the guides and reports", () => {
    assert.ok(served.size > 60, `read ${served.size} routes`);
    assert.ok(served.has(PAGE) && served.has(IDE_GUIDE));
  });

  it("states none of the withdrawn terms near an alternative's name on any page, in body, meta or structured data", () => {
    const found = [...served].flatMap(([route, html]) =>
      Object.entries(WITHDRAWN).flatMap(([claim, pattern]) =>
        [...html.matchAll(pattern)]
          .filter((match) => NAMED_ALTERNATIVE.test(html.slice(Math.max(0, match.index! - NEARBY), match.index! + match[0].length + NEARBY)))
          .map((match) => `${route}: ${claim} ("${match[0]}")`),
      ),
    );
    assert.deepStrictEqual(found, []);
  });

  it("states each alternative's free compute, storage, collaboration and AI terms in the table as written", () => {
    const rows = rowsOf(served.get(PAGE)!);
    const wrong = Object.entries(TABLE_ROWS).flatMap(([name, cells]) => {
      const row = rows.find(([first]) => first === name);
      if (!row) return [`no ${name} row`];
      return cells.every((cell, i) => row[i + 1] === cell) ? [] : [`${name}: ${row.slice(1, cells.length + 1).join(" | ")}`];
    });
    assert.deepStrictEqual(wrong, []);
  });

  it("states each corrected sentence as written, and drops the Gitpod pick and the unsourced migration costs", () => {
    const text = textOf(served.get(PAGE)!);
    assert.deepStrictEqual(STATED_ON_THE_PAGE.filter((line) => !text.includes(line)), []);
    assert.deepStrictEqual(WITHDRAWN_FROM_THE_PAGE.filter((line) => text.includes(line)), []);
  });

  it("titles the guide by its migration paths and describes it without Gitpod or the deleted cost section, in meta, Open Graph and structured data", () => {
    const html = served.get(PAGE)!;
    assert.strictEqual(decode(html.match(/<title>([^<]*)<\/title>/)?.[1] ?? ""), `${TITLE} — AgentDeals`);
    const descriptions = [
      ...html.matchAll(/<meta (?:name|property)="(?:og:)?description" content="([^"]*)"/g),
      ...html.matchAll(/"description":"([^"]*)"/g),
    ].map(([, description]) => decode(description));
    assert.ok(descriptions.length >= 3, `found ${descriptions.length} descriptions`);
    assert.deepStrictEqual(descriptions.filter((description) => description !== META_DESCRIPTION && description.startsWith("Firebase Studio has taken")), []);
    assert.ok(descriptions.slice(0, 2).every((description) => description === META_DESCRIPTION));
    assert.deepStrictEqual(html.slice(0, html.indexOf("</head>")).match(WITHDRAWN_FROM_THE_HEAD)?.[0], undefined);
  });

  it("states Replit's and Windsurf's free terms on the IDE guide as the Firebase Studio guide does", () => {
    const rows = rowsOf(served.get(IDE_GUIDE)!);
    const wrong = Object.entries(STATED_ON_THE_IDE_GUIDE).flatMap(([name, terms]) => {
      const row = rows.find(([first]) => first === name);
      return row?.[2] === terms ? [] : [`${name}: ${row?.[2]}`];
    });
    assert.deepStrictEqual(wrong, []);
    assert.ok(!rows.some(([first, , terms]) => first === "Replit" && /10 GiB/.test(terms)));
  });

  it("keeps Coder's self-hosted terms and Bolt.new", () => {
    const html = served.get(PAGE)!;
    assert.ok(rowsOf(html).some(([name, compute]) => name === "Coder" && compute === "Unlimited (self-hosted OSS)"));
    assert.ok(rowsOf(html).some(([name]) => name === "Bolt.new"));
  });
});
