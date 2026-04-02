#!/usr/bin/env node

import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

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
  date: string;
  summary: string;
  previous_state: string;
  current_state: string;
  impact: string;
  source_url: string;
  category: string;
  alternatives: string[];
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
];

function validateOffers(offers: Offer[]): ValidationError[] {
  const errors: ValidationError[] = [];
  const seen = new Map<string, number>();

  for (let i = 0; i < offers.length; i++) {
    const offer = offers[i];
    const vendor = offer.vendor || `(index ${i})`;

    // Required fields
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

    // URL format
    if (offer.url && !URL_REGEX.test(offer.url)) {
      errors.push({
        file: "data/index.json",
        index: i,
        vendor,
        field: "url",
        message: `Invalid URL format: ${offer.url}`,
      });
    }

    // Description length
    if (offer.description && offer.description.length < 30) {
      errors.push({
        file: "data/index.json",
        index: i,
        vendor,
        field: "description",
        message: `Description too short (${offer.description.length} chars, min 30): "${offer.description}"`,
      });
    }

    // verifiedDate format
    if (offer.verifiedDate && !ISO_DATE_REGEX.test(offer.verifiedDate)) {
      errors.push({
        file: "data/index.json",
        index: i,
        vendor,
        field: "verifiedDate",
        message: `Invalid date format (expected YYYY-MM-DD): ${offer.verifiedDate}`,
      });
    }

    // Valid verifiedDate
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

    // Category validation
    if (offer.category && !VALID_CATEGORIES.includes(offer.category)) {
      errors.push({
        file: "data/index.json",
        index: i,
        vendor,
        field: "category",
        message: `Unknown category: "${offer.category}"`,
      });
    }

    // Duplicate detection (same vendor + category)
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

    // Required fields
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

    // Date format
    if (change.date && !ISO_DATE_REGEX.test(change.date)) {
      errors.push({
        file: "data/deal_changes.json",
        index: i,
        vendor,
        field: "date",
        message: `Invalid date format (expected YYYY-MM-DD): ${change.date}`,
      });
    }

    // Source URL format
    if (change.source_url && !URL_REGEX.test(change.source_url)) {
      errors.push({
        file: "data/deal_changes.json",
        index: i,
        vendor,
        field: "source_url",
        message: `Invalid URL format: ${change.source_url}`,
      });
    }
  }

  return errors;
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

// Export for testing
export {
  validateOffers,
  validateDealChanges,
  VALID_CATEGORIES,
  type Offer,
  type DealChange,
  type ValidationError,
};

main();
