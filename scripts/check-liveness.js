#!/usr/bin/env node

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  classifyHttpStatus,
  classifyNetworkError,
  isTerminalStatus,
  LINK_GRACE_DAYS,
} from "../dist/link-health.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const INDEX_PATH = resolve(__dirname, "..", "data", "index.json");
const HEALTH_PATH = resolve(__dirname, "..", "data", "link_health.json");

const USER_AGENT = "AgentDeals-Liveness/1.0 (+https://agentdeals.dev)";
const FETCH_TIMEOUT_MS = 15000;
const HOST_CONCURRENCY = 8;
const SAME_HOST_DELAY_MS = 1200;

const HELP = `Link liveness — asks whether each catalog URL still resolves, which is a
separate and much cheaper question than whether its terms are still right.
Runs over every record on every run, regardless of verifiedDate.

Three outcomes, and the distinction between the last two is the point:

  reachable    2xx or 3xx.
  unreachable  404, 410, or a hostname that does not resolve. Evidence about
               the destination. Past a ${LINK_GRACE_DAYS}-day grace window it suppresses the
               risk badge and the verification date on the vendor page.
  unknown      403, 429, 5xx, timeouts. Evidence that this checker was
               refused, which is not evidence about the vendor. Publishes
               nothing in either direction and changes no page.

Usage:
  node scripts/check-liveness.js                 check every record
  node scripts/check-liveness.js --limit 50      first 50 distinct URLs
  node scripts/check-liveness.js --dry-run       report only, write nothing
  node scripts/check-liveness.js --report        print the delisting queue
`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function hostOf(url) {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

async function request(url, method) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method,
      signal: controller.signal,
      redirect: "follow",
      headers: { "User-Agent": USER_AGENT, Accept: "text/html,*/*" },
    });
    return { status: res.status };
  } catch (err) {
    const code = err.name === "AbortError" ? "TIMEOUT" : (err.cause?.code ?? err.code ?? "FETCH_FAILED");
    return { errorCode: code };
  } finally {
    clearTimeout(timer);
  }
}

export async function checkLiveness(url) {
  const head = await request(url, "HEAD");

  if (head.status !== undefined && classifyHttpStatus(head.status) === "reachable") {
    return { outcome: "reachable", detail: `HEAD ${head.status}`, terminal: false };
  }

  const get = await request(url, "GET");

  if (get.status !== undefined) {
    return {
      outcome: classifyHttpStatus(get.status),
      detail: `GET ${get.status}`,
      terminal: isTerminalStatus(get.status),
    };
  }

  return {
    outcome: classifyNetworkError(get.errorCode),
    detail: `GET ${get.errorCode}`,
    terminal: false,
  };
}

function collectUrls(offers) {
  const byUrl = new Map();
  for (const offer of offers) {
    if (typeof offer.url !== "string" || offer.url.length === 0) continue;
    const seen = byUrl.get(offer.url);
    const verified = offer.verifiedDate ?? null;
    if (!seen) {
      byUrl.set(offer.url, { url: offer.url, latestVerified: verified, vendors: [offer.vendor] });
      continue;
    }
    if (verified && (!seen.latestVerified || verified > seen.latestVerified)) seen.latestVerified = verified;
    if (!seen.vendors.includes(offer.vendor)) seen.vendors.push(offer.vendor);
  }
  return [...byUrl.values()];
}

export function nextRecord(target, previous, result, today) {
  const priorLastReachable = previous?.last_reachable ?? target.latestVerified ?? null;
  const priorStreak = previous?.consecutive_unreachable ?? 0;

  if (result.outcome === "reachable") {
    return {
      url: target.url,
      checked: today,
      outcome: "reachable",
      detail: result.detail,
      terminal: false,
      last_reachable: today,
      consecutive_unreachable: 0,
    };
  }

  if (result.outcome === "unreachable") {
    return {
      url: target.url,
      checked: today,
      outcome: "unreachable",
      detail: result.detail,
      terminal: result.terminal,
      last_reachable: priorLastReachable,
      consecutive_unreachable: priorStreak + 1,
    };
  }

  return {
    url: target.url,
    checked: today,
    outcome: "unknown",
    detail: result.detail,
    terminal: previous?.terminal ?? false,
    last_reachable: priorLastReachable,
    consecutive_unreachable: priorStreak,
  };
}

function loadPrevious() {
  if (!existsSync(HEALTH_PATH)) return new Map();
  try {
    const parsed = JSON.parse(readFileSync(HEALTH_PATH, "utf-8"));
    return new Map((parsed.links ?? []).map((r) => [r.url, r]));
  } catch (err) {
    console.error(`Existing link health index unreadable (${err.message}); starting from empty.`);
    return new Map();
  }
}

