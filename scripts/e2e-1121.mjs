import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { levelWithheldReason } from "../dist/source-check.js";
import { enrichOffers } from "../dist/data.js";

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

const UNDERSTATED = {
  "embed.ly": "15 requests/sec",
  "Discord API": "5 messages per 5 seconds per channel",
  "OpenAI": "3 requests/min",
  "Gemini CLI": "60 requests/min",
  "Cerebras": "30 requests/min",
  "codehooks.io": "60 API calls/min",
  "SerpApi": "50 requests/hour",
  "UserCheck": "120 requests/hour",
  "ampt.dev": "500 invocations/hour",
  "MiniMax": "7 requests per 5 hours",
  "Beeceptor": "50 requests/day",
  "Country-State-City Microservice API": "100 requests/day",
  "Financial Data": "300 requests/day",
  "Geolocated.io": "2,000 requests/day",
  "IP Geolocation": "1,000 requests/day",
  "microlink.io": "50 requests/day",
  "Mockfly": "500 requests/day",
  "Pocket Alert": "50 messages/day",
  "Imitate Email": "15 emails/day",
  "podio.com": "1,000 API calls/day",
};

const NO_PERIOD_STATED = {
  "Inngest": "100K events",
  "Authress": "1000 API calls",
  "Logo.dev": "10,000 API calls",
  "Pingram.io": "3000 Emails",
  "phare.io": "100,000 events",
  "AppFit": "200K events",
};

const NOT_A_RATE = { "Zulip": "10,000 messages of search history" };

const CONFIRMED_RATE_CONTROL = "cloudflare-workers";

let port = 0;
let proc = null;
let passed = 0;
const failures = [];

function check(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ok   ${name}`);
  } catch (err) {
    failures.push(`${name}: ${err.message}`);
    console.log(`  FAIL ${name}\n       ${err.message}`);
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function startServer() {
  return new Promise((resolve, reject) => {
    const child = spawn("node", [path.join(REPO, "dist", "serve.js")], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, PORT: "0", BASE_URL: "http://localhost" },
    });
    const timeout = setTimeout(() => { child.kill(); reject(new Error("server startup timeout")); }, 30000);
    child.stderr.on("data", (buf) => {
      const m = buf.toString().match(/running on http:\/\/localhost:(\d+)/);
      if (m) { port = parseInt(m[1], 10); clearTimeout(timeout); resolve(child); }
    });
    child.on("error", (err) => { clearTimeout(timeout); reject(err); });
  });
}

const get = async (p) => {
  const res = await fetch(`http://localhost:${port}${p}`, { redirect: "manual" });
  return { status: res.status, body: await res.text() };
};

const growthBlock = (body) =>
  body.match(/<div class="section growth-section">[\s\S]*?<\/div>/)?.[0] ?? "";

function outgrowAnswer(body) {
  const page = [...body.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)]
    .map((m) => { try { return JSON.parse(m[1]); } catch { return null; } })
    .find((json) => json && json["@type"] === "FAQPage");
  if (!page) throw new Error("no FAQPage structured data on the page");
  const entry = page.mainEntity.find((e) => /outgrow/i.test(e.name));
  if (!entry) throw new Error("no outgrow question in the structured data");
  return entry.acceptedAnswer.text;
}

const bullets = (body) =>
  [...growthBlock(body).matchAll(/<li>([\s\S]*?)<\/li>/g)].map((m) => m[1].replace(/<[^>]*>/g, "").trim());

const firstBullet = (body) => bullets(body)[0] ?? "";

const rateBullet = (body) =>
  bullets(body).find((b) => /^(At|We record) .*(requests|invocations|events|emails|messages|api ?calls)/i.test(b)) ?? "";

const toSlug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

const offers = JSON.parse(readFileSync(path.join(REPO, "data", "index.json"), "utf8")).offers;
const primaryByVendor = new Map();
for (const o of offers) if (!primaryByVendor.has(o.vendor)) primaryByVendor.set(o.vendor, o);

function withheld(vendor) {
  const offer = primaryByVendor.get(vendor);
  return levelWithheldReason(offer, enrichOffers([offer])[0].link_unreachable);
}

