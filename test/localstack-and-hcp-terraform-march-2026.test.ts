import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertPopulationFloor } from "./population-floor.ts";
import { everyRouteTheSitemapPublishes } from "./sitemap-routes.ts";

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const RETIRED_ROUTES = ["/hcp-terraform-migration", "/terraform-cloud-free-tier-removed"];

let server: ChildProcess | null = null;
let base = "";

function startServer(env: Record<string, string> = {}): Promise<{ proc: ChildProcess; base: string }> {
  return new Promise((resolve, reject) => {
    const proc = spawn("node", [path.join(REPO, "dist", "serve.js")], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, PORT: "0", BASE_URL: "http://localhost", TZ: "UTC", ...env },
    });
    const timeout = setTimeout(() => {
      proc.kill();
      reject(new Error("Server startup timeout"));
    }, 20000);
    proc.stderr!.on("data", (data: Buffer) => {
      const match = data.toString().match(/running on http:\/\/localhost:(\d+)/);
      if (match) {
        clearTimeout(timeout);
        resolve({ proc, base: `http://localhost:${match[1]}` });
      }
    });
    proc.on("error", (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });
}

const ENTITIES: Record<string, string> = {
  "&mdash;": "—", "&ndash;": "–", "&amp;": "&", "&quot;": '"', "&#39;": "'", "&#x27;": "'",
  "&rsquo;": "'", "&lsquo;": "'", "&nbsp;": " ", "&rsaquo;": ">", "&lt;": "<", "&gt;": ">",
  "&middot;": "·", "&rarr;": "→", "&hellip;": "…", "&ldquo;": '"', "&rdquo;": '"',
};

const INLINE_TAG = /<\/?(?:a|abbr|b|code|em|i|small|span|strong|sub|sup)\b[^>]*>/gi;

function decode(text: string): string {
  return text.replace(/&[a-z#0-9]+;/gi, (e) => ENTITIES[e] ?? e);
}

function plain(text: string): string {
  return text.replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/\s+/g, " ").trim();
}

function withoutHeadAndScripts(html: string): string {
  return html.replace(/<head[\s\S]*?<\/head>/gi, " ").replace(/<(script|style|svg)\b[\s\S]*?<\/\1>/gi, " ");
}

function bodyLines(html: string): string[] {
  return decode(withoutHeadAndScripts(html).replace(INLINE_TAG, "").replace(/<[^>]+>/g, "\n"))
    .split("\n")
    .map(plain)
    .filter(Boolean);
}

function bodyText(html: string): string {
  return bodyLines(html).join("\n");
}

function structuredStrings(html: string): string[] {
  const strings: string[] = [];
  for (const m of html.matchAll(/<meta[^>]+content="([^"]*)"/gi)) strings.push(decode(m[1]));
  for (const m of html.matchAll(/<title>([\s\S]*?)<\/title>/gi)) strings.push(decode(m[1]));
  for (const [, raw] of html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/gi)) {
    const walk = (value: unknown): void => {
      if (typeof value === "string") strings.push(value);
      else if (value && typeof value === "object") Object.values(value).forEach(walk);
    };
    try {
      walk(JSON.parse(raw));
    } catch {
      continue;
    }
  }
  return strings.map(plain);
}

function sentencesOf(text: string): string[] {
  return text.split(/\n+|(?<=[.!?])\s+/).map(plain).filter(Boolean);
}

function storedSentences(file: string): string[] {
  const strings: string[] = [];
  const walk = (value: unknown): void => {
    if (typeof value === "string") strings.push(value);
    else if (value && typeof value === "object") Object.values(value).forEach(walk);
  };
  walk(JSON.parse(readFileSync(path.join(REPO, "data", file), "utf8")));
  return [...new Set(strings.flatMap(sentencesOf))].filter((sentence) => sentence.length >= 20);
}

const STORED_SENTENCES = [...storedSentences("deal_changes.json"), ...storedSentences("index.json")];

function quotesAStoredSentence(sentence: string): boolean {
  const unclipped = sentence.replace(/(?:\.{3}|…)$/, "");
  return STORED_SENTENCES.some((stored) => sentence.includes(stored) || stored.includes(unclipped));
}

