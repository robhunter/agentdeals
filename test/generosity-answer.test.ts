import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const { gradeSuperlatives, measuresTheFreeTier, outrankedElsewhere, pageTables } =
  await import("../dist/superlative-claims.js");
const { NO_COLUMN_SETTLES_GENEROSITY, GENEROSITY_JSON_TOKEN, GENEROSITY_PROSE_TOKEN } =
  await import("../dist/generosity-answer.js");
const { NO_RANKING_HELD } = await import("../dist/unranked.js");
const { statesVendorFigure } = await import("../dist/faq-provenance.js");

const __dirname = path.dirname(fileURLToPath(import.meta.url));
let serverPort = 0;
let proc: ChildProcess | null = null;

function startHttpServer(): Promise<ChildProcess> {
  return new Promise((resolve, reject) => {
    const child = spawn("node", [path.join(__dirname, "..", "dist", "serve.js")], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, PORT: "0", BASE_URL: "http://localhost", TZ: "UTC" },
    });
    const timeout = setTimeout(() => { child.kill(); reject(new Error("Server startup timeout")); }, 30000);
    child.stderr!.on("data", (data: Buffer) => {
      const match = data.toString().match(/running on http:\/\/localhost:(\d+)/);
      if (match) { serverPort = parseInt(match[1], 10); clearTimeout(timeout); resolve(child); }
    });
    child.on("error", (err) => { clearTimeout(timeout); reject(err); });
  });
}

async function get(p: string): Promise<string> {
  const res = await fetch(`http://localhost:${serverPort}${p}`, { redirect: "manual" });
  assert.strictEqual(res.status, 200, `${p} answered ${res.status}`);
  return res.text();
}

const COMPARISON_QUESTION_NOUNS: Record<string, string> = {
  "cloud-free-tier-comparison-2026": "cloud IaaS",
  "database-free-tier-comparison-2026": "database",
  "cicd-free-tier-comparison-2026": "CI/CD",
  "serverless-free-tier-comparison-2026": "serverless",
  "auth-comparison-2026": "auth",
  "email-comparison-2026": "email",
  "monitoring-comparison-2026": "monitoring",
  "storage-comparison-2026": "storage",
  "testing-free-tier-comparison-2026": "testing",
  "analytics-free-tier-comparison-2026": "analytics",
  "api-development-free-tier-comparison-2026": "API development",
  "security-free-tier-comparison-2026": "security",
  "hosting-free-tier-comparison-2026": "cloud hosting",
};

const GENEROSITY_QUESTION = /free tier is most generous\?$/;

function decode(text: string): string {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&mdash;/g, "—")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function plain(fragment: string): string {
  return decode(fragment.replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();
}

function faqAnswers(html: string): Map<string, string> {
  const answers = new Map<string, string>();
  for (const block of html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)) {
    const parsed = JSON.parse(block[1]!);
    if (parsed["@type"] !== "FAQPage") continue;
    for (const entry of parsed.mainEntity ?? []) answers.set(entry.name, entry.acceptedAnswer.text);
  }
  return answers;
}

function proseAnswers(html: string): Map<string, string> {
  const answers = new Map<string, string>();
  const from = html.indexOf(`<h2 id="faq">`);
  if (from < 0) return answers;
  for (const match of html.slice(from).matchAll(/<h3[^>]*>([\s\S]*?)<\/h3>\s*<p[^>]*>([\s\S]*?)<\/p>/g)) {
    answers.set(plain(match[1]!), plain(match[2]!));
  }
  return answers;
}

const served = new Map<string, string>();

before(async () => {
  proc = await startHttpServer();
  for (const slug of Object.keys(COMPARISON_QUESTION_NOUNS)) served.set(slug, await get(`/${slug}`));
});

after(() => { if (proc) proc.kill(); });

