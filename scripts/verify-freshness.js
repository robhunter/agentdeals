#!/usr/bin/env node

import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { CHANGE_TYPES } from "./change-log.js";
import { readStructuredPrices } from "./structured-prices.js";

const CHANGE_TYPE_VALUES = CHANGE_TYPES.join(", ");
const __dirname = dirname(fileURLToPath(import.meta.url));
const INDEX_PATH = resolve(__dirname, "..", "data", "index.json");
const DEFAULT_THRESHOLD_DAYS = 25;
const FETCH_TIMEOUT_MS = 15_000;
const RATE_LIMIT_MS = 500;
export const MAX_PAGE_TEXT_LENGTH = 12_000;
export const MAX_PAGE_BYTES = 16_000_000;
export const MIN_PAGE_TEXT_LENGTH = 500;
export const PAGE_TOO_SHORT_ERROR = "page content too short (likely JS-rendered SPA)";
const MAX_RESPONSE_TOKENS = 400;

export const VERIFIER_MODEL = "google/gemma-3-27b-it";
export const VERIFIER_API_KEY_ENV = "OPENROUTER_API_KEY";
export const VERIFIER_BASE_URL = "https://openrouter.ai/api/v1";

export function findStaleOffers(offers, thresholdDays, now = new Date()) {
  const stale = [];
  const fresh = [];
  for (let i = 0; i < offers.length; i++) {
    const offer = offers[i];
    if (!offer.verifiedDate) {
      stale.push({ index: i, offer });
      continue;
    }
    const verified = new Date(offer.verifiedDate);
    const diffDays = Math.floor(
      (now.getTime() - verified.getTime()) / (1000 * 60 * 60 * 24)
    );
    if (diffDays >= thresholdDays) {
      stale.push({ index: i, offer, daysSince: diffDays });
    } else {
      fresh.push({ index: i, offer });
    }
  }
  stale.sort((a, b) => (b.daysSince ?? Infinity) - (a.daysSince ?? Infinity));
  return { stale, freshCount: fresh.length };
}

function stripHtml(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

export function pageTooLargeError(bytes) {
  return `page too large: ${bytes} bytes`;
}

export function withMinimumLength(page, floor = MIN_PAGE_TEXT_LENGTH) {
  if (!page.ok) return page;
  if (page.text.length < floor) {
    const short = { ok: false, error: PAGE_TOO_SHORT_ERROR, chars: page.text.length };
    if (page.structured) short.structured = page.structured;
    return short;
  }
  return page;
}

async function cancelBody(res) {
  try {
    await res.body?.cancel();
  } catch {}
}

export async function readBodyWithin(res, ceiling) {
  const declared = Number(res.headers?.get?.("content-length"));
  if (Number.isFinite(declared) && declared > ceiling) {
    await cancelBody(res);
    return { tooLarge: true, bytes: declared };
  }
  if (!res.body) {
    const html = await res.text();
    const bytes = Buffer.byteLength(html);
    return bytes > ceiling ? { tooLarge: true, bytes } : { html };
  }
  const chunks = [];
  let bytes = 0;
  for await (const chunk of res.body) {
    bytes += chunk.length;
    if (bytes > ceiling) {
      await cancelBody(res);
      return { tooLarge: true, bytes };
    }
    chunks.push(chunk);
  }
  return { html: Buffer.concat(chunks).toString("utf-8") };
}

export async function fetchPageText(url, options = {}) {
  const ceiling = options.maxBytes ?? MAX_PAGE_BYTES;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: "GET",
      signal: controller.signal,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (compatible; AgentDeals-Verify/1.0; +https://github.com/robhunter/agentdeals)",
        Accept: "text/html,application/xhtml+xml",
      },
      redirect: "follow",
    });
    if (!res.ok) {
      await cancelBody(res);
      return { ok: false, error: `HTTP ${res.status}` };
    }
    const body = await readBodyWithin(res, ceiling);
    if (body.tooLarge) {
      return { ok: false, error: pageTooLargeError(body.bytes) };
    }
    const text = stripHtml(body.html);
    return withMinimumLength({
      ok: true,
      text,
      structured: readStructuredPrices(body.html),
      truncated: false,
      finalUrl: res.url || url,
    });
  } catch (err) {
    const reason = err.name === "AbortError" ? "timeout" : err.message;
    return { ok: false, error: reason };
  } finally {
    clearTimeout(timeout);
  }
}

