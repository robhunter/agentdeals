import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  ASSISTANTS_API_SHUTDOWN, azureRetirementStatement, azureSurvivalClaims, plainText,
} from "../dist/assistants-shutdown.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(__dirname, "..");

let serverPort = 0;
let proc: ChildProcess | null = null;

function startServer(): Promise<ChildProcess> {
  return new Promise((resolve, reject) => {
    const child = spawn("node", [path.join(REPO, "dist", "serve.js")], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, PORT: "0", BASE_URL: "http://localhost" },
    });
    const timeout = setTimeout(() => { child.kill(); reject(new Error("Server startup timeout")); }, 20000);
    child.stderr!.on("data", (data: Buffer) => {
      const m = data.toString().match(/running on http:\/\/localhost:(\d+)/);
      if (m) { serverPort = parseInt(m[1], 10); clearTimeout(timeout); resolve(child); }
    });
    child.on("error", (err) => { clearTimeout(timeout); reject(err); });
  });
}

const rendered = new Map<string, string>();

before(async () => {
  proc = await startServer();
  for (const page of ASSISTANTS_API_SHUTDOWN.pages) {
    const res = await fetch(`http://localhost:${serverPort}${page}`);
    assert.strictEqual(res.status, 200, `${page} should render`);
    rendered.set(page, await res.text());
  }
});

after(() => { if (proc) proc.kill(); });

const WITHDRAWN_CLAIMS = [
  "Same GPT models via Azure. Assistants API on Azure has NOT been deprecated — Azure may maintain it independently.",
  "Azure OpenAI has NOT announced deprecation of its Assistants API implementation.",
  "If you're on Azure, this may buy you time to plan a more careful migration.",
  "Developers must migrate to the Responses API, switch to Azure OpenAI (which has not announced deprecation), or move on.",
  "For teams already on Azure, the Assistants API may continue working — monitor Azure announcements.",
  "Azure OpenAI · $200 trial credits · Credits expire · Assistants API (not deprecated)",
  "Azure OpenAI — same GPT models, enterprise SLAs, data residency. Assistants API may not be deprecated on Azure.",
];

describe("Azure Assistants API retirement (#1089)", () => {
  it("Microsoft's published retirement date is pinned independently of the render", () => {
    assert.strictEqual(ASSISTANTS_API_SHUTDOWN.isoDate, "2026-08-26");
    assert.strictEqual(ASSISTANTS_API_SHUTDOWN.date, "August 26, 2026");
    assert.strictEqual(ASSISTANTS_API_SHUTDOWN.azureSuccessor, "Microsoft Foundry Agent Service");
  });

  it("the detector flags every survival claim this page used to publish", () => {
    for (const claim of WITHDRAWN_CLAIMS) {
      assert.notDeepStrictEqual(azureSurvivalClaims(claim), [], `detector missed: ${claim}`);
    }
  });

  it("no page claims the Azure Assistants API outlived the shutdown date", () => {
    for (const [page, html] of rendered) {
      const claims = azureSurvivalClaims(plainText(html));
      assert.deepStrictEqual(claims, [], `${page} still tells the reader the Azure Assistants API survived: ${claims.join(" | ")}`);
    }
  });

  it("no source string claims the Azure Assistants API outlived the shutdown date", () => {
    const srcDir = path.join(REPO, "src");
    const offenders: string[] = [];
    const patternHome = "assistants-shutdown.ts";
    for (const file of readdirSync(srcDir).filter(f => f.endsWith(".ts") && f !== patternHome)) {
      for (const claim of azureSurvivalClaims(readFileSync(path.join(srcDir, file), "utf-8"))) {
        offenders.push(`src/${file}: ${claim}`);
      }
    }
    assert.deepStrictEqual(offenders, [], `survival claims in source: ${offenders.join(" | ")}`);
  });

  it("every page covering the shutdown states the Azure retirement date and names the successor", () => {
    for (const [page, html] of rendered) {
      const statement = azureRetirementStatement(html);
      assert.ok(statement, `${page} states no Azure retirement date alongside ${ASSISTANTS_API_SHUTDOWN.azureSuccessor}`);
      assert.strictEqual(statement.date, ASSISTANTS_API_SHUTDOWN.date, `${page} dates the Azure retirement differently`);
    }
  });

  it("the three pages agree on the retirement date and the named successor", () => {
    const dates = new Set<string>();
    for (const [page, html] of rendered) {
      const statement = azureRetirementStatement(html);
      assert.ok(statement, `${page} carries no Azure retirement statement to compare`);
      dates.add(statement.date);
    }
    assert.strictEqual(rendered.size, 3, "three pages cover this shutdown");
    assert.deepStrictEqual([...dates], [ASSISTANTS_API_SHUTDOWN.date], "pages disagree on the Azure retirement date");
  });

  it("the structured FAQ answer about Azure states the retirement", () => {
    const html = rendered.get("/openai-assistants-migration")!;
    const blocks = [...html.matchAll(/<script type="application\/ld\+json">(.*?)<\/script>/gs)].map(m => JSON.parse(m[1]));
    const faq = blocks.find(b => b["@type"] === "FAQPage");
    assert.ok(faq, "/openai-assistants-migration should publish FAQPage markup");
    const azureQuestion = faq.mainEntity.find((q: { name: string }) => /Azure/i.test(q.name));
    assert.ok(azureQuestion, "an FAQ entry should answer the Azure question");
    const answer: string = azureQuestion.acceptedAnswer.text;
    assert.deepStrictEqual(azureSurvivalClaims(answer), [], `structured answer still claims survival: ${answer}`);
    assert.ok(answer.includes(ASSISTANTS_API_SHUTDOWN.date), "structured answer should carry the retirement date");
    assert.ok(answer.includes(ASSISTANTS_API_SHUTDOWN.azureSuccessor), "structured answer should name the successor");
  });
});