async function runHostQueue(targets, previous, today, onRecord) {
  for (let i = 0; i < targets.length; i++) {
    if (i > 0) await sleep(SAME_HOST_DELAY_MS);
    const target = targets[i];
    const result = await checkLiveness(target.url);
    onRecord(nextRecord(target, previous.get(target.url), result, today));
  }
}

function delistingQueue(records, today) {
  const nowMs = new Date(today).getTime();
  return records
    .filter((r) => r.outcome === "unreachable")
    .filter((r) => {
      if (r.terminal) return true;
      if (!r.last_reachable) return false;
      const days = Math.floor((nowMs - new Date(r.last_reachable).getTime()) / 86400000);
      return days >= LINK_GRACE_DAYS;
    })
    .sort((a, b) => (a.last_reachable ?? "").localeCompare(b.last_reachable ?? ""));
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    console.log(HELP);
    process.exit(0);
  }
  const dryRun = args.includes("--dry-run");
  const report = args.includes("--report");
  const limitIdx = args.indexOf("--limit");
  const limit = limitIdx !== -1 ? parseInt(args[limitIdx + 1], 10) : Infinity;

  if (limitIdx !== -1 && (isNaN(limit) || limit < 1)) {
    console.error(`Invalid limit: ${args[limitIdx + 1]}. Must be a positive integer.`);
    process.exit(2);
  }

  let data;
  try {
    data = JSON.parse(readFileSync(INDEX_PATH, "utf-8"));
  } catch (err) {
    console.error(`Failed to read index: ${err.message}`);
    process.exit(2);
  }

  const today = new Date().toISOString().split("T")[0];
  const previous = loadPrevious();
  const targets = collectUrls(data.offers ?? []).slice(0, limit);
  const vendorsByUrl = new Map(targets.map((t) => [t.url, t.vendors]));

  const byHost = new Map();
  for (const target of targets) {
    const host = hostOf(target.url);
    if (!byHost.has(host)) byHost.set(host, []);
    byHost.get(host).push(target);
  }

  console.log(`Link liveness — ${targets.length} distinct URLs across ${byHost.size} hosts${dryRun ? " (dry-run)" : ""}`);

  const records = [];
  const queues = [...byHost.values()];
  let cursor = 0;
  const workers = Array.from({ length: Math.min(HOST_CONCURRENCY, queues.length) }, async () => {
    while (cursor < queues.length) {
      const queue = queues[cursor++];
      await runHostQueue(queue, previous, today, (r) => records.push(r));
    }
  });
  await Promise.all(workers);

  for (const record of previous.values()) {
    if (!vendorsByUrl.has(record.url)) records.push(record);
  }

  records.sort((a, b) => a.url.localeCompare(b.url));

  const counts = { reachable: 0, unreachable: 0, unknown: 0 };
  for (const r of records) counts[r.outcome] = (counts[r.outcome] ?? 0) + 1;

  const persisted = records.filter((r) => r.outcome !== "reachable");

  if (!dryRun) {
    writeFileSync(HEALTH_PATH, JSON.stringify({ generated_at: today, links: persisted }, null, 2) + "\n");
  }

  const queue = delistingQueue(records, today);

  console.log("");
  console.log("── Summary ──");
  console.log(`Reachable:   ${counts.reachable}`);
  console.log(`Unreachable: ${counts.unreachable}`);
  console.log(`Unknown (we were refused, no claim published): ${counts.unknown}`);
  console.log(`Past the ${LINK_GRACE_DAYS}-day grace window or terminal: ${queue.length}`);
  console.log(`Written to data/link_health.json: ${persisted.length} (a link that answers needs no record)`);

  if (report) {
    console.log("");
    console.log("── Delisting queue — confirm by hand, do not automate ──");
    for (const r of queue) {
      const vendors = (vendorsByUrl.get(r.url) ?? []).join(", ");
      console.log(
        `${r.terminal ? "TERMINAL" : "        "} ${String(r.detail).padEnd(22)} last reachable ${r.last_reachable ?? "never recorded"}  ${vendors} — ${r.url}`
      );
    }
    console.log("");
    console.log("── Could not check — these publish nothing and are not evidence ──");
    for (const r of records.filter((x) => x.outcome === "unknown")) {
      const vendors = (vendorsByUrl.get(r.url) ?? []).join(", ");
      console.log(`         ${String(r.detail).padEnd(22)} ${vendors} — ${r.url}`);
    }
  }

  process.exit(0);
}

const isMainModule = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMainModule) {
  main().catch((err) => {
    console.error(`Fatal error: ${err.message}`);
    process.exit(1);
  });
}
