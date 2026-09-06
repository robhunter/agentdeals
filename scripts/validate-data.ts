#!/usr/bin/env node

import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { summaryCallsItsSourceUnreadable } from "../dist/change-citation.js";
import {
  CHANGE_REPORT_RULE,
  CHANGE_REPORT_SUBJECTS,
  UNCITED_CHANGE_BUDGET_RULE,
  countsAgainstUncitedBudget,
  ourIndexChangeMayNotCiteASource,
  type ChangeReportSubject,
} from "../dist/change-reporting.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

const VALID_CATEGORIES = [
  "AI / ML",
  "AI Coding",
  "API Development",
  "API Gateway",
  "Analytics",
  "Auth",
  "Background Jobs",
  "Browser Automation",
  "Banking & Finance",
  "CDN",
  "CI/CD",
  "Cloud Hosting",
  "Cloud IaaS",
  "Cloud Storage",
  "Code Quality",
  "Communication",
  "Communication & Messaging",
  "Consumer Email",
  "Container Registry",
  "DNS & Domain Management",
  "Databases",
  "Design",
  "Design & Creative",
  "Dev Utilities",
  "Education",
  "Diagramming",
  "Documentation",
  "Email",
  "Error Tracking",
  "Feature Flags",
  "Fitness & Health",
  "Forms",
  "Headless CMS",
  "IDE & Code Editors",
  "Infrastructure",
  "Localization",
  "Logging",
  "Low-Code Platforms",
  "Maps/Geolocation",
  "Media",
  "Meditation & Wellness",
  "Messaging",
  "Mobile Development",
  "Monitoring",
  "News & Reading",
  "Notebooks & Data Science",
  "Password Managers",
  "Payments",
  "Productivity & Notes",
  "Project Management",
  "Search",
  "Secrets Management",
  "Security",
  "Server Management",
  "Source Control",
  "Startup Perks",
  "Startup Programs",
  "Status Pages",
  "Storage",
  "Streaming & Media",
  "Team Collaboration",
  "Testing",
  "Tunneling & Networking",
  "VPN & Privacy",
  "Video",
  "Web Scraping",
  "Workflow Automation",
];

interface Offer {
  vendor: string;
  category: string;
  description: string;
  tier: string;
  url: string;
  tags: string[];
  verifiedDate: string;
  [key: string]: unknown;
}

interface DealChange {
  vendor: string;
  change_type: string;
  reports?: string;
  date: string;
  summary: string;
  previous_state: string;
  current_state: string;
  impact: string;
  source_url: string;
  category: string;
  alternatives: string[];
  date_source?: string;
}

interface ValidationError {
  file: string;
  index: number;
  vendor: string;
  field: string;
  message: string;
}

const URL_REGEX = /^https?:\/\/.+/;
const ISO_DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;

const REQUIRED_OFFER_FIELDS = [
  "vendor",
  "category",
  "description",
  "tier",
  "url",
  "tags",
  "verifiedDate",
];

const REQUIRED_CHANGE_FIELDS = [
  "vendor",
  "change_type",
  "date",
  "summary",
  "previous_state",
  "current_state",
  "impact",
  "source_url",
  "category",
  "alternatives",
  "date_source",
];

const VALID_DATE_SOURCES = ["vendor_page", "hand_written", "discovered"];

function validateOffers(offers: Offer[]): ValidationError[] {
  const errors: ValidationError[] = [];
  const seen = new Map<string, number>();

  for (let i = 0; i < offers.length; i++) {
    const offer = offers[i];
    const vendor = offer.vendor || `(index ${i})`;

    for (const field of REQUIRED_OFFER_FIELDS) {
      if (offer[field] === undefined || offer[field] === null) {
        errors.push({
          file: "data/index.json",
          index: i,
          vendor,
          field,
          message: `Missing required field: ${field}`,
        });
      }
    }

    if (offer.url && !URL_REGEX.test(offer.url)) {
      errors.push({
        file: "data/index.json",
        index: i,
        vendor,
        field: "url",
        message: `Invalid URL format: ${offer.url}`,
      });
    }

    if (offer.description && offer.description.length < 30) {
      errors.push({
        file: "data/index.json",
        index: i,
        vendor,
        field: "description",
        message: `Description too short (${offer.description.length} chars, min 30): "${offer.description}"`,
      });
    }

    if (offer.verifiedDate && !ISO_DATE_REGEX.test(offer.verifiedDate)) {
      errors.push({
        file: "data/index.json",
        index: i,
        vendor,
        field: "verifiedDate",
        message: `Invalid date format (expected YYYY-MM-DD): ${offer.verifiedDate}`,
      });
    }

    if (offer.verifiedDate && ISO_DATE_REGEX.test(offer.verifiedDate)) {
      const d = new Date(offer.verifiedDate);
      if (isNaN(d.getTime())) {
        errors.push({
          file: "data/index.json",
          index: i,
          vendor,
          field: "verifiedDate",
          message: `Invalid date value: ${offer.verifiedDate}`,
        });
      }
    }

    if (offer.category && !VALID_CATEGORIES.includes(offer.category)) {
      errors.push({
        file: "data/index.json",
        index: i,
        vendor,
        field: "category",
        message: `Unknown category: "${offer.category}"`,
      });
    }

    const key = `${offer.vendor}|||${offer.category}`;
    if (seen.has(key)) {
      errors.push({
        file: "data/index.json",
        index: i,
        vendor,
        field: "vendor+category",
        message: `Duplicate entry (same as index ${seen.get(key)}): ${offer.vendor} | ${offer.category}`,
      });
    } else {
      seen.set(key, i);
    }
  }

  return errors;
}

