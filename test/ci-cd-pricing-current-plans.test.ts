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
  "&nbsp;": " ", "&lt;": "<", "&gt;": ">", "&rarr;": "→", "&rsquo;": "’",
};

function readableText(html: string): string {
  return html
    .replace(/<(script|style|svg)\b[\s\S]*?<\/\1>/gi, " ")
    .replace(/<\/?(?:strong|em|b|i|a|span|code)\b[^>]*>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&[a-z#0-9]+;/gi, (e) => ENTITIES[e] ?? e)
    .replace(/\s+/g, " ")
    .trim();
}

function cicdListing(vendor: string): Record<string, any> {
  const listings = offers.filter((o) => o.vendor === vendor && o.category === "CI/CD");
  assert.strictEqual(listings.length, 1, `expected one CI/CD listing for ${vendor}, found ${listings.length}`);
  return listings[0];
}

function listedFigure(vendor: string, pattern: RegExp, what: string): string {
  const description = String(cicdListing(vendor).description);
  const match = description.match(pattern);
  assert.ok(match, `the ${vendor} listing no longer states ${what}: ${description}`);
  return match![1];
}

function buddyFreePlan(): { credit: string; cache: string } {
  return {
    credit: listedFigure("Buddy", /a (\$\d+) monthly usage credit/, "its monthly usage credit"),
    cache: listedFigure("Buddy", /\b(\d+ [GM]B) pipeline cache\b/, "its pipeline cache"),
  };
}

function appcircleStarterPlan(): { builds: string; maxMinutes: string } {
  return {
    builds: listedFigure("Appcircle", /\b(\d[\d,]*) builds\/month\b/, "its builds a month"),
    maxMinutes: listedFigure("Appcircle", /\b(\d+)-minute max build time\b/, "its maximum build time"),
  };
}

function codemagicFreePlanSentence(): string {
  return listedFigure("Codemagic", /— (Single-user plan [^.]*?teams get none\.)/, "its single-user plan in one sentence ending with teams getting none");
}

function tableRows(html: string, headers: string[]): Map<string, string[]> {
  const tables: Map<string, string[]>[] = [];
  for (const [, table] of html.matchAll(/<table\b[^>]*>([\s\S]*?)<\/table>/g)) {
    const heads = [...table.matchAll(/<th\b[^>]*>([\s\S]*?)<\/th>/g)].map((m) => readableText(m[1]));
    if (heads.join(" | ") !== headers.join(" | ")) continue;
    const rows = new Map<string, string[]>();
    for (const [, row] of table.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/g)) {
      const cells = [...row.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/g)].map((m) => readableText(m[1]));
      if (cells.length === headers.length) rows.set(cells[0], cells.slice(1));
    }
    tables.push(rows);
  }
  assert.strictEqual(tables.length, 1, `expected one table headed ${headers.join(" | ")}, found ${tables.length}`);
  return tables[0];
}

function rowOf(rows: Map<string, string[]>, vendor: string): string[] {
  const row = rows.get(vendor);
  assert.ok(row, `no row for ${vendor}`);
  return row!;
}

function cardText(html: string, slug: string): string {
  const cards = [...html.matchAll(/<div class="diff-card"[^>]*><h3><a href="\/vendor\/([^"]+)"[^>]*>[\s\S]*?<\/h3><p class="diff-desc">([\s\S]*?)<\/p>/g)]
    .filter(([, cardSlug]) => cardSlug === slug);
  assert.strictEqual(cards.length, 1, `expected one category card for /vendor/${slug}, found ${cards.length}`);
  return readableText(cards[0][2]);
}

function faqAnswers(html: string, question: string): string[] {
  const visible = [...html.matchAll(/<div class="faq-q">([\s\S]*?)<\/div>\s*<div class="faq-a">([\s\S]*?)<\/div>/g)]
    .filter(([, q]) => readableText(q) === question)
    .map(([, , a]) => readableText(a));
  const structured = [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)]
    .map(([, json]) => JSON.parse(json))
    .filter((data) => data["@type"] === "FAQPage")
    .flatMap((data) => data.mainEntity)
    .filter((entry: any) => entry.name === question)
    .map((entry: any) => String(entry.acceptedAnswer.text));
  return [...visible, ...structured];
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