export function createVerifierClient(options = {}) {
  const apiKey = options.apiKey ?? process.env[VERIFIER_API_KEY_ENV];
  if (!apiKey) {
    throw new Error(
      `${VERIFIER_API_KEY_ENV} is required for --ai mode. Without it nothing can read a vendor's terms, ` +
        `so the run would report zero changes without having looked. No entry was re-verified and no ` +
        `verifiedDate was advanced by this run.`
    );
  }
  const baseUrl = (options.baseUrl ?? process.env.OPENROUTER_BASE_URL ?? VERIFIER_BASE_URL).replace(/\/$/, "");
  const model = options.model ?? VERIFIER_MODEL;
  const fetchImpl = options.fetchImpl ?? fetch;
  return {
    model,
    baseUrl,
    async complete(prompt) {
      const res = await fetchImpl(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
          "HTTP-Referer": "https://agentdeals.dev",
          "X-Title": "AgentDeals re-verification",
        },
        body: JSON.stringify({
          model,
          max_tokens: MAX_RESPONSE_TOKENS,
          temperature: 0,
          messages: [{ role: "user", content: prompt }],
        }),
      });
      if (!res.ok) {
        const detail = await res.text().catch(() => "");
        throw new Error(`${model} request failed: HTTP ${res.status}${detail ? ` — ${detail.slice(0, 200)}` : ""}`);
      }
      const body = await res.json();
      const content = body?.choices?.[0]?.message?.content;
      if (typeof content !== "string") {
        throw new Error(`${model} returned no message content`);
      }
      return content;
    },
  };
}

