#!/usr/bin/env node

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const INDEX_PATH = resolve(ROOT, "data/index.json");
const CACHE_DIR = resolve(ROOT, ".cache");
const AWESOME_DIR = resolve(CACHE_DIR, "awesome-startup-credits");
const STARTUPDEALS_DIR = resolve(CACHE_DIR, "startupdeals");
const OUTPUT_PATH = resolve(ROOT, "data/startup-deals-new.json");

// Map awesome-startup-credits categories to our categories
const AWESOME_CATEGORY_MAP: Record<string, string> = {
  Advertising: "Developer Tools",
  Analytics: "Analytics",
  "Bug Tracking": "Error Tracking",
  "Business Suites": "Developer Tools",
  "Cloud Computing": "Cloud IaaS",
  "Cloud Database": "Databases",
  "Cloud Telephony": "Communication",
  "Customer Engagement": "Communication",
  "Edge Computing": "Cloud Hosting",
  "Email Delivery": "Email",
  Hardware: "Developer Tools",
  "Incident Management": "Monitoring",
  Payments: "Payments",
  "Marketing and Sales": "Developer Tools",
  Video: "Video",
  Miscellaneous: "Developer Tools",
};

// Tags for each mapped category
const CATEGORY_TAGS: Record<string, string[]> = {
  "Developer Tools": ["developer-tools"],
  Analytics: ["analytics", "statistics"],
  "Error Tracking": ["error-tracking", "bug-tracking"],
  "Cloud IaaS": ["cloud", "iaas"],
  Databases: ["database", "data"],
  Communication: ["communication"],
  "Cloud Hosting": ["hosting", "paas"],
  Email: ["email"],
  Monitoring: ["monitoring", "incident-management"],
  Payments: ["payments", "billing"],
  Video: ["video"],
};

interface ParsedEntry {
  vendor: string;
  url: string;
  description: string;
  source: string;
  mappedCategory: string;
  eligibilityType: string;
  conditions: string[];
  program: string;
}

function cloneOrUpdate(repoUrl: string, targetDir: string): void {
  if (existsSync(targetDir)) {
    console.log(`  Updating ${targetDir}...`);
    execSync("git pull", { cwd: targetDir, stdio: "pipe" });
  } else {
    console.log(`  Cloning ${repoUrl}...`);
    execSync(`git clone --depth 1 ${repoUrl} ${targetDir}`, { stdio: "pipe" });
  }
}

