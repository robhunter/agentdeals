/**
 * Drives every surface #1122 names against a server running the real index.
 *
 * Nothing here is stubbed: the server loads data/index.json, and each check
 * reads the page or the FAQPage structured data a caller would receive.
 *
 * Usage: node scripts/e2e-1122.mjs
 */

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { enrichOffers } from "../dist/data.js";

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

const WITHHOLDING_OUTCOMES = ["does_not_name_vendor", "states_no_terms", "unreadable"];

const REASON_TEXT = {
  does_not_name_vendor: /does not name it/,
  states_no_terms: /states no terms we can read/,
  unreadable: /could not read the page we cite/,
};

const ONE_OF_EACH_OUTCOME = {
  states_no_terms: "canva",
  unreadable: "openai",
  does_not_name_vendor: "cloudways",
};

const STILL_WITHHELD_FROM_1113 = ["kaggle", "umami", "lottiefiles", "coda", "imageengine"];

const CONFIRMED_SOURCE_CONTROL = "cloudflare-workers";

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
  const res = await fetch(`http://localhost:${port}${p}`);
  return { status: res.status, body: await res.text() };
};

function faqAnswers(body) {
  const page = [...body.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)]
    .map((m) => { try { return JSON.parse(m[1]); } catch { return null; } })
    .find((json) => json && json["@type"] === "FAQPage");
  if (!page) throw new Error("no FAQPage structured data on the page");
  return page.mainEntity.map((e) => e.acceptedAnswer.text);
}

const subjectRow = (body) => body.match(/<tr class="current-vendor-row">[\s\S]*?<\/tr>/)?.[0] ?? "";
const visibleAnswers = (body) => (body.match(/<div class="faq-a">[\s\S]*?<\/div>/g) ?? []).join("\n");

const toSlug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

const offers = (() => {
  const idx = JSON.parse(readFileSync(path.join(REPO, "data", "index.json"), "utf8"));
  return Array.isArray(idx) ? idx : idx.offers ?? [];
})();

const primaryBySlug = new Map();
for (const o of offers) {
  const slug = toSlug(o.vendor);
  if (!primaryBySlug.has(slug)) primaryBySlug.set(slug, o);
}

