import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const file = `${root}/data/deal_changes.json`;
const READ_ON = "2026-09-09";

const RETRACTIONS = [
  {
    vendor: "Middleware.io",
    date: "2026-08-28",
    source_url: "https://middleware.io/pricing/",
    detail:
      `Retracted ${READ_ON}: middleware.io/pricing/, the page this record cites, opens its plan ladder with "Free Forever. $0. Free access to all features with monthly limits." and lists "Up to 100GB Data. Up to 1k RUM Sessions. Up to 20k Synthetic Checks. 10 Browser Test Runs. Unlimited Users." Those are the terms this record withheld, figure for figure. The sentence this record read - "We provide 14 days free trial with unlimited data ingestion" - is an answer about trial retention further down the same page, and it is still there today beside the free plan. The page did not change; the reading did.`,
  },
  {
    vendor: "ploi.io",
    date: "2026-08-28",
    source_url: "https://ploi.io/pricing",
    detail:
      `Retracted ${READ_ON}: ploi.io/pricing, one hop from the homepage this record cites, publishes a plan comparison whose first column is "Free" at "€0 $0 /mo", and its own FAQ reads "After your trial ends, we will set your subscription to the free plan." The 5-day trial this record read is a trial of a paid plan that falls back to Free, not a replacement for it. The free plan has narrowed since we recorded it, and that narrowing is the limits_reduced record of 2026-09-07.`,
  },
  {
    vendor: "Simple Observability",
    date: "2026-08-28",
    source_url: "https://simpleobservability.com/pricing",
    detail:
      `Retracted ${READ_ON}: simpleobservability.com/pricing publishes "Free. Free plan for one server. Ideal for testing, development, or low-traffic workloads." and prices it "Free. for 1 server." with 50 metrics per server. Our withheld terms read "Free for one server." The "$3/month" this record quotes is the paid rung above that plan and is still on the same page.`,
  },
  {
    vendor: "Financial Data",
    date: "2026-08-28",
    source_url: "https://financialdata.net/pricing",
    detail:
      `Retracted ${READ_ON}: financialdata.net/pricing opens its ladder with "Free. $ 0 /month. 300 Requests / Day. REST API & Python SDK. Symbol Lists. Market & Miscellaneous Data." Our withheld terms read "Free plan allows 300 requests per day." The 10, 30 and 50 requests-per-second tiers this record describes are the paid rungs above it on the same page.`,
  },
  {
    vendor: "DynamicDocs",
    date: "2026-08-28",
    source_url: "https://advicement.io/dynamic-documents-api/pricing",
    detail:
      `Retracted ${READ_ON}: advicement.io/dynamic-documents-api/pricing, linked from the homepage this record cites, publishes "The DynamicDocs API is available on a free and paid plans" and then "Free Plan ... Free. 50 API Calls per Month. 0 Private LaTeX Templates. Access to JSON to PDF Templates. Dashboard Access." Our withheld terms read "The free plan allows 50 API calls per month and access to a library of templates." The sentence this record read - "Create documents from $0.062 per PDF" - is a marketing line still on advicement.io today that names no plan.`,
  },
  {
    vendor: "Survicate",
    date: "2026-08-28",
    source_url: "https://survicate.com/pricing/",
    detail:
      `Retracted ${READ_ON}: survicate.com/pricing/, the page this record cites, answers "Is there a Free version of Survicate?" with "Yes! Our Free Plan is perfect for getting started with surveys at no cost. It includes: Up to 25 responses per month, 1 active survey at a time, Basic CRM integrations", and adds "When you sign up, you'll automatically start with a 10-day free trial of our pro features. After that, your account will switch to the Free Plan unless you choose to upgrade." The trial this record read converts to the free plan rather than replacing it. That answer is published only in the page's FAQPage structured markup - the visible accordion renders the questions without the answers - so re-reading the visible text of this URL can never recover it.`,
  },
  {
    vendor: "ScraperAPI",
    date: "2026-08-28",
    source_url: "https://www.scraperapi.com/pricing/",
    detail:
      `Retracted ${READ_ON}: scraperapi.com/pricing/, the page this record cites, answers "Does ScraperAPI offer a free plan?" with "Yes, ScraperAPI offers a free plan where you can sign up here and get 1,000 free API credits (with a maximum of 5 concurrent connections)." Our withheld terms read "Free plan: 1,000 API credits/month, 5 concurrent connections." The sentence this record read - "Start collecting data with our 7-day trial and 5,000 API credits" - is the banner above the paid ladder on the same page and is still there today.`,
  },
];

const RETYPINGS = [
  {
    vendor: "localazy.com",
    date: "2026-09-07",
    from: "free_tier_removed",
    to: "limits_reduced",
    impact: "medium",
    summary:
      "The free plan now covers up to 200 source keys, down from 1,000 source language strings. It remains a free plan with unlimited seats and languages, not a trial.",
    current_state:
      'localazy.com/pricing publishes "Small project = free plan! ... Up to 200 source keys, All essential localization features, Unlimited seats & languages", prices "Free Plan" at 0 USD in its structured markup, and answers "Can I use Localazy for free?" with "Yes, our free plan includes all core localization features". The 14-day trial on the same page is a trial of the Business plan.',
  },
  {
    vendor: "InstallOnAir",
    date: "2026-08-28",
    from: "free_tier_removed",
    to: "limits_reduced",
    impact: "medium",
    summary:
      "Builds uploaded by a registered user now expire after 8 days, down from 60. Registration is still free and uploads are still free.",
    current_state:
      'www.installonair.com reads "Register for free - Signup and get access to build for 8 days". Expiry can then be extended for $1 (1 month), $4.99 (6 months) or $9.99 (1 year).',
  },
];

const data = JSON.parse(readFileSync(file, "utf8"));
const changes = data.changes;

function locate(vendor, date, changeType) {
  const at = changes.findIndex(
    (c) => c.vendor === vendor && c.date === date && c.change_type === changeType,
  );
  if (at < 0) throw new Error(`no ${changeType} record for ${vendor} on ${date}`);
  return at;
}

let retracted = 0;
for (const entry of RETRACTIONS) {
  const at = locate(entry.vendor, entry.date, "free_tier_removed");
  if (changes[at].resolution?.detail === entry.detail) continue;
  changes[at] = {
    ...changes[at],
    resolution: {
      state: "retracted",
      date: READ_ON,
      detail: entry.detail,
      source_url: entry.source_url,
    },
  };
  retracted += 1;
}

let retyped = 0;
for (const entry of RETYPINGS) {
  const at = changes.findIndex(
    (c) => c.vendor === entry.vendor && c.date === entry.date && (c.change_type === entry.from || c.change_type === entry.to),
  );
  if (at < 0) throw new Error(`no record for ${entry.vendor} on ${entry.date}`);
  if (changes[at].change_type === entry.to && changes[at].summary === entry.summary) continue;
  changes[at] = {
    ...changes[at],
    change_type: entry.to,
    impact: entry.impact,
    summary: entry.summary,
    current_state: entry.current_state,
  };
  retyped += 1;
}

writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
console.log(`retracted ${retracted}, re-typed ${retyped}`);