function parseAwesomeStartupCredits(): ParsedEntry[] {
  // Try README.md (uppercase)
  let readmePath = resolve(AWESOME_DIR, "README.md");
  if (!existsSync(readmePath)) {
    readmePath = resolve(AWESOME_DIR, "readme.md");
  }
  const content = readFileSync(readmePath, "utf8");
  const lines = content.split("\n");
  const entries: ParsedEntry[] = [];
  let currentCategory = "";
  let inDiscontinued = false;

  // Pattern: - [Name](url) - Description
  const entryPattern = /^\s*-\s+\[([^\]]+)\]\(([^)]+)\)\s*[\u2014\u2013\-]+\s*(.+)/;

  for (const line of lines) {
    // Detect category headers (h3)
    const h3Match = line.match(/^###\s+(.+)/);
    if (h3Match) {
      currentCategory = h3Match[1].trim();
      continue;
    }

    // Detect discontinued section
    const h2Match = line.match(/^##\s+(.+)/);
    if (h2Match) {
      if (h2Match[1].trim().toLowerCase().includes("discontinued")) {
        inDiscontinued = true;
      }
      continue;
    }

    // Skip discontinued entries
    if (inDiscontinued) continue;

    // Skip unmapped categories
    if (!AWESOME_CATEGORY_MAP[currentCategory]) continue;

    const entryMatch = line.match(entryPattern);
    if (entryMatch) {
      const [, vendor, url, description] = entryMatch;

      // Extract eligibility from description
      const conditions: string[] = [];
      const descLower = description.toLowerCase();
      let eligType = "startup";

      if (
        descLower.includes("y combinator") ||
        descLower.includes("accelerator") ||
        descLower.includes("incubator")
      ) {
        eligType = "accelerator";
        conditions.push("Accelerator/incubator membership required");
      }
      if (descLower.includes("raised less than") || descLower.includes("funding")) {
        const fundingMatch = description.match(/raised?\s+(?:less than\s+)?\$[\d,.]+[MKB]?/i);
        if (fundingMatch) conditions.push(fundingMatch[0]);
      }
      if (descLower.includes("employee") || descLower.includes("team size")) {
        const empMatch = description.match(/(?:under|less than|up to)\s+\d+\s+employees?/i);
        if (empMatch) conditions.push(empMatch[0]);
      }
      if (descLower.includes("incorporated") || descLower.includes("launched")) {
        const ageMatch = description.match(
          /(?:incorporated|launched|founded)\s+(?:less than\s+)?\d+\s+years?\s+ago/i
        );
        if (ageMatch) conditions.push(ageMatch[0]);
      }

      if (conditions.length === 0) {
        conditions.push("Startup program — check vendor for eligibility details");
      }

      entries.push({
        vendor: vendor.trim(),
        url: url.trim(),
        description: description.trim().replace(/\s+/g, " "),
        source: "awesome-startup-credits",
        mappedCategory: AWESOME_CATEGORY_MAP[currentCategory],
        eligibilityType: eligType,
        conditions,
        program: `${vendor.trim()} Startup Program`,
      });
    }
  }

  return entries;
}

function parseStartupDeals(): ParsedEntry[] {
  // Try readme.md (lowercase)
  let readmePath = resolve(STARTUPDEALS_DIR, "readme.md");
  if (!existsSync(readmePath)) {
    readmePath = resolve(STARTUPDEALS_DIR, "README.md");
  }
  const content = readFileSync(readmePath, "utf8");
  const lines = content.split("\n");
  const entries: ParsedEntry[] = [];

  // Pattern: | [Company](url) | Deal description | Conditions |
  const tableRowPattern = /^\|\s*\[([^\]]+)\]\(([^)]+)\)\s*\|\s*(.+?)\s*\|\s*(.+?)\s*\|/;

  for (const line of lines) {
    // Skip header and separator rows
    if (line.includes("Company") && line.includes("Deal") && line.includes("Conditions")) continue;
    if (/^\|[\s\-:]+\|/.test(line)) continue;

    const match = line.match(tableRowPattern);
    if (match) {
      const [, vendor, sourceUrl, deal, conditions] = match;

      // Skip entries that are paid-only (no free component)
      const condLower = conditions.toLowerCase();
      if (condLower.includes("$") && !condLower.includes("free")) {
        // Has a cost but no free mention — skip
        continue;
      }

      // The URL in startupdeals points to the deal source, not the vendor
      // Try to extract vendor URL from the vendor name
      const vendorClean = vendor.trim();
      const description = `${deal.trim()}. Access via: ${conditions.trim()}`;

      entries.push({
        vendor: vendorClean,
        url: sourceUrl.trim(),
        description: description.replace(/\s+/g, " "),
        source: "startupdeals",
        mappedCategory: guessCategory(deal, vendorClean),
        eligibilityType: "startup",
        conditions: [conditions.trim()],
        program: `${vendorClean} Startup Deal`,
      });
    }
  }

  return entries;
}

function normalizeVendorName(name: string): string {
  return name
    .toLowerCase()
    .replace(/\s+for\s+startups?$/i, "")
    .replace(/\s+startup\s+program$/i, "")
    .replace(/\s+(?:free|credits?|deal)$/i, "")
    .replace(/\.(com|io|dev|sh|ai|co|org|net|app|cloud|so)$/i, "")
    .replace(/[^a-z0-9]/g, "")
    .trim();
}

function extractDomain(url: string): string {
  try {
    const hostname = new URL(url).hostname;
    return hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return "";
  }
}