const CI_CD_PRICING = "/ci-cd-pricing";
const SITEMAPS_OF_HAND_WRITTEN_PAGES = ["/sitemap-pages.xml", "/sitemap-reports.xml", "/sitemap-misc.xml"];
const AGENT_TEXT_ROUTES = ["/llms.txt", "/llms-full.txt"];

const PRICING_TABLE = ["Tool", "Free Minutes/mo", "Concurrency", "Self-Hosted", "Paid From", "Model"];
const FREE_TIER_TABLE = ["Tool", "Free Tier Type", "Free Minutes", "When You Hit the Wall"];
const COST_TABLE = ["Tool", "Solo / Small /mo", "Team /mo", "Key Cost Factor"];

const PRICING_MODELS_QUESTION = "How do CI/CD pricing models differ?";
const PRICING_MODELS_ANSWER = "There are three main models: per-seat (GitLab, Buildkite), per-minute/credit (CircleCI, AWS CodeBuild, Google Cloud Build), and per-parallel-job (Azure DevOps). Per-seat is predictable but penalizes large teams. Per-minute rewards fast builds but can spike. Per-parallel-job charges for concurrency.";

const WITHDRAWN: Record<string, RegExp> = {
  "Bitbucket Pipelines' Standard plan priced at $15 a user": /\$15\/user\/mo \(Standard\)/,
  "Codemagic priced per seat at $49": /\$49\/seat/,
  "Buddy's free plan given as 120 build minutes and 5 projects": /120 build minutes\/month, 5 projects/,
  "Appcircle's free plan given as 300 build minutes and 2 build profiles": /300 build minutes\/month, 1 concurrent build, 2 build profiles/,
  "Appcircle's Professional plan at $49 a month": /Professional at \$49\/mo/,
  "Buddy priced per pipeline": /per-pipeline \(Buddy\)/i,
  "Bitbucket Pipelines' self-hosted runners as paid only": /Paid only \(runners\)/,
  "Bitbucket Pipelines' self-hosted runners as needing Standard or higher": /require Standard plan or higher/,
};

