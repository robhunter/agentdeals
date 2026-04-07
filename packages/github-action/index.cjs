#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const https = require("https");

const API_BASE = "https://agentdeals.dev";
const VENDOR_MAP_PATH = path.join(__dirname, "package-vendor-map.json");

// --- Dependency parsing ---

function parseDependencies(packageJsonPath) {
  const raw = fs.readFileSync(packageJsonPath, "utf8");
  const pkg = JSON.parse(raw);
  const deps = Object.keys(pkg.dependencies || {});
  const devDeps = Object.keys(pkg.devDependencies || {});
  return [...new Set([...deps, ...devDeps])];
}

// --- Vendor mapping ---

function loadVendorMap() {
  const raw = fs.readFileSync(VENDOR_MAP_PATH, "utf8");
  return JSON.parse(raw).mappings;
}

function matchDependenciesToVendors(deps, mappings) {
  const matched = new Map(); // vendor -> [packages]

  for (const dep of deps) {
    for (const mapping of mappings) {
      const pattern = mapping.pattern;
      let isMatch = false;

      if (pattern.endsWith("/*")) {
        // Scope pattern: @scope/* matches @scope/anything
        const scope = pattern.slice(0, -2);
        isMatch = dep.startsWith(scope + "/");
      } else {
        // Exact match
        isMatch = dep === pattern;
      }

      if (isMatch) {
        const existing = matched.get(mapping.vendor) || [];
        existing.push(dep);
        matched.set(mapping.vendor, existing);
        break; // First match wins for this dep
      }
    }
  }

  return matched;
}

// --- API integration ---

function fetchJSON(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { "User-Agent": "agentdeals-github-action/1.0" } }, (res) => {
      let data = "";
      res.on("data", (chunk) => { data += chunk; });
      res.on("end", () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try {
            resolve(JSON.parse(data));
          } catch (e) {
            reject(new Error(`Invalid JSON from ${url}`));
          }
        } else if (res.statusCode === 429) {
          reject(new Error(`Rate limited (429) from ${url}`));
        } else {
          reject(new Error(`HTTP ${res.statusCode} from ${url}`));
        }
      });
    });
    req.on("error", reject);
    req.setTimeout(10000, () => { req.destroy(); reject(new Error(`Timeout fetching ${url}`)); });
  });
}

async function fetchVendorData(vendorName) {
  const encoded = encodeURIComponent(vendorName);
  const url = `${API_BASE}/api/offers?q=${encoded}&limit=5`;
  const data = await fetchJSON(url);
  const offers = data.offers || [];
  // Find exact or close match
  const exact = offers.find((o) => o.vendor.toLowerCase() === vendorName.toLowerCase());
  return exact || offers[0] || null;
}