function guessCategory(description: string, vendor: string): string {
  const text = `${vendor} ${description}`.toLowerCase();

  if (text.includes("cloud") || text.includes("aws") || text.includes("azure") || text.includes("gcp"))
    return "Cloud IaaS";
  if (text.includes("database") || text.includes("db") || text.includes("sql")) return "Databases";
  if (text.includes("email") || text.includes("sendgrid") || text.includes("mailgun")) return "Email";
  if (text.includes("analytics") || text.includes("mixpanel") || text.includes("amplitude"))
    return "Analytics";
  if (text.includes("hosting") || text.includes("heroku") || text.includes("deploy"))
    return "Cloud Hosting";
  if (text.includes("monitoring") || text.includes("apm") || text.includes("observ")) return "Monitoring";
  if (text.includes("payment") || text.includes("stripe") || text.includes("billing")) return "Payments";
  if (text.includes("ci/cd") || text.includes("pipeline") || text.includes("build")) return "CI/CD";
  if (text.includes("auth") || text.includes("identity") || text.includes("sso")) return "Auth";
  if (text.includes("security") || text.includes("vuln")) return "Security";
  if (text.includes("crm") || text.includes("customer") || text.includes("engagement"))
    return "Communication";
  if (text.includes("design") || text.includes("figma") || text.includes("sketch")) return "Design";
  if (text.includes("search") || text.includes("algolia")) return "Search";
  if (text.includes("storage") || text.includes("cdn") || text.includes("s3")) return "Storage";
  if (text.includes("log") || text.includes("logging")) return "Logging";

  return "Developer Tools";
}

function deduplicate(
  parsed: ParsedEntry[],
  existingOffers: any[]
): { newEntries: ParsedEntry[]; duplicates: string[] } {
  const existingNames = new Set(existingOffers.map((o: any) => normalizeVendorName(o.vendor)));
  const existingDomains = new Set(
    existingOffers.map((o: any) => extractDomain(o.url)).filter(Boolean)
  );

  const seenNames = new Set<string>();
  const newEntries: ParsedEntry[] = [];
  const duplicates: string[] = [];

  for (const entry of parsed) {
    const normalized = normalizeVendorName(entry.vendor);

    if (existingNames.has(normalized) || seenNames.has(normalized)) {
      duplicates.push(entry.vendor);
      continue;
    }

    // For startupdeals, URLs point to deal sources not vendor sites — skip domain check
    if (entry.source !== "startupdeals") {
      const domain = extractDomain(entry.url);
      if (domain && existingDomains.has(domain)) {
        duplicates.push(entry.vendor);
        continue;
      }
    }

    seenNames.add(normalized);
    newEntries.push(entry);
  }

  return { newEntries, duplicates };
}

function toOfferFormat(entry: ParsedEntry, today: string) {
  const category = entry.mappedCategory;
  const baseTags = CATEGORY_TAGS[category] || ["developer-tools"];
  const tags = [...baseTags, "startup-credits", entry.source];

  return {
    vendor: entry.vendor,
    category,
    description: entry.description,
    tier: "Startup Program",
    url: entry.url,
    tags,
    verifiedDate: today,
    eligibility: {
      type: entry.eligibilityType,
      conditions: entry.conditions,
      program: entry.program,
    },
  };
}

async function checkUrls(entries: ParsedEntry[]): Promise<{ live: ParsedEntry[]; dead: string[] }> {
  const TIMEOUT_MS = 10000;
  const CONCURRENCY = 20;
  const live: ParsedEntry[] = [];
  const dead: string[] = [];

  for (let i = 0; i < entries.length; i += CONCURRENCY) {
    const batch = entries.slice(i, i + CONCURRENCY);
    const results = await Promise.allSettled(
      batch.map(async (entry) => {
        try {
          const controller = new AbortController();
          const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
          const resp = await fetch(entry.url, {
            method: "HEAD",
            signal: controller.signal,
            redirect: "follow",
            headers: { "User-Agent": "AgentDeals/1.0 (https://github.com/robhunter/agentdeals)" },
          });
          clearTimeout(timeout);
          return { entry, ok: resp.ok || resp.status === 403 || resp.status === 405 };
        } catch {
          try {
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
            const resp = await fetch(entry.url, {
              method: "GET",
              signal: controller.signal,
              redirect: "follow",
              headers: { "User-Agent": "AgentDeals/1.0 (https://github.com/robhunter/agentdeals)" },
            });
            clearTimeout(timeout);
            return { entry, ok: resp.ok || resp.status === 403 };
          } catch {
            return { entry, ok: false };
          }
        }
      })
    );

    for (const result of results) {
      if (result.status === "fulfilled" && result.value.ok) {
        live.push(result.value.entry);
      } else if (result.status === "fulfilled") {
        dead.push(result.value.entry.vendor + " (" + result.value.entry.url + ")");
      } else {
        dead.push("unknown");
      }
    }

    if (i + CONCURRENCY < entries.length) {
      await new Promise((r) => setTimeout(r, 500));
    }
  }

  return { live, dead };
}