describe("/ci-cd-pricing states the current plans of Bitbucket Pipelines, Codemagic, Buddy, Appcircle and CircleCI", () => {
  let proc: ChildProcess | undefined;
  let html = "";

  before(async () => {
    proc = await startServer();
    html = await (await fetch(`${base}${CI_CD_PRICING}`)).text();
  });

  after(() => { proc?.kill(); });

  it("prices Bitbucket Pipelines' Standard plan at $3.65 a user in the pricing and cost tables, and gives its free plan self-hosted runners that use no build minutes", () => {
    assert.deepStrictEqual(rowOf(tableRows(html, PRICING_TABLE), "Bitbucket Pipelines"), ["50 min/mo", "Up to 10 concurrent steps", "Yes (no build minutes used)", "$3.65/user/mo (Standard)", "Per-user + minutes"]);
    assert.deepStrictEqual(rowOf(tableRows(html, COST_TABLE), "Bitbucket Pipelines").slice(0, 2), ["$3.65/user", "$3.65/user + overages"]);
  });

  it("prices Codemagic by the minute, with $49 buying an extra concurrent build rather than a seat", () => {
    assert.deepStrictEqual(rowOf(tableRows(html, PRICING_TABLE), "Codemagic"), ["500 min/mo", "1 concurrent", "N/A (managed)", "Per minute (Pay-as-you-go); $49/mo per extra concurrent build", "Per-minute"]);
    assert.deepStrictEqual(rowOf(tableRows(html, COST_TABLE), "Codemagic"), ["$0–49", "Per minute + $49/concurrency", "500 minutes is reasonable for mobile. Pay-as-you-go charges per minute. Concurre..."]);
  });

  it("opens the Codemagic card with the single-user plan its listing states, which teams do not get", () => {
    assert.ok(cardText(html, "codemagic").startsWith(`${codemagicFreePlanSentence()} 1 concurrent build. Optimized for Flutter`), cardText(html, "codemagic"));
  });

  it("gives Buddy the usage credit and cache its listing states, two concurrent runs and Pro at €29 for one seat", () => {
    const { credit, cache } = buddyFreePlan();
    assert.deepStrictEqual(rowOf(tableRows(html, PRICING_TABLE), "Buddy"), [`${credit}/mo usage credit`, "2 concurrent", "Paid only", "€29/mo (Pro, 1 seat)", "Per-seat + concurrency"]);
    assert.deepStrictEqual(rowOf(tableRows(html, FREE_TIER_TABLE), "Buddy"), ["Limited free tier", `${credit}/mo usage credit`, "1–4 weeks for active team"]);
    assert.ok(cardText(html, "buddy").startsWith(`Free plan: 1 seat, 2 concurrent runs, a ${credit} monthly usage credit for compute and storage, ${cache} pipeline cache. Visual pipeline builder`), cardText(html, "buddy"));
    assert.deepStrictEqual(rowOf(tableRows(html, COST_TABLE), "Buddy"), ["€0 within the $1 credit", "€29+ (Pro)", "Pro: €29/mo, 1 seat; extra seat $20/mo; extra concurrent run $5/mo."]);
  });

  it("gives Appcircle's free Starter plan in the builds and build time its listing states, with Corporate as the only other plan", () => {
    const { builds, maxMinutes } = appcircleStarterPlan();
    assert.deepStrictEqual(rowOf(tableRows(html, PRICING_TABLE), "Appcircle"), [`${builds} builds/mo, ${maxMinutes} min/build`, "1 concurrent", "Corporate only", "Custom (Corporate)", "Per-plan"]);
    assert.deepStrictEqual(rowOf(tableRows(html, FREE_TIER_TABLE), "Appcircle"), ["Limited free tier", `${builds} builds/mo, ${maxMinutes} min/build`, "1–4 weeks for active team"]);
    assert.ok(cardText(html, "appcircle").startsWith(`Starter plan: 1 concurrent build, ${maxMinutes} minutes maximum per build, ${builds} builds a month. Mobile CI/CD`), cardText(html, "appcircle"));
    assert.deepStrictEqual(rowOf(tableRows(html, COST_TABLE), "Appcircle"), ["$0", "Custom (Corporate)", "20 builds a month is tight for iOS. Above Starter, the only plan is Corporate, t..."]);
  });

  it("says CircleCI's free plan includes self-hosted runner time, 5 tasks at once", () => {
    assert.deepStrictEqual(rowOf(tableRows(html, PRICING_TABLE), "CircleCI"), ["6,000 min/mo", "30 concurrent jobs", "Free runner time; 5 concurrent self-hosted tasks", "$15/seat (Performance)", "Credit-based"]);
  });

  it("gives Harness credits, machine-dependent minutes, local runners and unpublished paid pricing", () => {
    assert.deepStrictEqual(rowOf(tableRows(html, PRICING_TABLE), "Harness CI"), ["2,000 credits/mo (2,000 min on 2-core Linux)", "Varies", "Free (local runner)", "Contact sales (no published price)", "Contact sales"]);
    assert.strictEqual(rowOf(tableRows(html, COST_TABLE), "Harness CI")[1], "Contact sales (no published price)");
    const card = cardText(html, "harness-ci");
    for (const phrase of ["2,000 free Harness Cloud credits a month: 2,000 minutes on the 2-core Linux machine, 1,000 on the 4-core one.", "business email domain and credit card validation", "the Free plan offers the local runner; VM and Kubernetes build infrastructure need a paid plan"]) assert.ok(card.includes(phrase), phrase);
    assert.doesNotMatch(card, /up to 5 developers|unlimited self-hosted runners|2,000 free build minutes/);
    assert.doesNotMatch(readableText(html), /\$25\/dev/);
  });

  it("does not include Harness in either unrestricted self-hosted conclusion", () => {
    const text = readableText(html);
    for (const start of ["Key trends:", "The self-hosted advantage:"]) {
      const from = text.indexOf(start);
      assert.ok(from >= 0, start);
      const conclusion = text.slice(from, text.indexOf(".", from) + 1);
      assert.ok(conclusion.includes("GitHub Actions, GitLab CI, Buildkite, and Azure DevOps"), conclusion);
      assert.doesNotMatch(conclusion, /Harness/);
    }
  });

  it("states Bitrise Hobby credits, five builds at once and Starter billing in each table and card", () => {
    assert.deepStrictEqual(rowOf(tableRows(html, PRICING_TABLE), "Bitrise"), ["300 credits/mo", "5 concurrent", "Paid only", "$89/mo billed annually, $99 monthly (Starter)", "Credits"]);
    assert.strictEqual(rowOf(tableRows(html, FREE_TIER_TABLE), "Bitrise")[1], "300 credits/mo");
    assert.deepStrictEqual(rowOf(tableRows(html, COST_TABLE), "Bitrise"), ["$0–99", "$89/mo annual billing; $99/mo monthly (Starter)", "Hobby: 300 credits/mo. Starter: $89/mo billed annually, $99 monthly."]);
    assert.ok(cardText(html, "bitrise").startsWith("Hobby plan: 300 credits a month, 5 concurrent builds, 1 private app, a team of one, 90-minute build timeout."));
    assert.doesNotMatch(readableText(html), /Bitrise offers 300 free minutes|300 free min\)|300 minutes on standard VMs|Velocity|unlimited team members/);
    assert.ok(readableText(html).includes("Bitrise (300 credits/month, 5 concurrent builds on Hobby)"));
  });

  it("states Bitrise credits and concurrency in both copies of the mobile FAQ", () => {
    const answers = faqAnswers(html, "What is the cheapest CI/CD for mobile apps?");
    assert.strictEqual(answers.length, 2);
    for (const answer of answers) assert.ok(answer.includes("Bitrise Hobby offers 300 credits a month and 5 concurrent builds for a team of one."), answer);
  });

  it("states both CircleCI macOS M4 Pro rates and distinguishes small Linux Docker", () => {
    assert.ok(rowOf(tableRows(html, COST_TABLE), "CircleCI")[2].includes("macOS M4 Pro: 200 credits/min Medium, 400 Large"));
    assert.ok(readableText(html).includes("macOS M4 Pro VMs cost 200 credits/min for Medium and 400 for Large, compared with 5 credits/min for small Linux Docker."));
    assert.doesNotMatch(readableText(html), /macOS builds cost 100 credits/);
  });

  it("gives CodeBuild's free build machine 4 GiB of RAM and 2 vCPUs", () => {
    assert.ok(rowOf(tableRows(html, COST_TABLE), "AWS CodeBuild")[2].startsWith("100 free minutes is on the smallest instance (4 GiB RAM, 2 vCPU)."));
    assert.doesNotMatch(html, /3 GB RAM/i);
    assert.doesNotMatch(readableText(html), /3\s*G(?:i)?B\s*RAM/i);
  });

  it("scopes CodeBuild's adjustable default to Linux Small and a Region", () => {
    assert.strictEqual(rowOf(tableRows(html, PRICING_TABLE), "AWS CodeBuild")[1], "1 per Region by default (Linux Small; adjustable quota)");
  });

  it("excludes GitLab registries from repository storage and reserves dependency scanning for Ultimate", () => {
    const card = cardText(html, "gitlab-ci");
    assert.ok(card.includes("registry, packages and artifacts are outside the 10 GiB repository/LFS limit"), card);
    assert.ok(card.includes("SAST security scanning (dependency scanning requires Ultimate)"), card);
    assert.doesNotMatch(card, /container registry \(5 GB\)|SAST, dependency scanning/);
  });

  it("states Jenkins's current plugin count", () => {
    assert.ok(cardText(html, "jenkins").includes("2,300+ plugins"));
    assert.doesNotMatch(cardText(html, "jenkins"), /1,800\+ plugins/);
  });

  it("carries Buddy's current excerpt and login-based inactivity condition across both guides and its vendor page", async () => {
    const listing = cicdListing("Buddy");
    assert.match(listing.description, /1 seat, 2 concurrent pipeline runs, a \$1 monthly usage credit for compute and storage, 1 GB pipeline cache/);
    assert.match(listing.free_plan_excerpt.text, /2 concurrents \(no extra concurrents\).*\$1\/mo\. usage credit/);
    assert.match(listing.free_plan_excerpt.read_on, /^\d{4}-\d{2}-\d{2}$/);
    assert.strictEqual(listing.conditions.length, 1);
    const condition = listing.conditions[0];
    assert.strictEqual(condition.url, "https://buddy.works/terms-of-service");
    assert.strictEqual(condition.read_on, "2026-10-21");
    for (const phrase of ["logs in to Buddy's web app", "commits or webhooks do not count", "After a month without a login", "30 days after that email", "60 days after it"]) assert.ok(condition.text.includes(phrase), phrase);
    for (const route of [CI_CD_PRICING, "/cicd-free-tier-comparison-2026", "/vendor/buddy"]) {
      const response = await fetch(`${base}${route}`);
      assert.strictEqual(response.status, 200);
      const text = readableText(await response.text());
      assert.ok(text.includes(condition.text), route);
      assert.doesNotMatch(text, /workspace frozen after 60 days|300 pipeline GB-minutes/);
    }
    const otherGuide = readableText(await (await fetch(`${base}/cicd-free-tier-comparison-2026`)).text());
    assert.ok(otherGuide.includes("1 seat, 2 concurrent runs, $1 monthly usage credit"));
  });

  it("names three pricing models in the FAQ, on the page and in its structured data, with no per-pipeline model for Buddy", () => {
    assert.deepStrictEqual(faqAnswers(html, PRICING_MODELS_QUESTION).map((answer) => answer.startsWith(PRICING_MODELS_ANSWER)), [true, true]);
  });

  it("distinguishes Azure DevOps hosted and self-hosted prices in its complete cost cell", () => {
    assert.strictEqual(rowOf(tableRows(html, COST_TABLE), "Azure DevOps")[2], "One free Microsoft-hosted and one free self-hosted parallel job. Each extra: $40/month Microsoft-hosted, $15/month self-hosted.");
  });

  it("names Codeberg's request-based hosted Woodpecker instance in its complete cost cell", () => {
    assert.strictEqual(rowOf(tableRows(html, COST_TABLE), "Woodpecker CI")[2], "Woodpecker CI is self-hosted software; a hosted instance is available via Codeberg by request.");
  });

  it("states self-hosted runner concurrency and additional-job costs in both summaries", () => {
    const expected = "GitHub Actions, GitLab CI, Buildkite, and Azure DevOps offer self-hosted runners without per-minute charges. Buildkite’s Free plan allows 10 concurrent jobs. Azure DevOps charges $15/month per additional self-hosted parallel job.";
    const text = readableText(html);
    for (const label of ["Key trends:", "The self-hosted advantage:"]) {
      const from = text.indexOf(label);
      assert.ok(from >= 0, label);
      assert.ok(text.slice(from + label.length).trimStart().startsWith(expected), label);
    }
  });

  it("withdraws unlimited self-hosted concurrency and the denial of managed Woodpecker from raw and readable content", () => {
    for (const content of [html, readableText(html)]) {
      assert.doesNotMatch(content, /free\s*unlimited|no\s*managed\s*option/i);
    }
  });

  it("states macOS cost ranges in the summary and hidden costs", () => {
    const text = readableText(html);
    assert.ok(text.includes("Mobile CI/CD is the most expensive category, with macOS build minutes costing about 2x to 80x Linux minutes, depending on the provider."));
    assert.ok(text.includes("If you build iOS apps, budget 2x to 80x what you'd expect from Linux-only CI."));
    assert.doesNotMatch(text, /macOS build minutes costing 2–10x|budget 5–10x/);
  });

  it("gives the six free concurrency allowances without applying hosted Azure prices to self-hosted jobs", () => {
    const paragraph = [...html.matchAll(/<div class="hidden-cost-card">([\s\S]*?)<\/div>/g)].find(([, body]) => readableText(body).startsWith("Parallel Job Limits"));
    assert.ok(paragraph);
    assert.strictEqual(readableText(paragraph![1]), "Parallel Job Limits Free tiers allow 1 to 30 concurrent jobs. Examples: Azure DevOps 1, Codemagic 1, Bitrise 5, Buildkite 10, GitHub Actions 20, CircleCI 30.");
  });

  it("keeps self-hosted Jenkins and Woodpecker free without a time-to-upgrade limit", () => {
    const rows = tableRows(html, FREE_TIER_TABLE);
    for (const vendor of ["Jenkins", "Woodpecker CI", "Drone CI"]) assert.strictEqual(rowOf(rows, vendor)[2], "Never (self-hosted)", vendor);
    assert.strictEqual(rowOf(rows, "Google Cloud Build")[2], "Months of daily use");
  });

  it("distinguishes GitLab Free features and Premium compute minutes in its enterprise recommendation", () => {
    assert.ok(readableText(html).includes("Premium ($29/user) includes CI/CD and 10,000 compute minutes per month. Built-in CI/CD, the container registry, the package registry and Static Application Security Testing are on Free."));
    assert.doesNotMatch(readableText(html), /includes CI\/CD \+ security scanning \+ container registry \+ package registry/);
  });

  it("discloses Drone's beta Kubernetes runner and the three cloud free-minute allowances", () => {
    assert.ok(readableText(html).includes("Drone CI provides lightweight container-native pipelines, but its Kubernetes runner is currently in Beta."));
    assert.ok(readableText(html).includes("Google Cloud Build offers 2,500 free minutes a month. Azure DevOps offers 1,800. AWS CodeBuild offers 100."));
    assert.doesNotMatch(readableText(html), /for lightweight container-native pipelines on your own K8s cluster|Azure DevOps has the best free tier at 1,800/);
  });

  it("states container and VM execution separately in both copies of the Docker FAQ", () => {
    const answers = faqAnswers(html, "Which CI/CD tools support Docker and Kubernetes natively?");
    assert.strictEqual(answers.length, 2);
    for (const answer of answers) {
      assert.ok(answer.startsWith("Drone CI and Woodpecker CI run every pipeline step in a container. CircleCI runs jobs on Docker, Linux VM, Windows, Arm and macOS."), answer);
      assert.doesNotMatch(answer, /CircleCI, Codefresh, and Drone CI are container-native/);
    }
  });

  it("states Bitrise's pre-built workflow steps in its card", () => {
    assert.ok(cardText(html, "bitrise").includes("400+ pre-built workflow steps"));
    assert.doesNotMatch(cardText(html, "bitrise"), /300\+ pre-built integrations/);
  });

  it("keeps corrected storage, enterprise features, test intelligence and pipeline pricing in stored cost notes", () => {
    const compiled = readFileSync(path.join(root, "dist", "serve.js"), "utf8");
    const from = compiled.indexOf("function buildCiCdPricingPage()");
    assert.ok(from >= 0);
    const tools = compiled.slice(from, compiled.indexOf("const categoryLabels", from));
    for (const [vendor, required, retired] of [
      ["GitLab CI", "Past 10 GiB, projects go read-only until you buy more storage.", /Storage overage charges apply beyond 10 GiB/],
      ["Buildkite", "SSO is on Pro; SCIM, custom SAML and the activity log are Enterprise-only (custom pricing).", /Enterprise features \(SSO, audit logs\) require custom pricing/],
      ["Harness CI", "Test intelligence is a genuine differentiator.", /requires Harness-managed runners/],
      ["AWS CodeBuild", "CodePipeline charges separately ($1 per active V1 pipeline a month; V2 pipelines $0.002 per action execution minute).", /Larger instances cost 2–8x|\$1\/pipeline\/month/],
      ["Codemagic", "Pay-as-you-go charges per minute. Concurrent build limits can slow teams.", /macOS M2 Pro/],
    ] as const) {
      const start = tools.indexOf(`name: "${vendor}"`);
      assert.ok(start >= 0, vendor);
      const next = tools.indexOf('name: "', start + 1);
      const block = tools.slice(start, next < 0 ? tools.length : next);
      const match = block.match(/hiddenCosts: ("(?:[^"\\]|\\.)*")/);
      assert.ok(match, vendor);
      const cost = JSON.parse(match![1]);
      assert.ok(cost.includes(required), `${vendor}: ${cost}`);
      assert.doesNotMatch(cost, retired, vendor);
    }
  });

  it("leaves no guide, report, other hand-written page or llms text making any of the withdrawn CI/CD plan claims", async () => {
    const routes = new Set<string>(AGENT_TEXT_ROUTES);
    for (const sitemap of SITEMAPS_OF_HAND_WRITTEN_PAGES) {
      const xml = await (await fetch(`${base}${sitemap}`)).text();
      for (const [, loc] of xml.matchAll(/<loc>([^<]+)<\/loc>/g)) routes.add(new URL(loc).pathname);
    }
    assert.ok(routes.has(CI_CD_PRICING), "the sitemaps no longer list the page this sweep is for");
    const found: string[] = [];
    for (const route of routes) {
      const response = await fetch(`${base}${route}`);
      assert.strictEqual(response.status, 200, `${route} answers ${response.status}`);
      const text = readableText(await response.text());
      for (const [what, pattern] of Object.entries(WITHDRAWN)) {
        if (pattern.test(text)) found.push(`${route}: ${what}`);
      }
    }
    assert.deepStrictEqual(found, []);
  });
});
