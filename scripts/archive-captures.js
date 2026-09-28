import { execFileSync } from "node:child_process";
import { MIN_PAGE_TEXT_LENGTH, stripHtml, verifyOfferAgainstPage } from "./verify-freshness.js";

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
  minIntervalMs = 5000,
  maxAttempts = 4,
  firstBackoffMs = 10_000,
  refusedBackoffMs = 60_000,
} = {}) {
  let lastRequestAt = -Infinity;

  async function paced(url) {
    let backoff = firstBackoffMs;
    let refusedBackoff = refusedBackoffMs;
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
        if (attempt < maxAttempts) await sleep(refusedBackoff);
        refusedBackoff *= 2;
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

export const CAPTURE_WINDOW_DAYS = 60;
export const MAX_READS_PER_BRACKET = 12;
export const MAX_MOVES_BRACKETED = 3;

export function readerFor(client, offer) {
  return (storedTerms, pageText) => verifyOfferAgainstPage(client, { ...offer, description: storedTerms }, pageText);
}

function shiftDay(day, days) {
  return new Date(Date.parse(`${day}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

export function capturesBesideTextDay(captures, textDay, windowDays = CAPTURE_WINDOW_DAYS) {
  let before = null;
  let after = null;
  for (const capture of captures) {
    const day = dayOfTimestamp(capture.timestamp);
    if (daysBetween(day, textDay) > windowDays) continue;
    if (day <= textDay) {
      if (!before || capture.timestamp > before.timestamp) before = capture;
    } else if (!after || capture.timestamp < after.timestamp) {
      after = capture;
    }
  }
  return { before, after };
}

function describeCapture(capture, textDay, side) {
  const day = dayOfTimestamp(capture.timestamp);
  return { day, gap_days: daysBetween(day, textDay), side };
}

async function bracketMoves({ start, oldTerms, later, todayText, readCaptureAgainst, readToday }) {
  const brackets = [];
  let from = start;
  let terms = oldTerms;
  let pool = later.filter((capture) => capture.timestamp > from.timestamp);
  while (brackets.length < MAX_MOVES_BRACKETED) {
    let lo = -1;
    let hi = pool.length;
    let reads = 0;
    const termsAt = new Map();
    while (hi - lo > 1 && reads < MAX_READS_PER_BRACKET) {
      const mid = Math.floor((lo + hi) / 2);
      const reading = await readCaptureAgainst(pool[mid], terms);
      reads++;
      if (reading.status === "confirmed") lo = mid;
      else if (reading.status === "changed" && reading.current_state) {
        hi = mid;
        termsAt.set(pool[mid].timestamp, reading.current_state);
      } else {
        pool = [...pool.slice(0, mid), ...pool.slice(mid + 1)];
        hi--;
      }
    }
    const lastOld = lo === -1 ? from : pool[lo];
    const firstNew = hi === pool.length ? null : pool[hi];
    brackets.push({
      last_old: dayOfTimestamp(lastOld.timestamp),
      first_new: firstNew ? dayOfTimestamp(firstNew.timestamp) : null,
      narrowed_to_adjacent_captures: hi - lo <= 1,
    });
    if (!firstNew) return { brackets, later_moves: "none" };
    const newTerms = termsAt.get(firstNew.timestamp);
    const today = await readToday(newTerms);
    if (today.status === "confirmed") return { brackets, later_moves: "none" };
    if (today.status !== "changed") return { brackets, later_moves: "unknown" };
    from = firstNew;
    terms = newTerms;
    pool = pool.slice(hi + 1);
  }
  return { brackets, later_moves: "more than bracketed" };
}

export async function settleAgainstCaptures({ url, ourText, textDay, todayText, today, archive, read, windowDays = CAPTURE_WINDOW_DAYS }) {
  let reads = 0;
  if (!textDay) return { outcome: "text_day_unknown", reads };
  const listed = await archive.captures(url, shiftDay(textDay, -windowDays), today);
  if (listed.unavailable) return { outcome: "no_usable_capture", text_day: textDay, reads, tried: [], why: `the Archive did not answer: ${listed.unavailable}` };
  const captures = listed.captures;
  const readCaptureAgainst = async (capture, terms) => {
    const page = await archive.captureHtml(capture);
    if (page.unavailable) return { status: "unclear", summary: page.unavailable };
    const text = stripHtml(page.html);
    if (text.length < MIN_PAGE_TEXT_LENGTH) return { status: "unclear", summary: "the capture is too short to read" };
    reads++;
    return read(terms, text);
  };
  const readToday = async (terms) => {
    reads++;
    return read(terms, todayText);
  };
  const { before, after } = capturesBesideTextDay(captures, textDay, windowDays);
  const tried = [];
  for (const [capture, side] of [[before, "before"], [after, "after"]]) {
    if (!capture) continue;
    const at = describeCapture(capture, textDay, side);
    const then = await readCaptureAgainst(capture, ourText);
    const termsThen = then.status === "confirmed" ? ourText : then.status === "changed" ? then.current_state : null;
    if (!termsThen) {
      tried.push({ ...at, why: "the reader could not compare the capture with our text" });
      continue;
    }
    const now = await readToday(termsThen);
    if (now.status === "changed") {
      const moves = await bracketMoves({ start: capture, oldTerms: termsThen, later: captures, todayText, readCaptureAgainst, readToday });
      return { outcome: "vendor_changed", text_day: textDay, capture: at, previous_state: termsThen, ...moves, date: datedBy(moves), reads };
    }
    if (now.status !== "confirmed") {
      tried.push({ ...at, why: "the reader could not compare today's page with the capture's terms" });
      continue;
    }
    if (termsThen === ourText) return { outcome: "not_reproduced", text_day: textDay, capture: at, reads };
    if (side === "before") return { outcome: "ours", text_day: textDay, capture: at, terms_then: termsThen, reads };
    tried.push({ ...at, why: "today's page states the capture's terms, but a capture after our text's day cannot show the difference was ours" });
  }
  return { outcome: "no_usable_capture", text_day: textDay, reads, tried, why: tried.length ? "no capture settled it" : `no capture within ${windowDays} days of our text's day` };
}

function datedBy({ brackets, later_moves }) {
  return brackets.length === 1 && later_moves === "none" ? brackets[0].first_new : null;
}