async function main() {
  const skipUrlCheck = process.argv.includes("--skip-url-check");
  const dryRun = process.argv.includes("--dry-run");

  console.log("=== Startup Deals Ingestion Script ===\n");

  // Step 1: Clone/update repos
  console.log("Step 1: Fetching source repos...");
  cloneOrUpdate("https://github.com/dakshshah96/awesome-startup-credits.git", AWESOME_DIR);
  cloneOrUpdate("https://github.com/startupdeals/startupdeals.git", STARTUPDEALS_DIR);
  console.log();

  // Step 2: Parse both sources
  console.log("Step 2: Parsing entries...");
  const awesomeEntries = parseAwesomeStartupCredits();
  console.log(`  awesome-startup-credits: ${awesomeEntries.length} entries`);

  const startupDealsEntries = parseStartupDeals();
  console.log(`  startupdeals: ${startupDealsEntries.length} entries`);

  // Combine — awesome-startup-credits first (higher quality data)
  const allParsed = [...awesomeEntries, ...startupDealsEntries];
  console.log(`  Total parsed: ${allParsed.length} entries\n`);

  // Step 3: Load existing index
  const index = JSON.parse(readFileSync(INDEX_PATH, "utf8"));
  console.log(`Step 3: Existing index has ${index.offers.length} offers\n`);

  // Step 4: Deduplicate
  const { newEntries, duplicates } = deduplicate(allParsed, index.offers);
  console.log(`Step 4: After deduplication: ${newEntries.length} new, ${duplicates.length} duplicates\n`);

  // Step 5: URL health check
  let finalEntries: ParsedEntry[];
  if (skipUrlCheck) {
    console.log("Step 5: Skipping URL health checks (--skip-url-check)\n");
    finalEntries = newEntries;
  } else {
    console.log(`Step 5: Checking ${newEntries.length} URLs...`);
    const { live, dead } = await checkUrls(newEntries);
    console.log(`  ${live.length} live, ${dead.length} dead/unreachable\n`);
    if (dead.length > 0) {
      console.log("Dead URLs:");
      for (const d of dead.slice(0, 20)) console.log(`  - ${d}`);
      if (dead.length > 20) console.log(`  ... and ${dead.length - 20} more`);
      console.log();
    }
    finalEntries = live;
  }

  // Step 6: Convert to offer format
  const today = new Date().toISOString().split("T")[0];
  const offers = finalEntries.map((e) => toOfferFormat(e, today));

  // Category breakdown
  const categoryCounts: Record<string, number> = {};
  for (const o of offers) {
    categoryCounts[o.category] = (categoryCounts[o.category] || 0) + 1;
  }
  console.log("Step 6: Category breakdown of new entries:");
  for (const [cat, count] of Object.entries(categoryCounts).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${cat}: ${count}`);
  }
  console.log();

  // Source breakdown
  const sourceCounts: Record<string, number> = {};
  for (const e of finalEntries) {
    sourceCounts[e.source] = (sourceCounts[e.source] || 0) + 1;
  }
  console.log("Source breakdown:");
  for (const [src, count] of Object.entries(sourceCounts)) {
    console.log(`  ${src}: ${count}`);
  }
  console.log();

  // Step 7: Output
  writeFileSync(OUTPUT_PATH, JSON.stringify({ offers }, null, 2));
  console.log(`Wrote ${offers.length} new entries to ${OUTPUT_PATH}`);

  if (!dryRun && offers.length > 0) {
    index.offers.push(...offers);
    writeFileSync(INDEX_PATH, JSON.stringify(index, null, 2) + "\n");
    console.log(`\nMerged into index. New total: ${index.offers.length} offers`);
  } else if (dryRun) {
    console.log(
      `\nDry run — not modifying index. Review ${OUTPUT_PATH} and re-run without --dry-run to merge.`
    );
  }

  // Summary
  console.log("\n=== Summary ===");
  console.log(`Source entries parsed: ${allParsed.length}`);
  console.log(`Duplicates skipped: ${duplicates.length}`);
  console.log(`Dead URLs filtered: ${newEntries.length - finalEntries.length}`);
  console.log(`Net new entries: ${offers.length}`);
  console.log(`Categories covered: ${Object.keys(categoryCounts).length}`);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