export function parseVerifierResponse(raw) {
  const text = typeof raw === "string" ? raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/```$/, "").trim() : "";
  const accept = (parsed) =>
    parsed && ["confirmed", "changed", "unclear"].includes(parsed.status) ? parsed : null;
  try {
    const parsed = accept(JSON.parse(text));
    if (parsed) return parsed;
  } catch {
    const match = text.match(/\{[^}]+\}/);
    if (match) {
      try {
        const parsed = accept(JSON.parse(match[0]));
        if (parsed) return parsed;
      } catch {}
    }
  }
  return { status: "unclear", summary: "Could not parse AI response" };
}

export async function verifyOfferAgainstPage(client, offer, wholePageText) {
  const pageText = String(wholePageText ?? "").slice(0, MAX_PAGE_TEXT_LENGTH);
  const prompt = `You are verifying whether a vendor's deal/free-tier information is still accurate.

STORED DEAL INFO:
- Vendor: ${offer.vendor}
- Category: ${offer.category}
- Tier: ${offer.tier}
- Description: ${offer.description}

CURRENT PRICING PAGE TEXT (truncated):
${pageText}

Compare the stored deal info against the pricing page text. Focus on:
1. Does the tier/plan still exist?
2. Are the key limits/features still the same?
3. Has pricing changed (free → paid, limits reduced, etc.)?

Respond with EXACTLY one of these JSON objects (no other text):
- If the deal info is still accurate: {"status":"confirmed"}
- If the page doesn't contain enough info to verify: {"status":"unclear","summary":"<reason>"}
- If you found a discrepancy: {"status":"changed","summary":"<what changed>","change_type":"<one of: ${CHANGE_TYPE_VALUES}>","current_state":"<what the page says the terms are now>","impact":"<high|medium|low>","effective_date":"<YYYY-MM-DD, only if the page states when this took effect>"}

Rules for a "changed" response:
- current_state must describe only what the page text above says. Do not restate the stored deal info and do not infer terms the page does not state.
- Omit effective_date entirely unless the page gives a date.
- If you cannot pick a change_type from that list, or cannot state current_state from the page, answer "unclear" instead.`;

  return parseVerifierResponse(await client.complete(prompt));
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

export async function verifyFreshness({ thresholdDays, dryRun, limit, indexPath, now = new Date(), client: injectedClient }) {
  const data = JSON.parse(readFileSync(indexPath || INDEX_PATH, "utf-8"));
  const offers = data.offers || [];
  const { stale, freshCount } = findStaleOffers(offers, thresholdDays, now);

  if (stale.length === 0) {
    return {
      total: offers.length,
      alreadyFresh: freshCount,
      verified: 0,
      changed: 0,
      failed: 0,
      skipped: 0,
      changes: [],
      failures: [],
    };
  }

  const toVerify = limit ? stale.slice(0, limit) : stale;
  const skipped = stale.length - toVerify.length;

  const client = injectedClient ?? createVerifierClient();
  const today = now.toISOString().split("T")[0];

  let verified = 0;
  let changed = 0;
  let failed = 0;
  const changes = [];
  const failures = [];

  for (const entry of toVerify) {
    const { offer, index } = entry;

    const page = await fetchPageText(offer.url);
    if (!page.ok) {
      failed++;
      failures.push({ vendor: offer.vendor, category: offer.category, url: offer.url, error: page.error });
      await sleep(RATE_LIMIT_MS);
      continue;
    }

    let result;
    try {
      result = await verifyOfferAgainstPage(client, offer, page.text);
    } catch (err) {
      failed++;
      failures.push({ vendor: offer.vendor, category: offer.category, url: offer.url, error: `AI error: ${err.message}` });
      await sleep(RATE_LIMIT_MS);
      continue;
    }

    if (result.status === "confirmed") {
      verified++;
      if (!dryRun) {
        data.offers[index].verifiedDate = today;
      }
    } else if (result.status === "changed") {
      changed++;
      changes.push({ vendor: offer.vendor, category: offer.category, tier: offer.tier, summary: result.summary });
    } else {
      failed++;
      failures.push({ vendor: offer.vendor, category: offer.category, url: offer.url, error: result.summary || "unclear" });
    }

    await sleep(RATE_LIMIT_MS);
  }

  if (!dryRun && verified > 0) {
    writeFileSync(indexPath || INDEX_PATH, JSON.stringify(data, null, 2) + "\n");
  }

  return {
    total: offers.length,
    alreadyFresh: freshCount,
    staleFound: stale.length,
    verified,
    changed,
    failed,
    skipped,
    changes,
    failures,
  };
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");

  const thresholdIdx = args.indexOf("--threshold");
  const thresholdDays =
    thresholdIdx !== -1
      ? parseInt(args[thresholdIdx + 1], 10)
      : DEFAULT_THRESHOLD_DAYS;

  const limitIdx = args.indexOf("--limit");
  const limit =
    limitIdx !== -1 ? parseInt(args[limitIdx + 1], 10) : undefined;

  if (isNaN(thresholdDays) || thresholdDays < 0) {
    console.error(
      `Invalid threshold: ${args[thresholdIdx + 1]}. Must be a non-negative integer.`
    );
    process.exit(2);
  }
  if (limit !== undefined && (isNaN(limit) || limit < 1)) {
    console.error(
      `Invalid limit: ${args[limitIdx + 1]}. Must be a positive integer.`
    );
    process.exit(2);
  }

  console.log(
    `Freshness verification — threshold: ${thresholdDays} days` +
      (limit ? `, limit: ${limit}` : "") +
      (dryRun ? " (dry-run)" : "")
  );
  console.log("");

  const result = await verifyFreshness({ thresholdDays, dryRun, limit });

  if (result.staleFound === undefined || result.staleFound === 0) {
    console.log(
      `All ${result.total} entries verified within ${thresholdDays} days.`
    );
    process.exit(0);
  }

  console.log(`Stale entries found: ${result.staleFound}`);
  if (result.skipped > 0) {
    console.log(`Skipped (over limit): ${result.skipped}`);
  }
  console.log("");

  if (result.changes.length > 0) {
    console.log("⚠ DISCREPANCIES DETECTED (requires PM review):");
    for (const c of result.changes) {
      console.log(`  ${c.vendor} (${c.category}, ${c.tier}): ${c.summary}`);
    }
    console.log("");
  }

  if (result.failures.length > 0) {
    console.log("✗ FAILED TO VERIFY:");
    for (const f of result.failures) {
      console.log(`  ${f.vendor} (${f.category}): ${f.error}`);
    }
    console.log("");
  }

  console.log("── Summary ──");
  console.log(
    `Verified: ${result.verified} | Changed: ${result.changed} | Failed: ${result.failed} | Skipped: ${result.skipped} | Already fresh: ${result.alreadyFresh} | Total: ${result.total}`
  );

  process.exit(0);
}

const isMainModule =
  process.argv[1] &&
  resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMainModule) {
  main().catch((err) => {
    console.error(`Fatal error: ${err.message}`);
    process.exit(1);
  });
}