async function fetchAllVendorData(vendorNames, delayMs = 200) {
  const results = new Map();
  for (const vendor of vendorNames) {
    try {
      const data = await fetchVendorData(vendor);
      results.set(vendor, data);
    } catch (err) {
      console.warn(`Warning: Failed to fetch data for ${vendor}: ${err.message}`);
      results.set(vendor, null);
    }
    // Rate limit courtesy delay
    if (delayMs > 0) {
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  return results;
}

// --- Output formatting ---

const STABILITY_ICONS = {
  stable: "\u2705 Stable",
  watch: "\u26a0\ufe0f Watch",
  volatile: "\ud83d\udea8 Volatile",
  improving: "\ud83d\udcc8 Improving",
};

function stabilityLevel(s) {
  const levels = { stable: 0, improving: 1, watch: 2, volatile: 3 };
  return levels[s] ?? 0;
}

function meetsThreshold(stability, threshold) {
  return stabilityLevel(stability) >= stabilityLevel(threshold);
}

function formatSummaryTable(vendorDataMap, vendorPackagesMap) {
  const lines = [];
  lines.push("## \ud83d\udd0d Free Tier Monitor Report\n");
  lines.push(`Found **${vendorDataMap.size}** vendors from your dependencies:\n`);
  lines.push("| Vendor | Free Tier | Stability | Recent Change |");
  lines.push("|--------|-----------|-----------|---------------|");

  const alertVendors = [];

  for (const [vendor, data] of vendorDataMap) {
    const packages = vendorPackagesMap.get(vendor) || [];
    const pkgNote = packages.length > 0 ? ` (${packages.join(", ")})` : "";

    if (!data) {
      lines.push(`| ${vendor}${pkgNote} | _Not found_ | — | — |`);
      continue;
    }

    const description = data.description
      ? data.description.length > 60
        ? data.description.slice(0, 57) + "..."
        : data.description
      : "—";
    const stability = data.stability || "stable";
    const stabilityText = STABILITY_ICONS[stability] || stability;
    const recentChange = data.recent_change || "—";

    lines.push(`| [${vendor}](${API_BASE}/vendor/${slugify(vendor)})${pkgNote} | ${description} | ${stabilityText} | ${recentChange} |`);

    if (stability === "watch" || stability === "volatile") {
      alertVendors.push({ vendor, stability, recentChange });
    }
  }

  lines.push("");

  if (alertVendors.length > 0) {
    lines.push(`\u26a0\ufe0f **${alertVendors.length}** vendor${alertVendors.length === 1 ? "" : "s"} ha${alertVendors.length === 1 ? "s" : "ve"} an elevated stability rating. Review before committing to long-term use.\n`);
  } else {
    lines.push("\u2705 All vendor free tiers are stable. No action needed.\n");
  }

  lines.push(`*Data from [AgentDeals](${API_BASE}) \u2014 verified within 30 days*`);

  return { markdown: lines.join("\n"), alertVendors };
}

function formatPRComment(vendorDataMap, vendorPackagesMap, threshold) {
  // Only include vendors meeting the alert threshold
  const alertVendors = [];
  for (const [vendor, data] of vendorDataMap) {
    if (!data) continue;
    const stability = data.stability || "stable";
    if (meetsThreshold(stability, threshold)) {
      alertVendors.push({
        vendor,
        stability,
        description: data.description || "—",
        recentChange: data.recent_change || "—",
        packages: vendorPackagesMap.get(vendor) || [],
      });
    }
  }

  if (alertVendors.length === 0) return null;

  const lines = [];
  lines.push("## \ud83d\udd0d Free Tier Monitor Alert\n");
  lines.push(`**${alertVendors.length}** dependency vendor${alertVendors.length === 1 ? "" : "s"} ha${alertVendors.length === 1 ? "s" : "ve"} an elevated stability rating:\n`);
  lines.push("| Vendor | Packages | Stability | Recent Change |");
  lines.push("|--------|----------|-----------|---------------|");

  for (const v of alertVendors) {
    const stabilityText = STABILITY_ICONS[v.stability] || v.stability;
    lines.push(`| [${v.vendor}](${API_BASE}/vendor/${slugify(v.vendor)}) | ${v.packages.join(", ")} | ${stabilityText} | ${v.recentChange} |`);
  }

  lines.push("");
  lines.push(`Review these vendors' free tier terms before depending on them in production.\n`);
  lines.push(`*Data from [AgentDeals](${API_BASE}) \u2014 verified within 30 days*`);

  return lines.join("\n");
}

function slugify(str) {
  return str
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

// --- GitHub Actions integration ---

function getInput(name, defaultValue) {
  const envKey = `INPUT_${name.replace(/-/g, "_").toUpperCase()}`;
  return process.env[envKey] || defaultValue;
}

function setOutput(name, value) {
  const outputFile = process.env.GITHUB_OUTPUT;
  if (outputFile) {
    fs.appendFileSync(outputFile, `${name}=${value}\n`);
  }
}

function writeSummary(markdown) {
  const summaryFile = process.env.GITHUB_STEP_SUMMARY;
  if (summaryFile) {
    fs.appendFileSync(summaryFile, markdown + "\n");
  }
}

async function postPRComment(body) {
  const token = process.env.GITHUB_TOKEN;
  const eventPath = process.env.GITHUB_EVENT_PATH;
  if (!token || !eventPath) return false;

  let event;
  try {
    event = JSON.parse(fs.readFileSync(eventPath, "utf8"));
  } catch {
    return false;
  }

  const prNumber = event.pull_request?.number || event.number;
  const repo = process.env.GITHUB_REPOSITORY;
  if (!prNumber || !repo) return false;

  const url = `https://api.github.com/repos/${repo}/issues/${prNumber}/comments`;
  const postData = JSON.stringify({ body });

  return new Promise((resolve) => {
    const urlObj = new URL(url);
    const req = https.request(
      {
        hostname: urlObj.hostname,
        path: urlObj.pathname,
        method: "POST",
        headers: {
          "User-Agent": "agentdeals-github-action/1.0",
          Authorization: `token ${token}`,
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(postData),
        },
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => { data += chunk; });
        res.on("end", () => resolve(res.statusCode >= 200 && res.statusCode < 300));
      }
    );
    req.on("error", () => resolve(false));
    req.write(postData);
    req.end();
  });
}

// --- Main ---

async function run() {
  const packageJsonPath = getInput("package-json-path", "./package.json");
  const postPrComment = getInput("post-pr-comment", "true") === "true";
  const alertThreshold = getInput("alert-threshold", "watch");

  console.log(`\ud83d\udd0d Free Tier Monitor`);
  console.log(`  Package path: ${packageJsonPath}`);
  console.log(`  Alert threshold: ${alertThreshold}`);
  console.log(`  PR comments: ${postPrComment}`);

  // Parse dependencies
  const resolvedPath = path.resolve(packageJsonPath);
  if (!fs.existsSync(resolvedPath)) {
    console.error(`\u274c package.json not found at ${resolvedPath}`);
    process.exitCode = 1;
    return;
  }

  const deps = parseDependencies(resolvedPath);
  console.log(`\n\ud83d\udce6 Found ${deps.length} dependencies`);

  // Match to vendors
  const mappings = loadVendorMap();
  const vendorPackagesMap = matchDependenciesToVendors(deps, mappings);
  console.log(`\ud83c\udfaf Matched ${vendorPackagesMap.size} vendors: ${[...vendorPackagesMap.keys()].join(", ")}`);

  if (vendorPackagesMap.size === 0) {
    console.log("\nNo recognized vendors found in dependencies. Nothing to report.");
    const emptyReport = "## \ud83d\udd0d Free Tier Monitor Report\n\nNo recognized vendors found in your dependencies.\n\n*Data from [AgentDeals](https://agentdeals.dev)*";
    writeSummary(emptyReport);
    setOutput("vendor-count", "0");
    setOutput("alert-count", "0");
    return;
  }

  // Fetch vendor data from API
  console.log("\n\ud83c\udf10 Fetching vendor data from AgentDeals API...");
  const vendorDataMap = await fetchAllVendorData([...vendorPackagesMap.keys()]);

  // Generate summary
  const { markdown, alertVendors } = formatSummaryTable(vendorDataMap, vendorPackagesMap);
  console.log("\n" + markdown);

  // Write to GitHub step summary
  writeSummary(markdown);
  setOutput("vendor-count", String(vendorDataMap.size));
  setOutput("alert-count", String(alertVendors.length));

  // Post PR comment if applicable
  if (postPrComment && process.env.GITHUB_EVENT_NAME === "pull_request") {
    const commentBody = formatPRComment(vendorDataMap, vendorPackagesMap, alertThreshold);
    if (commentBody) {
      console.log("\n\ud83d\udcac Posting PR comment...");
      const ok = await postPRComment(commentBody);
      console.log(ok ? "\u2705 PR comment posted." : "\u26a0\ufe0f Failed to post PR comment.");
    } else {
      console.log("\n\u2705 No vendors above alert threshold \u2014 skipping PR comment.");
    }
  }
}

// --- Exports for testing ---

module.exports = {
  parseDependencies,
  loadVendorMap,
  matchDependenciesToVendors,
  fetchVendorData,
  fetchAllVendorData,
  formatSummaryTable,
  formatPRComment,
  slugify,
  meetsThreshold,
  stabilityLevel,
  getInput,
};

// Run if executed directly
if (require.main === module) {
  run().catch((err) => {
    console.error(`\u274c ${err.message}`);
    process.exitCode = 1;
  });
}