function validateDealChanges(changes: DealChange[]): ValidationError[] {
  const errors: ValidationError[] = [];

  for (let i = 0; i < changes.length; i++) {
    const change = changes[i];
    const vendor = change.vendor || `(index ${i})`;

    for (const field of REQUIRED_CHANGE_FIELDS) {
      if (
        (change as Record<string, unknown>)[field] === undefined ||
        (change as Record<string, unknown>)[field] === null
      ) {
        errors.push({
          file: "data/deal_changes.json",
          index: i,
          vendor,
          field,
          message: `Missing required field: ${field}`,
        });
      }
    }

    if (change.date && !ISO_DATE_REGEX.test(change.date)) {
      errors.push({
        file: "data/deal_changes.json",
        index: i,
        vendor,
        field: "date",
        message: `Invalid date format (expected YYYY-MM-DD): ${change.date}`,
      });
    }

    if (change.source_url && !URL_REGEX.test(change.source_url)) {
      errors.push({
        file: "data/deal_changes.json",
        index: i,
        vendor,
        field: "source_url",
        message: `Invalid URL format: ${change.source_url}`,
      });
    }

    if (change.date_source && !VALID_DATE_SOURCES.includes(change.date_source)) {
      errors.push({
        file: "data/deal_changes.json",
        index: i,
        vendor,
        field: "date_source",
        message: `Unknown date_source "${change.date_source}". Valid: ${VALID_DATE_SOURCES.join(", ")}`,
      });
    }

    if (change.reports && !CHANGE_REPORT_SUBJECTS.includes(change.reports as ChangeReportSubject)) {
      errors.push({
        file: "data/deal_changes.json",
        index: i,
        vendor,
        field: "reports",
        message: `Unknown reports "${change.reports}". Valid: ${CHANGE_REPORT_SUBJECTS.join(", ")}`,
      });
    }

    if (ourIndexChangeMayNotCiteASource(change)) {
      errors.push({
        file: "data/deal_changes.json",
        index: i,
        vendor,
        field: "source_url",
        message:
          `A record that reports our own index cites ${change.source_url}. ` +
          `${CHANGE_REPORT_RULE.our_index}. Drop the source_url, or set reports to vendor_offer ` +
          `and cite a page that shows the vendor's own change.`,
      });
    }

    const unreadable = summaryCallsItsSourceUnreadable(change);
    if (unreadable !== null) {
      errors.push({
        file: "data/deal_changes.json",
        index: i,
        vendor,
        field: "source_url",
        message:
          `This record's summary says "${unreadable}" and it cites ${change.source_url} as its evidence. ` +
          `A record cannot rest on the document it reports as unreadable: cite a page that can be read, or ` +
          `drop the source_url so the record renders as unsourced.`,
      });
    }
  }

  return [...errors, ...uncitedOverBudget(changes)];
}

function uncitedChangeBudget(): number {
  const file = resolve(ROOT, "data/quality_budgets.json");
  const budgets = JSON.parse(readFileSync(file, "utf8")).budgets;
  const budget = budgets?.uncited_change_records;
  if (typeof budget !== "number") {
    throw new Error(`${file} carries no uncited_change_records budget`);
  }
  return budget;
}

function uncitedOverBudget(changes: DealChange[]): ValidationError[] {
  const uncited = changes
    .map((change, index) => ({ change, index }))
    .filter(({ change }) => countsAgainstUncitedBudget(change));
  const budget = uncitedChangeBudget();
  if (uncited.length <= budget) return [];
  return uncited.slice(budget).map(({ change, index }) => ({
    file: "data/deal_changes.json",
    index,
    vendor: change.vendor || `(index ${index})`,
    field: "source_url",
    message:
      `${uncited.length} change records report a vendor's offer and cite no source, over the budget of ${budget} ` +
      `in data/quality_budgets.json. A record with no source_url is withheld from every rating it would set, so a ` +
      `new one may not be written: cite a source here, or retract an existing uncited record and run ` +
      `npm run ratchet:budgets to free the slot. ${UNCITED_CHANGE_BUDGET_RULE}`,
  }));
}

function main(): void {
  const indexPath = resolve(ROOT, "data/index.json");
  const changesPath = resolve(ROOT, "data/deal_changes.json");

  const indexData = JSON.parse(readFileSync(indexPath, "utf8"));
  const changesData = JSON.parse(readFileSync(changesPath, "utf8"));

  const offerErrors = validateOffers(indexData.offers);
  const changeErrors = validateDealChanges(changesData.changes);
  const allErrors = [...offerErrors, ...changeErrors];

  if (allErrors.length === 0) {
    console.log(
      `✓ All data valid. ${indexData.offers.length} offers, ${changesData.changes.length} deal changes.`
    );
    process.exit(0);
  }

  console.error(`Found ${allErrors.length} validation error(s):\n`);
  for (const err of allErrors) {
    console.error(
      `  [${err.file}] index ${err.index} (${err.vendor}): ${err.message}`
    );
  }
  console.error(
    `\n${indexData.offers.length} offers, ${changesData.changes.length} deal changes checked.`
  );
  process.exit(1);
}

export {
  validateOffers,
  validateDealChanges,
  VALID_CATEGORIES,
  type Offer,
  type DealChange,
  type ValidationError,
};

const isMainModule = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));

if (isMainModule) {
  main();
}