const WITHDRAWN_WORDING = [
  "shuts down March 23",
  "shuts down on March 23",
  "legacy plan ends March 31",
  "legacy free plan ends",
  "end-of-life on March 31",
  "9 days away",
  "dropped its open-source Community Edition",
  "Community Edition discontinued",
  "Legacy free plan ending March 31",
  "shut down its free Community Edition",
  "killed Community Edition",
  "discontinued its open-source Community Edition",
  "dropped the open-source Community Edition",
  "Complete removal of free/OSS option",
  "forcing all users to paid plans",
  "is ending its legacy free plan",
];

const NAMES_LOCALSTACK = /\bLocalStack\b/i;
const CLOSES_A_COMMUNITY_EDITION =
  /\b(?:shut(?:s|ting)?\s+down|shutdown|kill(?:s|ed)|discontinu(?:e|es|ed|ing)|drop(?:s|ped)|remov(?:e|es|ed)|scrap(?:s|ped)|clos(?:e|es|ed))\b[^.]{0,80}\b(?:Community\s+Edition|CE)\b|\b(?:Community\s+Edition|CE)\b[^.]{0,40}\b(?:shut(?:s|ting)?\s+down|shutdown|discontinued|killed|removed|is\s+gone)\b/i;
const NAMES_HCP_TERRAFORM = /\b(?:HCP\s+Terraform|Terraform\s+Cloud|HashiCorp)\b/i;
const NAMES_THE_LEGACY_PLAN = /\blegacy\b/i;
const SPEAKS_OF_ITS_END_AS_COMING =
  /\b(?:ends|ending|will\s+end|will\s+reach|reaches|sunsetting|days\s+away|before\s+the\s+March\s+31\s+deadline|March\s+31\s+deadline)\b/i;

function withdrawnWordingIn(sentence: string): string | null {
  const lower = sentence.toLowerCase();
  const exact = WITHDRAWN_WORDING.find((wording) => lower.includes(wording.toLowerCase()));
  if (exact) return exact;
  if (NAMES_LOCALSTACK.test(sentence) && CLOSES_A_COMMUNITY_EDITION.test(sentence)) return "LocalStack's Community Edition described as closed";
  if (NAMES_HCP_TERRAFORM.test(sentence) && NAMES_THE_LEGACY_PLAN.test(sentence) && SPEAKS_OF_ITS_END_AS_COMING.test(sentence)) {
    return "HCP Terraform's legacy plan described as ending";
  }
  return null;
}

const REWORDED_CONTROLS = [
  "LocalStack's Community Edition shut down on March 23, 2026.",
  "LocalStack has discontinued the free Community Edition.",
  "In March, LocalStack scrapped its Community Edition for good.",
  "LocalStack CE is gone: the Community Edition was removed in March.",
  "HCP Terraform's legacy free tier is ending on March 31.",
  "HashiCorp will end the legacy HCP Terraform plan on March 31, 2026.",
  "Terraform Cloud's legacy plan reaches end of life March 31.",
];