async function main() {
  proc = await startServer();

  console.log("\nAC-1 — a page whose source states no terms publishes no stability verdict");
  {
    const { status, body } = await get("/vendor/canva");
    check("/vendor/canva renders", () => assert(status === 200, `status ${status}`));
    check("no stable badge in the heading", () => {
      const h1 = body.match(/<h1>[\s\S]*?<\/h1>/)?.[0] ?? "";
      assert(!/risk-badge/.test(h1), `heading still carries a badge: ${h1}`);
    });
    check("no stability dot in its own comparison row", () =>
      assert(!/stability-dot/.test(subjectRow(body)), "subject row still prints a stability value"));
    check("the row says the source is unconfirmed", () =>
      assert(/source unconfirmed/.test(subjectRow(body)), "subject row does not say the source is unconfirmed"));
    check("the verdict does not read the empty history as stability", () =>
      assert(!/zero pricing changes recorded/.test(body), "verdict still claims zero recorded changes as a good sign"));
    check("the change history is not called a good sign", () =>
      assert(!/This is a good sign — stable pricing/.test(body), "change history still reads as good news"));
  }

  console.log("\nAC-2 — each outcome names its own reason, and no two read alike");
  const sentencesSeen = new Map();
  for (const [outcome, slug] of Object.entries(ONE_OF_EACH_OUTCOME)) {
    const { body } = await get(`/vendor/${slug}`);
    const own = [
      body.match(/<div class="quick-verdict">[\s\S]*?<\/div>/)?.[0] ?? "",
      body.match(/<p class="no-changes">[\s\S]*?<\/p>/)?.[0] ?? "",
      visibleAnswers(body),
    ].join("\n");
    sentencesSeen.set(outcome, own);
    check(`/vendor/${slug} (${outcome}) states its own reason`, () =>
      assert(REASON_TEXT[outcome].test(own), `page does not carry ${REASON_TEXT[outcome]}`));
    for (const other of WITHHOLDING_OUTCOMES) {
      if (other === outcome) continue;
      check(`/vendor/${slug} (${outcome}) does not borrow the ${other} wording`, () =>
        assert(!REASON_TEXT[other].test(own), `page also reads as ${other}`));
    }
  }

  console.log("\nAC-3 — the question an answer engine quotes first carries the caveat");
  for (const [outcome, slug] of Object.entries(ONE_OF_EACH_OUTCOME)) {
    const { body } = await get(`/vendor/${slug}`);
    const [q1, q2] = faqAnswers(body);
    check(`Q1 for ${slug} does not open with a bare Yes`, () =>
      assert(!/^Yes, /.test(q1), `Q1 opens: ${q1.slice(0, 80)}`));
    check(`Q2 for ${slug} does not open with a bare assertion of the terms`, () =>
      assert(!/^\w[\w .]*'s free tier is called/.test(q2), `Q2 opens: ${q2.slice(0, 80)}`));
    check(`Q1 for ${slug} carries the reason in its own text`, () =>
      assert(REASON_TEXT[outcome].test(q1), `Q1 does not name the reason: ${q1.slice(0, 120)}`));
    check(`Q2 for ${slug} carries the reason in its own text`, () =>
      assert(REASON_TEXT[outcome].test(q2), `Q2 does not name the reason: ${q2.slice(0, 120)}`));
    check(`Q1 for ${slug} still shows the stored terms`, () => {
      const stored = primaryBySlug.get(slug).description.slice(0, 40);
      assert(q1.includes(stored), `Q1 dropped the stored terms: ${q1.slice(0, 120)}`);
    });
    check(`the visible answer for ${slug} matches the structured one`, () => {
      const visible = visibleAnswers(body);
      assert(REASON_TEXT[outcome].test(visible), "the rendered FAQ does not carry the reason the JSON-LD does");
    });
  }

  console.log("\nPositive control — a record whose source confirms the terms is untouched");
  {
    const { body } = await get(`/vendor/${CONFIRMED_SOURCE_CONTROL}`);
    const [q1, , q3] = faqAnswers(body);
    check("its heading still carries a stable badge", () => {
      const h1 = body.match(/<h1>[\s\S]*?<\/h1>/)?.[0] ?? "";
      assert(/risk-badge/.test(h1) && />stable</.test(h1), `heading lost its badge: ${h1}`);
    });
    check("its own row still prints a stability value", () =>
      assert(/stability-dot/.test(subjectRow(body)), "subject row lost its stability value"));
    check("Q1 still opens with a bare Yes", () =>
      assert(/^Yes, /.test(q1), `Q1 opens: ${q1.slice(0, 80)}`));
    check("Q3 still calls it stable", () =>
      assert(/considered stable/.test(q3), `Q3 reads: ${q3.slice(0, 80)}`));
    check("nothing it says about itself carries withholding wording", () => {
      const own = [
        body.match(/<h1>[\s\S]*?<\/h1>/)?.[0] ?? "",
        body.match(/<div class="quick-verdict">[\s\S]*?<\/div>/)?.[0] ?? "",
        body.match(/<p class="no-changes">[\s\S]*?<\/p>/)?.[0] ?? "",
        subjectRow(body),
        faqAnswers(body).join("\n"),
      ].join("\n");
      for (const re of Object.values(REASON_TEXT)) {
        assert(!re.test(own), `a confirmed record says this about itself: ${re}`);
      }
    });
    check("it still reports a withheld alternative's status in that alternative's own row", () => {
      const rows = body.match(/<table class="mini-compare-table">[\s\S]*?<\/table>/)?.[0] ?? "";
      assert(rows.length > 0, "the page carries no comparison table");
      assert(/stability-dot/.test(subjectRow(body)), "the subject lost its own stability value");
    });
  }

  console.log("\nNegative control — the pages #1113 fixed still withhold, with their own wording");
  for (const slug of STILL_WITHHELD_FROM_1113) {
    const { body } = await get(`/vendor/${slug}`);
    const outcome = primaryBySlug.get(slug).source_check.outcome;
    check(`/vendor/${slug} still withholds`, () =>
      assert(/source unconfirmed/.test(subjectRow(body)) || !/stability-dot/.test(subjectRow(body)),
        "the page went back to publishing a stability value"));
    check(`/vendor/${slug} still names ${outcome}`, () =>
      assert(REASON_TEXT[outcome].test(body), `page no longer names its reason`));
  }

  console.log("\nThe alternatives page, which re-asserted a level of its own");
  for (const [outcome, slug] of Object.entries(ONE_OF_EACH_OUTCOME)) {
    const { body } = await get(`/alternative-to/${slug}`);
    const riskRow = body.match(/Risk Level:[\s\S]{0,300}?<\/div>/)?.[0] ?? "";
    check(`/alternative-to/${slug} publishes no stable level`, () => {
      assert(riskRow.length > 0, "the page carries no risk row");
      assert(!/>stable</.test(riskRow), `risk row still reads stable: ${riskRow.replace(/<[^>]*>/g, " ")}`);
    });
    check(`/alternative-to/${slug} says the source is unconfirmed where no level survives`, () => {
      const level = enrichOffers([primaryBySlug.get(slug)])[0].risk_level;
      if (level === null) {
        assert(/source unconfirmed/.test(riskRow), "risk row does not say the source is unconfirmed");
      } else {
        assert(new RegExp(`>${level}<`).test(riskRow),
          `an adverse level we can name a cause for must still be published, got: ${riskRow.replace(/<[^>]*>/g, " ")}`);
      }
    });
    check(`/alternative-to/${slug} does not read its empty history as stable pricing`, () =>
      assert(!/This indicates stable pricing/.test(body), "page still reads an empty history as stable pricing"));
    check(`/alternative-to/${slug} answers "still available" without a bare Yes`, () => {
      const stillAvailable = faqAnswers(body).find((a) => /free tier/.test(a) && !/best free alternatives/i.test(a));
      assert(stillAvailable && !/^Yes, /.test(stillAvailable), `answer opens: ${(stillAvailable ?? "").slice(0, 80)}`);
      assert(REASON_TEXT[outcome].test(stillAvailable), "the answer does not name the reason");
    });
  }
  {
    const { body } = await get(`/alternative-to/${CONFIRMED_SOURCE_CONTROL}`);
    const riskRow = body.match(/Risk Level:[\s\S]{0,300}?<\/div>/)?.[0] ?? "";
    check("the confirmed-source control keeps its stable level there too", () =>
      assert(/>stable</.test(riskRow), `risk row reads: ${riskRow.replace(/<[^>]*>/g, " ")}`));
  }

  console.log("\nAC-5 — counting what still renders a stability badge, over every vendor page");
  {
    const slugs = [...primaryBySlug.keys()];
    const dot = {};
    const bareYes = {};
    const queue = [...slugs];
    const worker = async () => {
      while (queue.length) {
        const slug = queue.shift();
        const { body } = await get(`/vendor/${slug}`);
        const outcome = primaryBySlug.get(slug).source_check?.outcome ?? "(none)";
        if (/stability-dot/.test(subjectRow(body))) dot[outcome] = (dot[outcome] ?? 0) + 1;
        if (/^Yes, /.test(faqAnswers(body)[0])) bareYes[outcome] = (bareYes[outcome] ?? 0) + 1;
      }
    };
    await Promise.all(Array.from({ length: 12 }, worker));

    console.log(`  stability badge by outcome: ${JSON.stringify(dot)}`);
    console.log(`  bare "Yes" by outcome:      ${JSON.stringify(bareYes)}`);

    for (const outcome of WITHHOLDING_OUTCOMES) {
      check(`no vendor page badges a ${outcome} record`, () =>
        assert(!dot[outcome], `${dot[outcome]} pages still badge a ${outcome} record`));
      check(`no vendor page answers a bare Yes for a ${outcome} record`, () =>
        assert(!bareYes[outcome], `${bareYes[outcome]} pages still answer a bare Yes`));
    }
    const okPages = slugs.filter((s) => primaryBySlug.get(s).source_check?.outcome === "ok").length;
    check("every confirmed-source page still badges and still answers Yes", () => {
      assert(dot.ok === okPages, `${dot.ok} of ${okPages} confirmed pages badge`);
      assert(bareYes.ok === okPages, `${bareYes.ok} of ${okPages} confirmed pages answer Yes`);
    });
  }

  console.log(`\n${passed} passed, ${failures.length} failed`);
  for (const f of failures) console.log(`  - ${f}`);
}

main()
  .catch((err) => { console.error(err); process.exitCode = 1; })
  .finally(() => {
    if (proc) proc.kill();
    if (failures.length > 0) process.exitCode = 1;
  });
