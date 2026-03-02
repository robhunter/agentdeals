#!/usr/bin/env node

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const INDEX_PATH = resolve(ROOT, "data/index.json");
const FREE_FOR_DEV_DIR = resolve(ROOT, ".cache/free-for-dev");
const OUTPUT_PATH = resolve(ROOT, "data/free-for-dev-new.json");

// Categories to exclude (not dev infrastructure)
const EXCLUDED_CATEGORIES = new Set([
  "Education and Career Development",
  "Font",
  "Design Inspiration",
  "Dev Blogging Sites",
  "Browser-based hardware emulation written in Javascript",
  "Remote Desktop Tools",
  "Game Development",
  "Other Free Resources",
]);

// Map free-for-dev categories to our category names
const CATEGORY_MAP: Record<string, string> = {
  "Major Cloud Providers": "Cloud IaaS",
  "Cloud management solutions": "Infrastructure",
  "Source Code Repos": "Developer Tools",
  "APIs, Data, and ML": "Developer Tools",
  "Artifact Repos": "Developer Tools",
  "Tools for Teams and Collaboration": "Developer Tools",
  "CMS": "Headless CMS",
  "Code Generation": "Developer Tools",
  "Code Quality": "Developer Tools",
  "Code Search and Browsing": "Developer Tools",
  "CI and CD": "CI/CD",
  "Testing": "Testing",
  "Security and PKI": "Security",
  "Authentication, Authorization, and User Management": "Auth",
  "Mobile App Distribution and Feedback": "Developer Tools",
  "Management System": "Developer Tools",
  "Messaging and Streaming": "Messaging",
  "Log Management": "Logging",
  "Translation Management": "Developer Tools",
  "Monitoring": "Monitoring",
  "Crash and Exception Handling": "Error Tracking",
  "Search": "Search",
  "Email": "Email",
  "Feature Toggles Management Platforms": "Feature Flags",
  "Forms": "Forms",
  "Generative AI": "AI / ML",
  "CDN and Protection": "CDN",
  "PaaS": "Cloud Hosting",
  "BaaS": "Cloud Hosting",
  "Low-code Platform": "Developer Tools",
  "Web Hosting": "Cloud Hosting",
  "DNS": "DNS & Domain Management",
  "Domain": "DNS & Domain Management",
  "IaaS": "Cloud IaaS",
  "Managed Data Services": "Databases",
  "Tunneling, WebRTC, Web Socket Servers and Other Routers": "Developer Tools",
  "Issue Tracking and Project Management": "Developer Tools",
  "Storage and Media Processing": "Storage",
  "Design and UI": "Design",
  "Data Visualization on Maps": "Maps/Geolocation",
  "Package Build System": "Developer Tools",
  "IDE and Code Editing": "Developer Tools",
  "Analytics, Events and Statistics": "Analytics",
  "Visitor Session Recording": "Analytics",
  "International Mobile Number Verification API and SDK": "Developer Tools",
  "Payment and Billing Integration": "Payments",
  "Docker Related": "Container Registry",
  "Commenting Platforms": "Developer Tools",
  "Screenshot APIs": "Web Scraping",
  "Flutter Related and Building IOS Apps without Mac": "Developer Tools",
  "Privacy Management": "Security",
  "Miscellaneous": "Developer Tools",
};