const REPLACEMENTS: Record<string, string[]> = {
  "/localstack-alternatives": [
    "Starting in March 2026, LocalStack required an auth token for its latest image; the Hobby plan is for non-commercial use.",
    "In March 2026, LocalStack merged its Community and Pro images, requiring an auth token to pull the latest image. The Community image source code is on GitHub but is no longer regularly updated. The free Hobby plan is for non-commercial use and includes 30+ emulated services.",
  ],
  "/terraform-alternatives": [
    "HCP Terraform's legacy free plan ended March 31, 2026 and the free tier now caps managed resources at 500.",
    "HCP Terraform's legacy free plan reached end of life on March 31, 2026. Organizations were transitioned to an enhanced free tier that caps managed resources at 500.",
    "How each IaC platform's free tier compares. HCP Terraform's free tier caps managed resources at 500.",
  ],
  "/free-tier-tracker": [
    "Community image inactive, auth token required",
    "LocalStack merged its Community and Pro images in March 2026 and pulling localstack/localstack:latest requires an auth token. The Community image's source code stays on GitHub, but the repository is marked inactive. The free Hobby plan is for non-commercial use.",
    "Legacy free plan ended March 31",
    "HCP Terraform's legacy free plan ended March 31, 2026. Users were transitioned to a free tier with a 500 managed resource cap, SSO, and policy enforcement.",
    "LocalStack ended Community Edition support, and the repository is now inactive.",
  ],
  "/q1-2026-developer-pricing-report": [
    "LocalStack Community Edition Support Ended",
    "Restriction · High Impact",
    "LocalStack ended support for its Community edition on March 23, 2026. The latest image now requires an account and auth token. The Hobby plan remains free for non-commercial use with 30+ services and CI runs. Commercial use requires a paid plan.",
  ],
  "/testing-free-tier-comparison-2026": [
    "Playwright, Selenium, k6, Locust, Gatling, Artillery, and Testcontainers are all free with no usage limits when self-hosted.",
  ],
  "/free-tier-risk": [
    "On March 23, 2026, LocalStack ended Community Edition support. The free Hobby plan is for non-commercial use and requires an account. Alternatives include Moto, aws-sdk-mock, and Testcontainers.",
  ],
};

const BLURBS = [
  "In March 2026, LocalStack merged Community and Pro images, requiring an auth token for the latest image — compare 9 free open-source AWS emulators",
  "HCP Terraform legacy free plan ended March 31, 2026; free tier now caps managed resources at 500 — free IaC alternatives compared",
];

const MOST_READ_GUIDES = [
  "/hetzner-pricing-2026",
  "/gemini-api-pricing-2026",
  "/tenor-alternatives",
  "/google-developer-program-2026",
  "/shutdowns",
  "/free-llm-apis",
];

const GUIDE_HUBS = ["/guides", "/alternatives"];

