import { execFileSync } from "node:child_process";
import { stripHtml, verifyOfferAgainstPage } from "./verify-freshness.js";

const CDX_ENDPOINT = "https://web.archive.org/cdx/search/cdx";
const WAYBACK = "https://web.archive.org/web";
const RETRYABLE_STATUSES = new Set([429, 502, 503, 504]);

export function compactDay(day) {
  return String(day).slice(0, 10).replaceAll("-", "");
}

export function dayOfTimestamp(timestamp) {
  const t = String(timestamp);
  return `${t.slice(0, 4)}-${t.slice(4, 6)}-${t.slice(6, 8)}`;
}

export function cdxUrl(url, fromDay, toDay) {
  const params = new URLSearchParams({
    url,
    output: "json",
    fl: "timestamp,original,statuscode,mimetype",
    filter: "statuscode:200",
    collapse: "timestamp:8",
    from: compactDay(fromDay),
    to: compactDay(toDay),
  });
  return `${CDX_ENDPOINT}?${params}`;
}

export function parseCdxRows(body) {
  let rows;
  try {
    rows = JSON.parse(body);
  } catch {
    return [];
  }
  if (!Array.isArray(rows) || rows.length < 2) return [];
  const [header, ...data] = rows;
  const at = (name) => header.indexOf(name);
  return data
    .map((row) => ({
      timestamp: String(row[at("timestamp")] ?? ""),
      original: String(row[at("original")] ?? ""),
      statuscode: String(row[at("statuscode")] ?? ""),
      mimetype: String(row[at("mimetype")] ?? ""),
    }))
    .filter((capture) => /^\d{14}$/.test(capture.timestamp) && capture.statuscode === "200" && capture.mimetype.startsWith("text/html"))
    .sort((a, b) => a.timestamp.localeCompare(b.timestamp));
}

function daysBetween(a, b) {
  return Math.abs(Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86_400_000;
}

export function nearestCapture(captures, day) {
  let best = null;
  for (const capture of captures) {
    const distance = daysBetween(dayOfTimestamp(capture.timestamp), day);
    const onOrBefore = dayOfTimestamp(capture.timestamp) <= day;
    if (!best || distance < best.distance || (distance === best.distance && onOrBefore && !best.onOrBefore)) {
      best = { capture, distance, onOrBefore };
    }
  }
  return best?.capture ?? null;
}

export function captureUrl(capture) {
  return `${WAYBACK}/${capture.timestamp}id_/${capture.original}`;
}

function retryAfterMs(response, fallbackMs) {
  const header = response.headers?.get?.("retry-after");
  const seconds = header ? Number(header) : NaN;
  return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : fallbackMs;
}

export function createArchiveClient({
  fetchImpl = fetch,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  clock = () => Date.now(),
  minIntervalMs = 2000,
  maxAttempts = 4,
  firstBackoffMs = 10_000,
} = {}) {
  let lastRequestAt = -Infinity;

  async function paced(url) {
    let backoff = firstBackoffMs;
    let lastProblem = "";
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const wait = lastRequestAt + minIntervalMs - clock();
      if (wait > 0) await sleep(wait);
      lastRequestAt = clock();
      let response;
      try {
        response = await fetchImpl(url, { redirect: "follow" });
      } catch (err) {
        lastProblem = `network error: ${err?.message ?? err}`;
        if (attempt < maxAttempts) await sleep(backoff);
        backoff *= 2;
        continue;
      }
      if (response.ok) return { ok: true, body: await response.text() };
      lastProblem = `HTTP ${response.status}`;
      if (!RETRYABLE_STATUSES.has(response.status)) return { ok: false, problem: lastProblem };
      if (attempt < maxAttempts) await sleep(retryAfterMs(response, backoff));
      backoff *= 2;
    }
    return { ok: false, problem: `${lastProblem} after ${maxAttempts} attempts` };
  }

  return {
    async captures(url, fromDay, toDay) {
      const result = await paced(cdxUrl(url, fromDay, toDay));
      return result.ok ? { captures: parseCdxRows(result.body) } : { unavailable: result.problem };
    },
    async captureHtml(capture) {
      const result = await paced(captureUrl(capture));
      return result.ok ? { html: result.body } : { unavailable: result.problem };
    },
  };
}

export function commitDaysTouching(text, file = "data/index.json") {
  return execFileSync("git", ["log", "--reverse", "--format=%cs", `-S${text}`, "--", file], { encoding: "utf-8", maxBuffer: 16 * 1024 * 1024 })
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => /^\d{4}-\d{2}-\d{2}$/.test(line));
}

export function dayOurTextEntered(text, { commitDays = commitDaysTouching } = {}) {
  if (!String(text ?? "").trim()) return null;
  return commitDays(text)[0] ?? null;
}

export async function readCapture(client, offer, html) {
  return verifyOfferAgainstPage(client, offer, stripHtml(html));
}