// Generate tags based on mapped category
const CATEGORY_TAGS: Record<string, string[]> = {
  "Cloud IaaS": ["cloud", "iaas"],
  "Infrastructure": ["infrastructure", "cloud", "management"],
  "Developer Tools": ["developer-tools"],
  "Headless CMS": ["cms", "headless", "content"],
  "CI/CD": ["ci", "cd", "continuous-integration"],
  "Testing": ["testing", "qa"],
  "Security": ["security"],
  "Auth": ["auth", "authentication", "identity"],
  "Messaging": ["messaging", "streaming"],
  "Logging": ["logging", "log-management"],
  "Monitoring": ["monitoring", "observability"],
  "Error Tracking": ["error-tracking", "crash-reporting"],
  "Search": ["search"],
  "Email": ["email"],
  "Feature Flags": ["feature-flags", "feature-toggles"],
  "Forms": ["forms"],
  "AI / ML": ["ai", "ml", "generative-ai"],
  "CDN": ["cdn", "protection"],
  "Cloud Hosting": ["hosting", "paas"],
  "DNS & Domain Management": ["dns", "domain"],
  "Databases": ["database", "data"],
  "Storage": ["storage", "media"],
  "Design": ["design", "ui"],
  "Maps/Geolocation": ["maps", "geolocation"],
  "Analytics": ["analytics", "statistics"],
  "Payments": ["payments", "billing"],
  "Container Registry": ["docker", "containers"],
  "Web Scraping": ["scraping", "screenshots"],
};

interface ParsedEntry {
  vendor: string;
  url: string;
  description: string;
  sourceCategory: string;
  mappedCategory: string;
}

function cloneOrUpdate(): string {
  if (existsSync(FREE_FOR_DEV_DIR)) {
    console.log("Updating existing free-for-dev clone...");
    execSync("git pull", { cwd: FREE_FOR_DEV_DIR, stdio: "pipe" });
  } else {
    console.log("Cloning free-for-dev repo...");
    execSync(`git clone --depth 1 https://github.com/ripienaar/free-for-dev.git ${FREE_FOR_DEV_DIR}`, {
      stdio: "pipe",
    });
  }
  return resolve(FREE_FOR_DEV_DIR, "README.md");
}

function parseReadme(readmePath: string): ParsedEntry[] {
  const content = readFileSync(readmePath, "utf8");
  const lines = content.split("\n");
  const entries: ParsedEntry[] = [];
  let currentCategory = "";

  // Pattern: "  * [Name](url) — description" or "  * [Name](url) - description"
  const entryPattern = /^\s*\*\s+\[([^\]]+)\]\(([^)]+)\)\s*[\u2014\u2013\-:]+\s*(.+)/;

  for (const line of lines) {
    // Detect category headers
    const headerMatch = line.match(/^## (.+)/);
    if (headerMatch) {
      currentCategory = headerMatch[1].trim();
      continue;
    }

    // Skip excluded categories
    if (EXCLUDED_CATEGORIES.has(currentCategory)) continue;

    // Skip unmapped categories
    if (!CATEGORY_MAP[currentCategory]) continue;

    // Parse entry lines
    const entryMatch = line.match(entryPattern);
    if (entryMatch) {
      const [, vendor, url, description] = entryMatch;
      entries.push({
        vendor: vendor.trim(),
        url: url.trim(),
        description: description.trim().replace(/\s+/g, " "),
        sourceCategory: currentCategory,
        mappedCategory: CATEGORY_MAP[currentCategory],
      });
    }
  }

  return entries;
}