const LINKS_TO_A_RETIRED_ROUTE = /href="(?:https?:\/\/[^"/]+)?\/(?:hcp-terraform-migration|terraform-cloud-free-tier-removed)(?:["#?/])/;

const TERRAGRUNT_SCALE_ROW = /<tr>\s*<td[^>]*>\s*<a href="\/vendor\/terragrunt-scale"[^>]*>Terragrunt Scale<\/a><\/td>([\s\S]*?)<\/tr>/;

type Finding = { route: string; sentence: string; wording: string };

describe("LocalStack's and HCP Terraform's March 2026 changes are told as past and as they happened", () => {
  let routes: string[] = [];
  const served = new Map<string, string>();
  const withdrawn: Finding[] = [];
  const linkingToARetiredRoute: string[] = [];

  before(async () => {
    ({ proc: server, base } = await startServer());
    routes = await everyRouteTheSitemapPublishes(base);
    const queue = [...routes];
    const worker = async () => {
      for (let route = queue.pop(); route !== undefined; route = queue.pop()) {
        const response = await fetch(`${base}${route}`);
        if (!response.ok) continue;
        const html = await response.text();
        served.set(route, html);
        for (const sentence of [...bodyLines(html), ...structuredStrings(html)].flatMap(sentencesOf)) {
          const wording = withdrawnWordingIn(sentence);
          if (wording && !quotesAStoredSentence(sentence)) withdrawn.push({ route, sentence, wording });
        }
        if (LINKS_TO_A_RETIRED_ROUTE.test(html)) {
          linkingToARetiredRoute.push(route);
        }
      }
    };
    await Promise.all(Array.from({ length: 12 }, worker));
  });

  after(() => {
    if (server) server.kill();
    server = null;
  });

  it("reads every route the sitemap publishes", () => {
    assertPopulationFloor(routes.length, 1000, "routes in the sitemap");
    assert.strictEqual(served.size, routes.length);
  });

  it("finds the withdrawn wording, and rewordings of it, in a sentence that carries them", () => {
    for (const control of REWORDED_CONTROLS) assert.ok(withdrawnWordingIn(control), control);
    for (const wording of WITHDRAWN_WORDING) assert.ok(withdrawnWordingIn(`We wrote that it ${wording} in 2026.`), wording);
  });

  it("does not take a replacement for the wording it withdrew", () => {
    for (const sentence of [...Object.values(REPLACEMENTS).flat(), ...BLURBS].flatMap(sentencesOf)) {
      assert.strictEqual(withdrawnWordingIn(sentence), null, sentence);
    }
  });

  it("serves none of the withdrawn wording on any route, in body, meta or JSON-LD, outside text quoting a stored record or listing", () => {
    assert.deepStrictEqual(withdrawn.map(({ route, wording, sentence }) => `${route} [${wording}] ${sentence}`), []);
  });

  it("serves each replacement on its page", () => {
    for (const [route, replacements] of Object.entries(REPLACEMENTS)) {
      const html = served.get(route);
      assert.ok(html, `${route} was not served`);
      const text = [bodyText(html), ...structuredStrings(html)].join("\n");
      for (const replacement of replacements) assert.ok(text.includes(replacement), `${route} lacks: ${replacement}`);
    }
  });

  it("lists both guides with their new blurbs on the most-read guides, and in the guide hubs' JSON-LD", () => {
    for (const route of MOST_READ_GUIDES) {
      const html = served.get(route);
      assert.ok(html, `${route} was not served`);
      for (const blurb of BLURBS) assert.ok(bodyText(html).includes(blurb), `${route} lacks: ${blurb}`);
    }
    for (const hub of GUIDE_HUBS) {
      const html = served.get(hub);
      assert.ok(html, `${hub} was not served`);
      for (const blurb of BLURBS) assert.ok(structuredStrings(html).some((value) => value.includes(blurb)), `${hub} JSON-LD lacks: ${blurb}`);
    }
  });

  it("gives Terragrunt Scale's row unlimited resources and runs", () => {
    const row = served.get("/terraform-alternatives")!.match(TERRAGRUNT_SCALE_ROW);
    assert.ok(row, "/terraform-alternatives has no Terragrunt Scale row");
    const cells = [...row[1].matchAll(/<td>([^<]*)<\/td>/g)].map((cell) => cell[1]);
    assert.deepStrictEqual(cells.slice(1, 3), ["Unlimited (up to 25 infrastructure units)", "Unlimited"]);
    assert.ok(!row[1].includes("500+"));
  });

  it("publishes neither retired guide in a sitemap and links to neither from a served page", () => {
    for (const retired of RETIRED_ROUTES) assert.ok(!routes.includes(retired), `${retired} is in a sitemap`);
    assert.deepStrictEqual(linkingToARetiredRoute, []);
  });
});

describe("the LocalStack card on /testing-free-tier-comparison-2026, once LocalStack's 2026-03-23 record reads as a restriction", () => {
  const CARD = "Free tier: Hobby plan for non-commercial use, with 30+ emulated AWS services, 1 sandbox, and CI runs. Requires an account and auth token. Commercial use requires a paid plan.";
  let scratch = "";
  let restricted: ChildProcess | null = null;
  let restrictedBase = "";

  before(async () => {
    scratch = mkdtempSync(path.join(tmpdir(), "localstack-restriction-"));
    const log = JSON.parse(readFileSync(path.join(REPO, "data", "deal_changes.json"), "utf8"));
    const record = log.changes.find((change: { vendor: string; date: string }) => change.vendor === "LocalStack" && change.date === "2026-03-23");
    assert.ok(record, "the change log holds no LocalStack record of 2026-03-23");
    record.change_type = "restriction";
    writeFileSync(path.join(scratch, "deal_changes.json"), JSON.stringify(log));
    ({ proc: restricted, base: restrictedBase } = await startServer({ AGENTDEALS_CHANGES_PATH: path.join(scratch, "deal_changes.json") }));
  });

  after(() => {
    if (restricted) restricted.kill();
    restricted = null;
    rmSync(scratch, { recursive: true, force: true });
  });

  it("states the Hobby plan, the account and token it needs, and the paid plan for commercial use", async () => {
    const html = await (await fetch(`${restrictedBase}/testing-free-tier-comparison-2026`)).text();
    assert.ok(bodyText(html).includes(CARD), "the LocalStack card does not state the Hobby plan");
    assert.ok(!bodyText(html).includes("Our own pricing change record, on 2026-03-23"));
  });
});
