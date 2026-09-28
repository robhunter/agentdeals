import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const { FIGURE_SOURCE_CLASS } = await import("../dist/source-citation.js");
const { SOURCE_MARKER_IN_A_CELL } = await import("../dist/page-reviews.js");
const SITEMAPS_OF_GUIDES_AND_REPORTS = ["/sitemap-pages.xml", "/sitemap-reports.xml", "/sitemap-misc.xml"];

const WITHDRAWN: Record<string, RegExp> = {
  "Firebase Auth free up to 50K MAUs": /Firebase Auth \(50K MAUs\)|Firebase Auth: 50K MAU free|Completely free auth up to 50K MAU/i,
  "Cognito free up to 50K MAUs for every account": /Cognito \(50K MAUs\)|50K MAUs \(Monthly Active Users\)/i,
  "Azure's identity tier ranked the most generous": /most generous managed identity/i,
  "Firebase Auth needing the entire SDK": /importing the entire SDK/i,
  "Firebase Auth billed on Blaze after 50K MAUs": /Blaze: \$0\.0055\/MAU after 50K/,
  "Supabase and Firebase auth called equivalent": /Equivalent\. Both include email, OAuth, social login/,
};

const STATED: Record<string, string[]> = {
  "/azure-free-tier-2026": [
    "Azure Active Directory / Entra ID (50K objects) + App Service for SSO. Includes SAML, OIDC, and MFA. For comparison, Amazon Cognito's free tier is 10,000 MAUs (50,000 for user pools created by November 22, 2024). Firebase Authentication includes email, social and anonymous sign-in at no cost; SMS needs the pay-as-you-go Blaze plan.",
  ],
  "/supabase-vs-firebase": [
    "No cost; SMS on Blaze only. 50K MAU with Identity Platform",
    "Both include email, OAuth and social login. Supabase Free: 50K MAU. Firebase: no user limit, SMS on Blaze only; Identity Platform: 50K MAU free.",
  ],
  "/free-saas-stack": [
    "Why not Firebase Auth: email and social sign-in are free, but SMS needs the pay-as-you-go Blaze plan, and MFA, SAML and multi-tenancy need the Identity Platform upgrade.",
  ],
  "/stacks/side-project": [
    "Email, social and anonymous sign-in at no cost; SMS needs the pay-as-you-go Blaze plan. The modular SDK lets you use just the auth.",
  ],
};

const ROWS: [string, string, string[]][] = [
  ["/aws-free-tier-2026", "Amazon Cognito", ["10,000 MAUs a month (Lite or Essentials tier, direct or social sign-in); 50 MAUs for SAML/OIDC. User pools created by November 22, 2024 keep 50,000 on Lite."]],
  ["/auth-comparison-2026", "Firebase Auth", ["No cost; SMS on Blaze only", "$0.0055 (Identity Platform, 50K-100K MAU)"]],
  ["/auth-comparison-2026", "AWS Cognito", ["10K MAU (50K for pools created by Nov 22, 2024)", "$0.0055"]],
];

const BAAS_ROWS: [string, string][] = [
  ["Firebase Auth", "No cost; SMS on Blaze only"],
  ["AWS Cognito", "10,000"],
];