function normalizeVendorName(name: string): string {
  return name
    .toLowerCase()
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

function deduplicate(
  parsed: ParsedEntry[],
  existingOffers: any[]
): { newEntries: ParsedEntry[]; duplicates: string[] } {
  // Build lookup sets from existing offers
  const existingNames = new Set(existingOffers.map((o: any) => normalizeVendorName(o.vendor)));
  const existingDomains = new Set(
    existingOffers.map((o: any) => extractDomain(o.url)).filter(Boolean)
  );

  // Also track names we've already added (to avoid dupes within free-for-dev itself)
  const seenNames = new Set<string>();
  const newEntries: ParsedEntry[] = [];
  const duplicates: string[] = [];

  for (const entry of parsed) {
    const normalized = normalizeVendorName(entry.vendor);
    const domain = extractDomain(entry.url);

    if (existingNames.has(normalized) || (domain && existingDomains.has(domain)) || seenNames.has(normalized)) {
      duplicates.push(entry.vendor);
      continue;
    }

    seenNames.add(normalized);
    newEntries.push(entry);
  }

  return { newEntries, duplicates };
}

function toOfferFormat(entry: ParsedEntry, today: string) {
  const baseTags = CATEGORY_TAGS[entry.mappedCategory] || ["developer-tools"];
  // Add source tag
  const tags = [...baseTags, "free-for-dev"];

  return {
    vendor: entry.vendor,
    category: entry.mappedCategory,
    description: entry.description,
    tier: "Free",
    url: entry.url,
    tags,
    verifiedDate: today,
  };
}

async function checkUrls(entries: ParsedEntry[]): Promise<{ live: ParsedEntry[]; dead: string[] }> {
  const TIMEOUT_MS = 10000;
  const CONCURRENCY = 20;
  const live: ParsedEntry[] = [];
  const dead: string[] = [];

  // Process in batches
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
          // Retry with GET for servers that reject HEAD
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
        // Promise rejected — shouldn't happen with allSettled but just in case
        dead.push("unknown");
      }
    }

    if (i + CONCURRENCY < entries.length) {
      // Small delay between batches to avoid rate limiting
      await new Promise((r) => setTimeout(r, 500));
    }
  }

  return { live, dead };
}

async function main() {
  const skipUrlCheck = process.argv.includes("--skip-url-check");
  const dryRun = process.argv.includes("--dry-run");

  console.log("=== free-for-dev Ingestion Script ===\n");

  // Step 1: Clone/update
  const readmePath = cloneOrUpdate();
  console.log(`Parsing ${readmePath}...\n`);

  // Step 2: Parse
  const parsed = parseReadme(readmePath);
  console.log(`Parsed ${parsed.length} entries from free-for-dev\n`);

  // Step 3: Load existing index
  const index = JSON.parse(readFileSync(INDEX_PATH, "utf8"));
  console.log(`Existing index: ${index.offers.length} offers\n`);

  // Step 4: Deduplicate
  const { newEntries, duplicates } = deduplicate(parsed, index.offers);
  console.log(`After deduplication: ${newEntries.length} new, ${duplicates.length} duplicates\n`);

  // Step 5: URL health check
  let finalEntries: ParsedEntry[];
  if (skipUrlCheck) {
    console.log("Skipping URL health checks (--skip-url-check)\n");
    finalEntries = newEntries;
  } else {
    console.log(`Checking ${newEntries.length} URLs...\n`);
    const { live, dead } = await checkUrls(newEntries);
    console.log(`URL check: ${live.length} live, ${dead.length} dead/unreachable\n`);
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
  console.log("Category breakdown of new entries:");
  for (const [cat, count] of Object.entries(categoryCounts).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${cat}: ${count}`);
  }
  console.log();

  // Step 7: Output
  writeFileSync(OUTPUT_PATH, JSON.stringify({ offers }, null, 2));
  console.log(`Wrote ${offers.length} new entries to ${OUTPUT_PATH}`);

  if (!dryRun && offers.length > 0) {
    // Merge into index
    index.offers.push(...offers);
    writeFileSync(INDEX_PATH, JSON.stringify(index, null, 2) + "\n");
    console.log(`\nMerged into index. New total: ${index.offers.length} offers`);
  } else if (dryRun) {
    console.log(`\nDry run — not modifying index. Review ${OUTPUT_PATH} and re-run without --dry-run to merge.`);
  }

  // Summary
  console.log("\n=== Summary ===");
  console.log(`Source entries parsed: ${parsed.length}`);
  console.log(`Duplicates skipped: ${duplicates.length}`);
  console.log(`Dead URLs filtered: ${newEntries.length - finalEntries.length}`);
  console.log(`Net new entries: ${offers.length}`);
  console.log(`Categories covered: ${Object.keys(categoryCounts).length}`);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
