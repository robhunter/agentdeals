import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { createVerifierClient, fetchPageText } from "./verify-freshness.js";
import { priceSignals } from "./change-gate.js";
import { holdsVerifiedDate, sourceCheckRecord } from "./vendor-naming.js";
import { pageStatesNoPrice } from "./verification-state.js";
import { excerptTheFreePlan, readFreePlanExcerpt } from "./free-plan-excerpt.js";

const slugOf = (name) => String(name).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

function cell(text) {
  return String(text ?? "").replace(/\s+/g, " ").replace(/([\\`*_[\]<>|])/g, "\\$1");
}

function shortened(text, length) {
  const flat = String(text ?? "").replace(/\s+/g, " ").trim();
  return flat.length > length ? `${flat.slice(0, length)}...` : flat;
}

async function sampleOne(client, offer, today) {
  const row = { vendor: offer.vendor, tier: offer.tier, url: offer.url, stored_outcome: offer.source_check?.outcome ?? null };
  const page = await fetchPageText(offer.url);
  const check = sourceCheckRecord(offer, page, page.ok ? priceSignals(page.text) : [], today);
  Object.assign(row, { source_check: check.outcome, source_detail: check.detail ?? null, rendered: Boolean(check.rendered), truncated: Boolean(page.truncated) });
  if (!page.ok) return { ...row, outcome: "not_fetched", excerpt: null, why: `the page could not be fetched: ${page.error}` };
  if (holdsVerifiedDate(check.outcome) && !pageStatesNoPrice(check.outcome)) {
    return { ...row, outcome: "not_asked", excerpt: null, why: `not asked, because the read found ${check.outcome}: ${check.detail ?? ""}`.trim() };
  }
  let answer = null;
  const read = async (asked, text) => (answer = await readFreePlanExcerpt(client, asked, text));
  const record = { ...offer };
  const written = await excerptTheFreePlan(record, { offer, pageText: page.text, read, readOn: today });
  const why = {
    written: null,
    none: "the reader found no words on the page stating this free plan",
    removed: "the reader found no words on the page stating this free plan",
    not_a_free_plan: `not asked: ${written.why}`,
    refused: `refused, ${written.why}`,
    unread: `the reader gave no usable answer: ${written.why ?? "none"}`,
  }[written.outcome];
  return { ...row, outcome: written.outcome, excerpt: record.free_plan_excerpt?.text ?? null, copied: written.copied ?? null, terms: answer?.terms ?? null, other_plans: answer?.otherPlans ?? null, why };
}

function tableOf(rows) {
  const lines = [
    "| Vendor | Tier | URL | source_check | Excerpt, or why none was stored |",
    "|---|---|---|---|---|",
  ];
  for (const row of rows) {
    const outcome = row.stored_outcome && row.stored_outcome !== row.source_check
      ? `${row.source_check} (stored: ${row.stored_outcome})`
      : row.source_check;
    const answer = row.excerpt
      ? `"${cell(row.excerpt)}"`
      : `*${cell(row.why)}*${row.outcome === "refused" && row.copied ? `. The reader copied: "${cell(shortened(row.copied, 240))}"` : ""}`;
    lines.push(`| ${cell(row.vendor)} | ${cell(row.tier)} | ${cell(row.url)} | ${cell(outcome)} | ${answer} |`);
  }
  return lines.join("\n");
}

async function main() {
  const args = process.argv.slice(2);
  const option = (name) => {
    const at = args.indexOf(name);
    return at >= 0 ? args[at + 1] : undefined;
  };
  const slugs = (option("--vendors") ?? "").split(",").map((slug) => slug.trim()).filter(Boolean);
  const out = option("--out") ?? "excerpt-sample.json";
  const offers = JSON.parse(readFileSync("data/index.json", "utf-8")).offers;
  const picked = slugs.flatMap((slug) => offers.filter((offer) => slugOf(offer.vendor) === slug));
  const missing = slugs.filter((slug) => !offers.some((offer) => slugOf(offer.vendor) === slug));
  const client = createVerifierClient();
  const today = new Date().toISOString().slice(0, 10);
  const progress = out.replace(/\.json$/, "") + ".jsonl";
  writeFileSync(progress, "");
  const rows = [];
  for (const offer of picked) {
    const row = await sampleOne(client, offer, today);
    rows.push(row);
    appendFileSync(progress, `${JSON.stringify(row)}\n`);
    console.log(`${row.vendor} [${row.tier}]: ${row.source_check}, ${row.outcome}${row.excerpt ? ` "${shortened(row.excerpt, 100)}"` : ` (${shortened(row.why, 160)})`}`);
    await sleep(500);
  }
  const counts = rows.reduce((tally, row) => ({ ...tally, [row.outcome]: (tally[row.outcome] ?? 0) + 1 }), {});
  writeFileSync(out, `${JSON.stringify({ today, listings: rows.length, counts, missing, rows }, null, 2)}\n`);
  const table = tableOf(rows);
  writeFileSync(out.replace(/\.json$/, ".md"), `${table}\n`);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${table}\n`);
  console.log(`\n${rows.length} listings on ${slugs.length} vendor pages read on ${today}: ${JSON.stringify(counts)}`);
  if (missing.length > 0) console.log(`No listing for: ${missing.join(", ")}`);
}

main().catch((err) => {
  console.error(err?.message ?? err);
  process.exit(1);
});