describe("#1492 the generosity answer resolves from the page it is printed on", () => {
  it("asks the question with a noun the page declares rather than a pluralised category name", () => {
    const wrong: string[] = [];
    for (const [slug, noun] of Object.entries(COMPARISON_QUESTION_NOUNS)) {
      const asked = [...faqAnswers(served.get(slug)!).keys()].filter(q => GENEROSITY_QUESTION.test(q));
      if (asked.length !== 1) { wrong.push(`/${slug} asks ${asked.length} generosity questions`); continue; }
      const expected = `Which ${noun} free tier is most generous?`;
      if (asked[0] !== expected) wrong.push(`/${slug} asks "${asked[0]}" and should ask "${expected}"`);
    }
    assert.deepStrictEqual(wrong, [], `ungrammatical or undeclared question text:\n${wrong.join("\n")}`);
  });

  it("declines to rank generosity only where nothing on the page grades", () => {
    const contradictions: string[] = [];
    let naming = 0;
    let refusing = 0;
    for (const [slug, html] of served) {
      const answer = [...faqAnswers(html)].find(([q]) => GENEROSITY_QUESTION.test(q))![1];
      const tables = pageTables(html);
      const standing = gradeSuperlatives(html).upheld.filter(
        upheld =>
          upheld.claim.direction === "max" &&
          measuresTheFreeTier(upheld, tables) &&
          !outrankedElsewhere(upheld, tables),
      );
      if (answer.startsWith(NO_COLUMN_SETTLES_GENEROSITY)) {
        refusing++;
        if (standing.length > 0) {
          contradictions.push(`/${slug} declines while ${standing[0]!.subject} stands on ${standing[0]!.column.header}`);
        }
        continue;
      }
      naming++;
      if (standing.length === 0) { contradictions.push(`/${slug} names a leader that nothing grades`); continue; }
      for (const upheld of standing) {
        if (!answer.includes(upheld.subject)) contradictions.push(`/${slug} grades ${upheld.subject} and names it nowhere`);
        if (!answer.includes(upheld.column.header)) contradictions.push(`/${slug} rests on ${upheld.column.header} and names no column`);
      }
    }
    assert.deepStrictEqual(contradictions, [], `answers that disagree with their own page:\n${contradictions.join("\n")}`);
    assert.strictEqual(naming + refusing, Object.keys(COMPARISON_QUESTION_NOUNS).length);
    assert.ok(naming > 0, "no page names a graded leader, so this sweep proves nothing");
    assert.ok(refusing > 0, "no page keeps the refusal, so the negative control is not exercised");
  });

  it("names no claim another table on the same page outranks", () => {
    const amplified: string[] = [];
    for (const [slug, html] of served) {
      const answer = [...faqAnswers(html)].find(([q]) => GENEROSITY_QUESTION.test(q))![1];
      if (answer.startsWith(NO_COLUMN_SETTLES_GENEROSITY)) continue;
      const tables = pageTables(html);
      for (const upheld of gradeSuperlatives(html).upheld) {
        if (!outrankedElsewhere(upheld, tables)) continue;
        if (answer.includes(upheld.subject)) {
          amplified.push(`/${slug} names ${upheld.subject}, which another ${upheld.column.header} column outranks`);
        }
      }
    }
    assert.deepStrictEqual(amplified, [], `answers republishing a claim the page refutes:\n${amplified.join("\n")}`);
  });

  it("names no subject whose only claim on the page is editorial", () => {
    const editorial: string[] = [];
    for (const [slug, html] of served) {
      const answer = [...faqAnswers(html)].find(([q]) => GENEROSITY_QUESTION.test(q))![1];
      const graded = gradeSuperlatives(html);
      const gradedSubjects = new Set(graded.upheld.map(upheld => upheld.subject));
      for (const { claim } of graded.ungraded) {
        if (claim.direction !== null || !claim.subject) continue;
        if (gradedSubjects.has(claim.subject)) continue;
        if (answer.includes(`${claim.subject} leads`)) {
          editorial.push(`/${slug} crowns ${claim.subject} on the ungraded badge "${claim.label}"`);
        }
      }
    }
    assert.deepStrictEqual(editorial, [], `editorial judgement promoted into structured data:\n${editorial.join("\n")}`);
  });

  it("publishes the same answer to a reader and to a machine", () => {
    const disagreeing: string[] = [];
    for (const [slug, html] of served) {
      const machine = faqAnswers(html);
      const reader = proseAnswers(html);
      for (const [question, text] of machine) {
        if (!GENEROSITY_QUESTION.test(question)) continue;
        const shown = reader.get(question);
        if (shown === undefined) { disagreeing.push(`/${slug} answers "${question}" to a machine and to no reader`); continue; }
        if (shown !== text) disagreeing.push(`/${slug}\n  machine: ${text}\n  reader:  ${shown}`);
      }
    }
    assert.deepStrictEqual(disagreeing, [], `two surfaces answering differently:\n${disagreeing.join("\n")}`);
  });

  it("leaves the figure in the column it names rather than restating it", () => {
    const restating: string[] = [];
    for (const [slug, html] of served) {
      const answer = [...faqAnswers(html)].find(([q]) => GENEROSITY_QUESTION.test(q))![1];
      if (statesVendorFigure(answer)) restating.push(`/${slug} :: ${answer}`);
    }
    assert.deepStrictEqual(restating, [], `answers stating a figure they cannot date:\n${restating.join("\n")}`);
  });

  it("leaves no substitution marker on a served page", () => {
    const leaked: string[] = [];
    for (const [slug, html] of served) {
      for (const token of [GENEROSITY_PROSE_TOKEN, GENEROSITY_JSON_TOKEN]) {
        if (html.includes(token)) leaked.push(`/${slug} still carries ${token}`);
      }
    }
    assert.deepStrictEqual(leaked, [], `unsubstituted markers:\n${leaked.join("\n")}`);
  });

  it("stops telling a machine that generosity varies by use case", () => {
    const stale = [...served].filter(([, html]) => /generosity varies by use case/.test(html)).map(([slug]) => `/${slug}`);
    assert.deepStrictEqual(stale, [], `pages still publishing the template refusal:\n${stale.join("\n")}`);
  });

  it("keeps the catalogue refusal wherever the page asks for a best", () => {
    const missing: string[] = [];
    let refusing = 0;
    for (const [slug, html] of served) {
      const answers = faqAnswers(html);
      const asked = [...answers].filter(([question]) => /^What is the best free /.test(question));
      if (asked.length === 0) continue;
      for (const [question, answer] of asked) {
        if (answer.includes(NO_RANKING_HELD)) refusing++;
        else missing.push(`/${slug} answers "${question}" without the refusal`);
      }
    }
    assert.deepStrictEqual(missing, [], `pages that dropped the catalogue refusal:\n${missing.join("\n")}`);
    assert.strictEqual(refusing, 12, `${refusing} comparison pages refuse to name a best`);
  });
});
