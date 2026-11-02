import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";

const repo = fileURLToPath(new URL("..", import.meta.url));
let child: ChildProcess;
let cloudflare = "";
let brevo = "";
const plain = (text: string): string => text.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
const workers = "Cloudflare recommends Workers for new projects and full-stack apps.";
const recommendation = "no commercial use restrictions (except credit card processing), or you're building static/Jamstack sites. " + workers;

function faq(html: string): Record<string, string> {
  const blocks = [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map(match => JSON.parse(match[1]));
  const pages = blocks.filter(block => block["@type"] === "FAQPage");
  assert.equal(pages.length, 1);
  return Object.fromEntries(pages[0].mainEntity.map((question: { name: string; acceptedAnswer: { text: string } }) => [question.name, question.acceptedAnswer.text]));
}

describe("curated comparisons state framework deployment and email plan scope", () => {
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
    const read = async (route: string) => {
      const response = await fetch(`http://localhost:${port}${route}`, { redirect: "error" });
      assert.equal(response.status, 200);
      return response.text();
    };
    cloudflare = await read("/cloudflare-pages-vs-vercel");
    brevo = await read("/brevo-vs-resend");
  });
  after(() => child?.kill("SIGKILL"));

  it("removes the obsolete framework claims from the complete response", () => {
    for (const text of ["Next.js features may lag", "first-class support for ISR, middleware, and edge functions"]) {
      assert.ok(!cloudflare.includes(text), text);
      assert.ok(!plain(cloudflare).includes(text), text);
    }
  });

  it("distinguishes static Pages exports from beta full-stack Next.js on Workers", () => {
    const bullet = cloudflare.match(/<li><strong>Framework support:<\/strong>([\s\S]*?)<\/li>/)?.[1];
    assert.ok(bullet);
    assert.equal(plain(bullet), "Cloudflare Pages runs static Next.js exports. For full-stack Next.js (SSR, RSC, Server Actions, middleware), Cloudflare recommends vinext, a beta reimplementation of the Next.js API, on Workers. Vercel created Next.js and supports Next.js features such as ISR and middleware.");
  });

  it("recommends Workers in the visible recommendation with the payment restriction", () => {
    const paragraph = cloudflare.match(/<p><strong>Choose Cloudflare Pages if<\/strong>([\s\S]*?)<\/p>/)?.[1];
    assert.ok(paragraph);
    assert.ok(plain(paragraph).includes(recommendation));
  });

  it("carries the same recommendation into visible and structured FAQ answers", () => {
    const answer = faq(cloudflare)["Should I choose Cloudflare Pages or Vercel?"];
    assert.ok(answer?.includes(recommendation));
    const visible = [...cloudflare.matchAll(/<div class="faq-a">([\s\S]*?)<\/div>/g)].map(match => plain(match[1]));
    assert.equal(visible.filter(text => text.includes(recommendation)).length, 1);
  });

  it("removes transactional-only and uncapped-daily email claims", () => {
    for (const text of ["no daily cap fluctuation", "purely transactional"]) {
      assert.ok(!brevo.includes(text), text);
      assert.ok(!plain(brevo).includes(text), text);
    }
  });

  it("states Resend's monthly allowance and daily cap in its volume bullet", () => {
    const bullet = brevo.match(/<li><strong>Free volume:<\/strong>([\s\S]*?)<\/li>/)?.[1];
    assert.ok(bullet);
    assert.ok(plain(bullet).includes("Resend allows 3K emails/month, capped at 100 a day."));
  });

  it("distinguishes transactional and marketing APIs and the marketing contact limit", () => {
    const bullet = brevo.match(/<li><strong>Scope:<\/strong>([\s\S]*?)<\/li>/)?.[1];
    assert.ok(bullet);
    assert.equal(plain(bullet), "Brevo includes marketing automation, landing pages, CRM, and segmentation. Resend sends transactional emails using the /emails API and marketing emails using the /broadcasts API or dashboard. Its marketing plans are limited by the number of contacts, not emails.");
  });
});