const ESTIMATOR_ROUTES = ["/estimate", "/budget-builder"];
const FIREBASE_AUTH_ESTIMATE = {
  free: "No cost; SMS on Blaze only",
  notes: "SMS billed per message. Identity Platform: 50K MAU free, then $0.0025-$0.0055/MAU.",
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
    .replace(/&#39;|&#x27;|&rsquo;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&mdash;/g, "—")
    .replace(/&ndash;/g, "–")
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

const CITATION_ANCHOR = new RegExp(`<a [^>]*class="${FIGURE_SOURCE_CLASS}"[^>]*>[\\s\\S]*?<\\/a>`, "g");

function rowsOf(html: string): string[][] {
  return [...html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)]
    .map(([, row]) => [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map(([, cell]) =>
      textOf(cell.replace(CITATION_ANCHOR, "").replace(new RegExp(SOURCE_MARKER_IN_A_CELL.source, "g"), ""))))
    .filter((cells) => cells.length >= 2);
}

function tableAfter(html: string, anchor: string): string {
  const section = html.slice(html.indexOf(anchor));
  return section.slice(0, section.indexOf("</table>"));
}

function embeddedFirebaseAuth(html: string): { free: string; notes: string } | null {
  const json = html.match(/\{[^{}]*"name":"Firebase Auth"[^{}]*\}/)?.[0];
  return json ? JSON.parse(json) : null;
}

function rowNamed(rows: string[][], name: string): string[] | undefined {
  return rows.find(([first]) => first === name || first.startsWith(`${name} `));
}

describe("Firebase Auth and Amazon Cognito free tiers are stated as Google and AWS state them", () => {
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
    const routes = new Set<string>([...Object.keys(STATED), ...ROWS.map(([route]) => route), ...ESTIMATOR_ROUTES]);
    for (const sitemap of SITEMAPS_OF_GUIDES_AND_REPORTS) for (const route of await routesIn(sitemap)) routes.add(route);
    for (const route of routes) {
      const response = await fetch(`${base}${route}`);
      if (response.status === 200) served.set(route, await response.text());
    }
  });
  after(() => {
    server?.kill();
  });

  it("reads every page that carried the claims, and the guides and reports the census covers", () => {
    assert.ok(served.size > 60, `read ${served.size} routes`);
    const missing = [...Object.keys(STATED), ...ROWS.map(([route]) => route), ...ESTIMATOR_ROUTES].filter((route) => !served.has(route));
    assert.deepStrictEqual(missing, []);
  });

  it("serves none of the withdrawn claims on those pages, in body, meta, structured data or embedded data", () => {
    const found = [...served].flatMap(([route, html]) =>
      Object.entries(WITHDRAWN)
        .filter(([, pattern]) => pattern.test(html))
        .map(([claim, pattern]) => `${route}: ${claim} ("${html.match(pattern)![0]}")`)
    );
    assert.deepStrictEqual(found, []);
  });

  it("states each corrected sentence as written", () => {
    const missing = Object.entries(STATED).flatMap(([route, lines]) => {
      const text = textOf(served.get(route)!);
      return lines.filter((line) => !text.includes(line)).map((line) => `${route}: ${line}`);
    });
    assert.deepStrictEqual(missing, []);
  });

  it("states Firebase Auth's and Cognito's free limits in each table row that prices them", () => {
    const wrong = ROWS.flatMap(([route, name, cells]) => {
      const row = rowNamed(rowsOf(served.get(route)!), name);
      if (!row) return [`${route}: no ${name} row`];
      return row.slice(1, 1 + cells.length).join(" | ") === cells.join(" | ") ? [] : [`${route}: ${name}: ${row.slice(1, 1 + cells.length).join(" | ")}`];
    });
    assert.deepStrictEqual(wrong, []);
  });

  it("states both free limits in the BaaS auth table", () => {
    const rows = rowsOf(tableAfter(served.get("/auth-comparison-2026")!, 'id="baas-auth"'));
    const wrong = BAAS_ROWS.flatMap(([name, freeMaus]) => {
      const row = rowNamed(rows, name);
      if (!row) return [`no ${name} row`];
      return row[1] === freeMaus ? [] : [`${name}: ${row[1]}`];
    });
    assert.deepStrictEqual(wrong, []);
  });

  it("gives the cost estimators Firebase Auth's free terms and Identity Platform's prices", () => {
    const wrong = ESTIMATOR_ROUTES.flatMap((route) => {
      const firebase = embeddedFirebaseAuth(served.get(route)!);
      if (!firebase) return [`${route}: no Firebase Auth entry`];
      return firebase.free === FIREBASE_AUTH_ESTIMATE.free && firebase.notes === FIREBASE_AUTH_ESTIMATE.notes
        ? []
        : [`${route}: ${firebase.free} | ${firebase.notes}`];
    });
    assert.deepStrictEqual(wrong, []);
  });
});