async function main() {
  proc = await startServer();

  console.log("\nAC-1 — every understated rate now states the period its description states");
  const rendered = [];
  for (const [vendor, expected] of Object.entries(UNDERSTATED)) {
    const slug = toSlug(vendor);
    const { status, body } = await get(`/vendor/${slug}`);
    check(`/vendor/${slug} renders`, () => assert(status === 200, `status ${status}`));
    const bullet = rateBullet(body);
    rendered.push(`| ${vendor} | ${bullet} |`);
    check(`/vendor/${slug} states ${expected}`, () =>
      assert(bullet.includes(expected), `first bullet reads: ${bullet}`));
    if (!withheld(vendor)) {
      check(`/vendor/${slug} does not say per month`, () =>
        assert(!/\/mo\b/.test(bullet), `first bullet reads: ${bullet}`));
    }
  }

  console.log("\nAC-2 — a description stating no period does not gain one");
  for (const [vendor, expected] of Object.entries(NO_PERIOD_STATED)) {
    const slug = toSlug(vendor);
    const { body } = await get(`/vendor/${slug}`);
    const bullet = rateBullet(body);
    rendered.push(`| ${vendor} | ${bullet} |`);
    check(`/vendor/${slug} states ${expected} with no period`, () =>
      assert(bullet.includes(expected), `first bullet reads: ${bullet}`));
    check(`/vendor/${slug} asserts no month`, () =>
      assert(!/\/mo\b|per month/.test(bullet), `first bullet reads: ${bullet}`));
  }

  console.log("\nAC-3 — a description naming two periods for one noun does not merge them");
  {
    const { body } = await get("/vendor/gemini-cli");
    const bullet = rateBullet(body);
    check("/vendor/gemini-cli names the per-minute limit", () =>
      assert(/60 requests\/min/.test(bullet), `first bullet reads: ${bullet}`));
    check("/vendor/gemini-cli does not attach the daily period to the per-minute number", () =>
      assert(!/60 requests\/day/.test(bullet), `first bullet reads: ${bullet}`));
  }

  console.log("\nAC-4 — a stored depth is not published as a rate");
  for (const [vendor, expected] of Object.entries(NOT_A_RATE)) {
    const slug = toSlug(vendor);
    const { body } = await get(`/vendor/${slug}`);
    const bullet = rateBullet(body);
    rendered.push(`| ${vendor} | ${bullet} |`);
    check(`/vendor/${slug} states ${expected}`, () =>
      assert(bullet.includes(expected), `first bullet reads: ${bullet}`));
    check(`/vendor/${slug} does not render it as a monthly allowance`, () =>
      assert(!/messages\/mo/.test(bullet), `first bullet reads: ${bullet}`));
  }

  console.log("\nAC-5 — readers and structured data receive the same threshold");
  for (const vendor of Object.keys(UNDERSTATED)) {
    const slug = toSlug(vendor);
    const { body } = await get(`/vendor/${slug}`);
    const bullet = firstBullet(body);
    const answer = outgrowAnswer(body);
    check(`/vendor/${slug} leads its block with the threshold`, () =>
      assert(bullet === rateBullet(body), `leads with: ${bullet}`));
    check(`/vendor/${slug} ships one threshold to both surfaces`, () =>
      assert(answer.startsWith(bullet), `visible: ${bullet}\n       structured: ${answer}`));
  }

  console.log("\nThe threshold withholds on the same condition the stability verdict does");
  {
    const { body } = await get("/vendor/siliconflow");
    const block = growthBlock(body);
    check("/vendor/siliconflow stops asserting a threshold as fact", () =>
      assert(!/At 100 requests\/day, you'll need to upgrade/.test(block), `block reads: ${block}`));
    check("/vendor/siliconflow keeps the recorded threshold visible", () =>
      assert(/We record 100 requests\/day as the limit/.test(block), `block reads: ${block}`));
    check("/vendor/siliconflow names why it cannot confirm it", () =>
      assert(/states no terms we can read/.test(block), `block reads: ${block}`));
    check("/vendor/siliconflow carries the caveat into structured data", () =>
      assert(/we cannot confirm that threshold today/.test(outgrowAnswer(body)),
        `structured answer: ${outgrowAnswer(body)}`));
  }

  console.log("\nEvery withheld record stops asserting its threshold, and no confirmed one does");
  {
    let withheldPages = 0;
    let assertedThreshold = 0;
    let confirmedPages = 0;
    let confirmedCaveats = 0;
    for (const [vendor, offer] of primaryByVendor) {
      const { body } = await get(`/vendor/${toSlug(vendor)}`);
      const block = growthBlock(body);
      if (!block) continue;
      if (withheld(vendor)) {
        withheldPages++;
        if (/^At .*you'll need to upgrade\./.test(firstBullet(body))) {
          assertedThreshold++;
          console.log(`       still asserting: ${vendor} — ${firstBullet(body)}`);
        }
      } else {
        confirmedPages++;
        if (/we cannot confirm that threshold today/.test(block)) {
          confirmedCaveats++;
          console.log(`       caveat on a confirmed page: ${vendor}`);
        }
      }
      void offer;
    }
    check(`no withheld page asserts a threshold (${withheldPages} withheld pages)`, () =>
      assert(assertedThreshold === 0, `${assertedThreshold} pages still assert one`));
    check(`no confirmed page gained a caveat (${confirmedPages} confirmed pages)`, () =>
      assert(confirmedCaveats === 0, `${confirmedCaveats} pages gained one`));
  }

  console.log("\nPositive control — a description whose period already matched is untouched");
  {
    const { body } = await get(`/vendor/${CONFIRMED_RATE_CONTROL}`);
    check(`/vendor/${CONFIRMED_RATE_CONTROL} still reads 100K requests/day`, () =>
      assert(/^At 100K requests\/day, you'll need to upgrade\.$/.test(rateBullet(body)),
        `rate bullet reads: ${rateBullet(body)}`));
  }

  console.log("\nRendered thresholds\n");
  console.log("| Vendor | Outgrow line |");
  console.log("|---|---|");
  for (const row of rendered) console.log(row);

  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length) {
    for (const f of failures) console.log(`  - ${f}`);
    process.exitCode = 1;
  }
}

main()
  .catch((err) => { console.error(err); process.exitCode = 1; })
  .finally(() => { if (proc) proc.kill(); });
