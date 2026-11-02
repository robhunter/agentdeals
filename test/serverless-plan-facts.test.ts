import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";

const repo = fileURLToPath(new URL("..", import.meta.url));
const route = "/serverless-free-tier-comparison-2026";
let child: ChildProcess;
let html = "";
const plain = (s: string) => s.replace(/<a\b[^>]*class="[^"]*(?:figure-source|record-source)[^"]*"[^>]*>[\s\S]*?<\/a>/g, "")
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

describe("serverless plans, grants and billing", () => {
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
  });
  after(() => child?.kill("SIGKILL"));

  it("withdraws obsolete plan claims from the complete response", () => {
    for (const text of ["Vercel Edge Functions", "via Vercel KV", "25s (Hobby)", "128 MB (Edge)", "30s (HTTP)", "1M service calls", "1 microVM", "100K events", "450K reads", "0.000046", "~46 GB-seconds", "10,000ms (10 seconds)", "Premium for custom domains", "credit-based model in 2026", "growth cost analysis"]) {
      assert.ok(!html.toLowerCase().includes(text.toLowerCase()), text);
      assert.ok(!plain(html).toLowerCase().includes(text.toLowerCase()), text);
    }
  });

  it("withdraws obsolete runtime, location and cold-start claims from the complete response", () => {
    for (const text of ["V8 isolates (JS/TS)<", "All three use V8 isolates", "they all bill by wall-clock time", "CDN PoPs worldwide", "&lt;10ms", "avoid this entirely with V8 isolate architecture", "bill by CPU time with near-zero cold starts"]) {
      assert.ok(!html.toLowerCase().includes(text.toLowerCase()), text);
      assert.ok(!plain(html).toLowerCase().includes(plain(text).toLowerCase()), text);
    }
  });

  it("gives Deno's hello-world cold start in both tables and Vercel's supported runtimes", () => {
    assert.equal(row("main-comparison", "Deno Deploy")[6], "<100ms (hello world)");
    assert.equal(row("edge-compute", "Deno Deploy")[2], "<100ms (hello world)");
    assert.equal(row("edge-compute", "Vercel Functions")[3], "Node.js, Python, Go, Ruby, Bun, Rust, Wasm");
    assert.equal(row("edge-compute", "Cloudflare Workers")[2], "<5ms");
    assert.equal(row("edge-compute", "Vercel Functions")[2], "<5ms");
  });

  it("distinguishes elapsed billing and each platform's runtime and default location", () => {
    assert.equal(paragraph("The big three clouds' serverless compute"), "The big three clouds' serverless compute, the most mature platforms with the largest ecosystems. Lambda Event Functions, Cloud Run functions and Azure Functions bill elapsed time, waits included. AWS's Lambda Web Functions (since 2026-10-12) bill active CPU time.");
    assert.equal(paragraph("Platforms that bill CPU time rather than elapsed time."), "Platforms that bill CPU time rather than elapsed time. Cloudflare Workers runs V8 isolates across Cloudflare's network. Vercel Functions run Node.js, Python and other runtimes in Washington, D.C. by default. Deno Deploy runs Deno apps in Linux microVMs.");
  });

  it("distinguishes Workers isolates, shared Fluid instances and Deno microVM cold starts", () => {
    assert.ok(section("edge-compute", "full-service").includes("Only Workers uses V8 isolates. Vercel Functions run on Fluid compute, where concurrent requests share one instance. Deno Deploy starts each app in a pre-provisioned Linux microVM, and Deno says cold starts take under 100 ms for a hello-world app and a few hundred milliseconds for larger apps."));
    assert.ok(section("main-comparison", "traditional-faas").includes("Edge platforms (Workers, Deno Deploy) and Vercel Functions bill by CPU time. Workers' cold starts are under 5 ms, Deno Deploy's under 100 ms for a hello-world app."));
    assert.equal(paragraph("AWS Lambda Provisioned Concurrency"), "AWS Lambda Provisioned Concurrency eliminates cold starts but costs $0.015/GB-hour — not free tier eligible. Azure Functions Premium keeps instances warm but starts at ~$0.173/vCPU-hour. Cloudflare Workers avoids this with V8 isolates, with cold starts under 5 ms and no warm-up configuration. Deno Deploy pre-provisions Linux microVMs, and Deno puts its cold starts under 100 ms for a hello-world app.");
  });

  it("retains the complete main-table provider roster", () => {
    assert.deepEqual(table("main-comparison").map(r => r[0]), ["AWS Lambda", "Google Cloud Functions", "Azure Functions", "Google Cloud Run", "Cloudflare Workers", "Vercel Functions", "Deno Deploy", "Val Town", "DBOS", "Inngest", "Trigger.dev"]);
  });

  it("gives Vercel Functions its Hobby invocation, memory, duration and CPU limits", () => {
    assert.deepEqual(row("main-comparison", "Vercel Functions"), ["Vercel Functions", "1M function invocations/mo", "4 hrs Active CPU/mo", "2 GB / 1 vCPU (Hobby)", "300s (Hobby)", "Active CPU time", "<5ms (Edge) / 250ms (Serverless)", "Yes (Hobby)"]);
  });

  it("distinguishes Lambda Event and Web billing without changing the grant", () => {
    assert.deepEqual(row("main-comparison", "AWS Lambda"), ["AWS Lambda", "1M / month", "400K GB-sec/mo", "128 MB – 10 GB", "15 min max", "Duration (Event Functions); active CPU (Web Functions)", "100–500ms (cold)", "Yes (Always Free)"]);
  });

  it("labels Azure's Consumption and Flex grants separately", () => {
    assert.deepEqual(row("main-comparison", "Azure Functions"), ["Azure Functions", "1M / month (Consumption); 250K (Flex Consumption)", "400K GB-sec/mo (Consumption); 100K (Flex Consumption)", "1.5 GB max (Consumption)", "5 min (default) / 10 min (max)", "Wall-clock time", "200–1000ms (cold)", "Yes (Always Free)"]);
  });

  it("leaves Workers HTTP duration unlimited and retains its CPU and daily limits", () => {
    assert.deepEqual(row("main-comparison", "Cloudflare Workers"), ["Cloudflare Workers", "100K / day (~3M/mo)", "10ms CPU time / invocation", "128 MB RAM", "No limit (HTTP) / 15 min (Cron)", "CPU time only", "<5ms (near-zero)", "Yes"]);
  });

  it("gives Deno its default memory and million KV reads while keeping the shutdown", () => {
    assert.deepEqual(row("main-comparison", "Deno Deploy"), ["Deno Deploy", "1M / month", "10 hrs CPU time/mo", "768 MB (default)", "No hard limit", "CPU time", "<100ms (hello world)", "No"]);
    assert.equal(row("edge-compute", "Deno Deploy")[4], "KV: 1 GB (1M reads/mo)");
    assert.ok(plain(html).includes("Deno said on 2026-10-09 that Deno Deploy will keep running for six months and then shut down; it gave no exact date."));
  });

  it("offers only DBOS's open-source library free and prices the hosted options", () => {
    assert.deepEqual(row("main-comparison", "DBOS"), ["DBOS", "None hosted (open-source library is free)", "Self-hosted on your Postgres", "Your own servers", "No hard limit", "DBOS Pro $99/mo; DBOS Cloud via sales", "Scale-to-zero (seconds)", "Library only"]);
    assert.equal(row("specialized", "DBOS")[1], "Open-source library free; DBOS Cloud via sales, Pro $99/mo");
    assert.equal(paragraph("DBOS Transact is open source"), "DBOS Transact is open source and free to self-host on Postgres, for TypeScript, Python, Go, Java and Kotlin. There is no free hosted plan: DBOS Pro is $99 a month and DBOS Cloud is sold through sales.");
  });

  it("gives Inngest 500K events in both tables and retains its execution allowance", () => {
    assert.deepEqual(row("main-comparison", "Inngest"), ["Inngest", "50K executions/mo", "500K events/mo", "Runs on your serverless", "Configurable retries", "Execution-based", "Depends on host", "Yes (Hobby)"]);
    assert.equal(row("specialized", "Inngest")[1], "50K executions/mo, 500K events");
  });

  it("keeps Vercel's updated name, invocations and Marketplace storage together", () => {
    const cells = row("edge-compute", "Vercel Functions");
    assert.equal(cells[1], "1M invocations/mo, 4 hrs Active CPU");
    assert.equal(cells[4], "Blob: 1 GB; Redis via Marketplace (Vercel KV ended)");
    assert.match(section("edge-compute", "full-service"), /Vercel Functions fit Vercel\/Next\.js projects; Vercel deprecated Edge Functions for new projects\./);
  });

  it("distinguishes the Azure grants and Lambda billing in its quick verdict", () => {
    assert.match(paragraph("Quick verdict:"), /Azure Functions matches Lambda at 1M requests\/month on its Consumption plan; its recommended Flex Consumption plan gives 250,000 executions a month\.$/);
    assert.equal(paragraph("The critical distinction most developers miss:"), "The critical distinction most developers miss: Cloudflare Workers, Vercel Functions and AWS Lambda Web Functions (since 2026-10-12) bill CPU time, so waiting on I/O is not billed. Lambda Event Functions (AWS's new name for existing Lambda functions), Cloud Run functions and Azure Functions bill elapsed time, waits included. For I/O-heavy workloads this matters more than headline invocation counts.");
    assert.match(plain(html), /Traditional FaaS \(Lambda Event Functions, Cloud Run functions, Azure Functions\) bills by elapsed time/);
    assert.match(plain(html), /Edge platforms \(Workers, Deno Deploy\) and Vercel Functions bill by CPU time/);
  });

  it("explains function URLs and Azure custom domains without a Premium requirement", () => {
    assert.match(section("traditional-faas", "edge-compute"), /AWS Lambda vs Google Cloud Functions vs Azure Functions: AWS Lambda and Azure Functions' Consumption plan each give 1M requests and 400K GB-s free; Cloud Run functions \(formerly Cloud Functions\) give 2M invocations; Azure's recommended Flex Consumption plan gives 250,000 executions and 100,000 GB-s\. Lambda function URLs expose a function over HTTPS at no extra charge; API Gateway is optional\. Azure Functions supports custom domains on the Consumption plan by CNAME; Premium is not needed\./);
    assert.equal(paragraph("A Lambda function URL"), "A Lambda function URL serves HTTPS at no charge beyond Lambda's own. API Gateway is for its extra features (request validation, authorizers, Cognito, OAuth 2.0) at $3.50 per million REST API requests or $1.00 per million HTTP API requests.");
  });

  it("names both billing groups and uses the supplied elapsed and CPU examples", () => {
    const text = section("billing-gotcha", "best-for");
    for (const sentence of ["Elapsed-time billing (Lambda Event Functions, Cloud Run functions, Azure Functions, Cloud Run)", "You pay for the whole run, waits included. A 500 ms call that waits 480 ms on a database is billed for 500 ms.", "CPU-time billing (Cloudflare Workers, Vercel Functions, Lambda Web Functions)", "You pay for CPU time actually used; waiting on I/O is not billed. The same call that uses 20 ms of CPU is billed for 20 ms.", "AWS Lambda Event Function: Billed for ~360ms of elapsed time at 128 MB = 0.045 GB-seconds", "At 1M requests a month, the Lambda Event Function uses 45,000 GB-seconds (0.045 each), inside Lambda's 400,000 GB-second free tier. The Workers function uses 10,000 seconds of CPU (about 2.8 hours), and each request sits at the free plan's 10 ms CPU limit, not under it."]) assert.ok(text.includes(sentence), sentence);
  });

  it("recommends Node.js Fluid compute for new Vercel projects", () => {
    const text = section("best-for", "hidden-costs");
    assert.ok(text.includes("Next.js / Vercel projects → Vercel Functions"));
    assert.equal(paragraph("Vercel deprecated Edge Functions"), "Vercel deprecated Edge Functions for new projects; use Vercel Functions on the Node.js runtime with Fluid compute. Hobby includes 1M invocations and 4 hours of Active CPU a month, for non-commercial use.");
  });

  it("dates Vercel Pro credits while retaining Hobby's separate grants and purchase restriction", () => {
    assert.match(section("hidden-costs", "changes"), /Vercel Pro credits/);
    assert.equal(paragraph("On 2025-09-09 Vercel moved Pro"), "On 2025-09-09 Vercel moved Pro to $20 of monthly usage credit. Hobby is unchanged and has no credits: it includes 1M function invocations, 4 hours of Active CPU and 360 GB-hours of Provisioned Memory a month, and Hobby accounts cannot buy more. Vercel details →");
  });

  it("keeps every other main-table figure and the specialized grants", () => {
    assert.deepEqual(row("main-comparison", "Google Cloud Functions"), ["Google Cloud Functions", "2M / month", "400K GB-sec + 200K GHz-sec", "128 MB – 32 GB", "9 min (1st gen) / 60 min (2nd gen)", "Wall-clock time", "200–800ms (cold)", "Yes (Always Free)"]);
    assert.deepEqual(row("main-comparison", "Google Cloud Run"), ["Google Cloud Run", "2M / month", "360K GB-sec + 180K vCPU-sec", "Up to 32 GB / 8 vCPU", "60 min max", "Wall-clock time (request-based)", "100–500ms (cold)", "Yes (Always Free)"]);
    assert.deepEqual(row("main-comparison", "Val Town"), ["Val Town", "100K runs/day", "1 min wall clock / run", "Managed (V8 isolates)", "1 min per run", "Run-based", "<50ms", "Yes"]);
    assert.deepEqual(row("main-comparison", "Trigger.dev"), ["Trigger.dev", "$5 free compute/mo", "20 concurrent runs", "Managed compute", "No hard limit", "Compute time-based", "Warm pool available", "Yes"]);
    assert.equal(row("specialized", "Cloudflare Durable Objects")[1], "100K requests/day (on Workers free)");
    assert.equal(row("full-service", "Google Cloud Run")[1], "2M req/mo, 360K GB-sec, 180K vCPU-sec");
  });

  it("gives the same section-free limits answer in visible FAQ and JSON-LD", () => {
    const expected = "Each provider structures free tier limits differently — some cap storage, others cap requests or compute hours. Our comparison table provides exact numbers for each provider.";
    const faq = [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map(m => JSON.parse(m[1])).find(j => j["@type"] === "FAQPage");
    assert.ok(faq);
    const answer = faq.mainEntity.find((q: { name: string }) => q.name === "How do serverless free tiers compare on limits?");
    assert.equal(answer?.acceptedAnswer.text, expected);
    assert.equal(paragraph("Each provider structures free tier limits differently"), expected);
  });
});
