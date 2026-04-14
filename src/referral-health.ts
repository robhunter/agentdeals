import { loadOffers } from "./data.js";
import { getAllActiveCodes } from "./referral-codes.js";
import type { Offer } from "./types.js";
import type { SubmittedReferralCode } from "./referral-codes.js";

export interface ReferralCheckResult {
  vendor: string;
  url: string;
  status: number | null;
  valid: boolean;
  source: "curated" | "agent-submitted";
  error?: string;
}

export interface ReferralHealthReport {
  checked_at: string;
  total: number;
  valid: number;
  invalid: number;
  results: ReferralCheckResult[];
}

const TIMEOUT_MS = 5000;
const MAX_REDIRECTS = 3;
const SUSPENSION_THRESHOLD = 3;
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

const failureCounts = new Map<string, number>();
const suspendedUrls = new Set<string>();
let lastReport: ReferralHealthReport | null = null;
let intervalHandle: ReturnType<typeof setInterval> | null = null;

async function checkUrl(url: string): Promise<{ status: number | null; error?: string }> {
  let currentUrl = url;
  let redirectCount = 0;

  while (redirectCount <= MAX_REDIRECTS) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

    try {
      const resp = await fetch(currentUrl, {
        method: "HEAD",
        signal: controller.signal,
        redirect: "manual",
      });
      clearTimeout(timeout);

      if (resp.status === 405) {
        const getController = new AbortController();
        const getTimeout = setTimeout(() => getController.abort(), TIMEOUT_MS);
        try {
          const getResp = await fetch(currentUrl, {
            method: "GET",
            signal: getController.signal,
            redirect: "manual",
          });
          clearTimeout(getTimeout);

          if (getResp.status >= 300 && getResp.status < 400) {
            const location = getResp.headers.get("location");
            if (location && redirectCount < MAX_REDIRECTS) {
              currentUrl = new URL(location, currentUrl).href;
              redirectCount++;
              continue;
            }
            return { status: getResp.status };
          }
          return { status: getResp.status };
        } catch (err: any) {
          clearTimeout(getTimeout);
          return { status: null, error: err.name === "AbortError" ? "timeout" : err.message };
        }
      }

      if (resp.status >= 300 && resp.status < 400) {
        const location = resp.headers.get("location");
        if (location && redirectCount < MAX_REDIRECTS) {
          currentUrl = new URL(location, currentUrl).href;
          redirectCount++;
          continue;
        }
        return { status: resp.status };
      }

      return { status: resp.status };
    } catch (err: any) {
      clearTimeout(timeout);
      return { status: null, error: err.name === "AbortError" ? "timeout" : err.message };
    }
  }

  return { status: null, error: "too many redirects" };
}

function isValid(status: number | null): boolean {
  return status !== null && status >= 200 && status < 400;
}

function collectReferralUrls(): { vendor: string; url: string; source: "curated" | "agent-submitted" }[] {
  const urls: { vendor: string; url: string; source: "curated" | "agent-submitted" }[] = [];

  const offers = loadOffers();
  for (const offer of offers) {
    if (offer.referral?.url) {
      urls.push({ vendor: offer.vendor, url: offer.referral.url, source: "curated" });
    }
  }

  try {
    const agentCodes = getAllActiveCodes();
    for (const code of agentCodes) {
      if (code.referral_url) {
        urls.push({ vendor: code.vendor, url: code.referral_url, source: "agent-submitted" });
      }
    }
  } catch {
    // agent codes file may not exist
  }

  return urls;
}

export async function runHealthCheck(): Promise<ReferralHealthReport> {
  const urls = collectReferralUrls();
  const results: ReferralCheckResult[] = [];

  for (const entry of urls) {
    const { status, error } = await checkUrl(entry.url);
    const valid = isValid(status);

    if (!valid) {
      const count = (failureCounts.get(entry.url) ?? 0) + 1;
      failureCounts.set(entry.url, count);
      if (count >= SUSPENSION_THRESHOLD) {
        suspendedUrls.add(entry.url);
        console.error(`[referral-health] Suspended ${entry.vendor} (${entry.url}) after ${count} consecutive failures`);
      }
    } else {
      failureCounts.delete(entry.url);
      if (suspendedUrls.has(entry.url)) {
        suspendedUrls.delete(entry.url);
        console.error(`[referral-health] Reinstated ${entry.vendor} (${entry.url}) — now healthy`);
      }
    }

    results.push({
      vendor: entry.vendor,
      url: entry.url,
      status,
      valid,
      source: entry.source,
      ...(error ? { error } : {}),
    });
  }

  const report: ReferralHealthReport = {
    checked_at: new Date().toISOString(),
    total: results.length,
    valid: results.filter((r) => r.valid).length,
    invalid: results.filter((r) => !r.valid).length,
    results,
  };

  lastReport = report;
  console.error(`[referral-health] Checked ${report.total} URLs: ${report.valid} valid, ${report.invalid} invalid`);
  return report;
}

export function isUrlSuspended(url: string): boolean {
  return suspendedUrls.has(url);
}

export function getLastReport(): ReferralHealthReport | null {
  return lastReport;
}

export function startPeriodicChecks(): void {
  if (intervalHandle) return;
  intervalHandle = setInterval(() => {
    runHealthCheck().catch((err) => console.error(`[referral-health] Periodic check failed: ${err.message}`));
  }, CHECK_INTERVAL_MS);
  intervalHandle.unref();
}

export function stopPeriodicChecks(): void {
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
  }
}

export function resetHealthState(): void {
  failureCounts.clear();
  suspendedUrls.clear();
  lastReport = null;
  stopPeriodicChecks();
}

export function getFailureCount(url: string): number {
  return failureCounts.get(url) ?? 0;
}
