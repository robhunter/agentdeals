import { execFileSync } from "node:child_process";
import { MAX_PAGE_TEXT_LENGTH, MIN_PAGE_TEXT_LENGTH, stripHtml } from "./verify-freshness.js";

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
  });
  if (fromDay) params.set("from", compactDay(fromDay));
  params.set("to", compactDay(toDay));
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

export function asStoredInJson(text) {
  return JSON.stringify(String(text)).slice(1, -1);
}

export function dayOurTextEntered(text, { commitDays = commitDaysTouching } = {}) {
  if (!String(text ?? "").trim()) return null;
  return commitDays(asStoredInJson(text))[0] ?? null;
}

export const PAIRED_READER_MAX_TOKENS = 1500;

const NAMED_ENTITIES = {
  nbsp: " ",
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  lsquo: "\u2018",
  rsquo: "\u2019",
  ldquo: "\u201C",
  rdquo: "\u201D",
  ndash: "\u2013",
  mdash: "\u2014",
  hellip: "\u2026",
  middot: "\u00B7",
  times: "\u00D7",
  euro: "\u20AC",
  pound: "\u00A3",
};

function codePointOr(code, original) {
  return Number.isInteger(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : original;
}

export function comparableText(text) {
  return String(text ?? "")
    .replace(/&#x([0-9a-f]+);/gi, (original, hex) => codePointOr(parseInt(hex, 16), original))
    .replace(/&#(\d+);/g, (original, decimal) => codePointOr(Number(decimal), original))
    .replace(/&([a-z]+);/gi, (original, name) => NAMED_ENTITIES[name.toLowerCase()] ?? original)
    .replace(/[\u2018\u2019\u201A\u201B\u2032]/g, "'")
    .replace(/[\u201C\u201D\u201E\u201F\u2033]/g, '"')
    .replace(/[\u2010-\u2015\u2212]/g, "-")
    .replace(/\u2026/g, "...")
    .replace(/[\s\u200B-\u200D\u2060\uFEFF]+/g, "");
}

export function pairedPrompt(listing, older, newer, maxLength = MAX_PAGE_TEXT_LENGTH) {
  const clip = (text) => String(text ?? "").slice(0, maxLength);
  return `You are comparing two copies of the same web page, saved on different days, to find out whether the terms of one plan changed between them.

THE PLAN:
- Vendor: ${listing.vendor}
- Category: ${listing.category}
- Plan: ${listing.tier}

OLD PAGE (saved ${older.day}, truncated):
${clip(older.text)}

NEW PAGE (saved ${newer.day}, truncated):
${clip(newer.text)}

Step 1. On each page, find the words that state this plan's terms: its price, its limits, what it includes and who can get it. Copy them exactly as they appear on that page, as one or more short fragments. Never reword a fragment, and never join words that are apart on the page into one fragment.
Step 2. Decide whether the plan's terms are the same on both pages. Ignore changes of wording, order or layout, renamed features, and other plans. The terms differ only if a price, a limit, an included feature or who can get the plan is different.
Step 3. For each term that differs, copy the words that state it from OLD PAGE and from NEW PAGE. Include the words that say what a figure counts ("500 MB database", not "500 MB"). If the term is on only one of the pages, leave the other side empty.

Respond with exactly one JSON object and no other text:
{"old_terms":["<fragment copied from OLD PAGE>"],"new_terms":["<fragment copied from NEW PAGE>"],"same":<true or false>,"differences":[{"old":"<words copied from OLD PAGE, or empty>","new":"<words copied from NEW PAGE, or empty>"}],"direction":"<narrowed, unchanged or widened: is the plan worse, the same or better for a user on NEW PAGE than on OLD PAGE>"}

If a page does not state this plan's terms, give an empty list for that page's terms. If the terms are the same, give an empty list of differences.`;
}

export function parsePairedAnswer(raw) {
  const text = typeof raw === "string" ? raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim() : "";
  const first = text.indexOf("{");
  const last = text.lastIndexOf("}");
  const candidates = first >= 0 && last > first ? [text, text.slice(first, last + 1)] : [text];
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === "object" && "same" in parsed) return parsed;
    } catch {}
  }
  return null;
}

function fragmentsOf(value) {
  const list = Array.isArray(value) ? value : value == null ? [] : [value];
  return list.map((fragment) => String(fragment ?? "").trim()).filter((fragment) => comparableText(fragment));
}

function claimsOf(value) {
  return (Array.isArray(value) ? value : [])
    .map((claim) => ({ old: String(claim?.old ?? "").trim(), new: String(claim?.new ?? "").trim() }))
    .filter((claim) => comparableText(claim.old) || comparableText(claim.new));
}

function whyAClaimFails(claim, older, newer) {
  const olderHas = (words) => older.includes(comparableText(words));
  const newerHas = (words) => newer.includes(comparableText(words));
  if (claim.old && !olderHas(claim.old)) return { unverifiable: "old", why: "the old words are not on the old page" };
  if (claim.new && !newerHas(claim.new)) return { unverifiable: "new", why: "the new words are not on the new page" };
  if (!claim.old && olderHas(claim.new)) return { why: "the new words were already on the old page" };
  if (!claim.new && newerHas(claim.old)) return { why: "the old words are still on the new page" };
  if (claim.old && claim.new && newerHas(claim.old) && olderHas(claim.new)) return { why: "each page carries both the old and the new words" };
  return null;
}

function sideOfBoth(oldFailed, newFailed) {
  return oldFailed && newFailed ? "both" : oldFailed ? "old" : "new";
}

export function judgePair(answer, olderText, newerText) {
  if (!answer) return { status: "unquotable", side: "both", why: "the reader's answer could not be parsed" };
  const older = comparableText(olderText);
  const newer = comparableText(newerText);
  const oldTerms = fragmentsOf(answer.old_terms);
  const newTerms = fragmentsOf(answer.new_terms);
  const notOn = (fragments, text) => fragments.filter((fragment) => !text.includes(comparableText(fragment)));
  const oldProblem = oldTerms.length === 0 ? "no terms quoted from the old page" : notOn(oldTerms, older).map((f) => `not on the old page: "${f}"`).join("; ");
  const newProblem = newTerms.length === 0 ? "no terms quoted from the new page" : notOn(newTerms, newer).map((f) => `not on the new page: "${f}"`).join("; ");
  if (oldProblem || newProblem) {
    return { status: "unquotable", side: sideOfBoth(Boolean(oldProblem), Boolean(newProblem)), why: [oldProblem, newProblem].filter(Boolean).join("; "), old_terms: oldTerms, new_terms: newTerms };
  }
  const quoted = { old_terms: oldTerms, new_terms: newTerms, direction: typeof answer.direction === "string" ? answer.direction : null };
  if (answer.same === true || answer.same === "true") return { status: "same", ...quoted };
  const differences = [];
  const refuted = [];
  const unverifiable = [];
  for (const claim of claimsOf(answer.differences)) {
    const failure = whyAClaimFails(claim, older, newer);
    if (!failure) differences.push(claim);
    else if (failure.unverifiable) unverifiable.push({ ...claim, side: failure.unverifiable, why: failure.why });
    else refuted.push({ ...claim, why: failure.why });
  }
  if (differences.length > 0) return { status: "differ", ...quoted, differences, refuted, unverifiable };
  if (refuted.length > 0 && unverifiable.length === 0) return { status: "same", ...quoted, refuted };
  const why = unverifiable.length > 0 ? unverifiable.map((claim) => claim.why).join("; ") : "the reader said the terms differ but quoted no difference";
  return { status: "unquotable", side: unverifiable.length > 0 ? sideOfBoth(unverifiable.some((c) => c.side === "old"), unverifiable.some((c) => c.side === "new")) : "both", why, ...quoted, refuted, unverifiable };
}

export function pairedReaderFor(client, listing) {
  return async (older, newer) => judgePair(parsePairedAnswer(await client.complete(pairedPrompt(listing, older, newer))), older.text, newer.text);
}

export const CAPTURE_WINDOW_DAYS = 60;
export const MAX_READS_PER_BRACKET = 12;
export const MAX_MOVES_BRACKETED = 3;

export function oldCaptureCandidates(captures, textDay, windowDays = CAPTURE_WINDOW_DAYS) {
  let before = null;
  let after = null;
  for (const capture of captures) {
    const day = dayOfTimestamp(capture.timestamp);
    if (day <= textDay) {
      if (!before || capture.timestamp > before.timestamp) before = capture;
    } else if (daysBetween(day, textDay) <= windowDays && (!after || capture.timestamp < after.timestamp)) {
      after = capture;
    }
  }
  return { before, after };
}

export function recordDayCapture(captures, recordDay, laterThan, windowDays = CAPTURE_WINDOW_DAYS) {
  const eligible = captures.filter((capture) => capture.timestamp > laterThan.timestamp && daysBetween(dayOfTimestamp(capture.timestamp), recordDay) <= windowDays);
  return nearestCapture(eligible, recordDay);
}

function placeBesideRecord(bracket, recordDay, today) {
  if (recordDay < today && bracket.last_old >= recordDay) return "after";
  if (bracket.first_new && bracket.first_new <= recordDay) return "before";
  return "spans";
}

async function bracketMoves({ from, until, pool, compare, pageOf }) {
  const brackets = [];
  let start = from;
  let candidates = pool;
  while (brackets.length < MAX_MOVES_BRACKETED) {
    let lo = -1;
    let hi = candidates.length;
    let reads = 0;
    while (hi - lo > 1 && reads < MAX_READS_PER_BRACKET) {
      const mid = Math.floor((lo + hi) / 2);
      const page = await pageOf(candidates[mid]);
      const verdict = page ? await compare(start, page) : null;
      if (page) reads++;
      if (verdict?.status === "same") lo = mid;
      else if (verdict?.status === "differ") hi = mid;
      else {
        candidates = [...candidates.slice(0, mid), ...candidates.slice(mid + 1)];
        hi--;
      }
    }
    const lastOld = lo === -1 ? start : await pageOf(candidates[lo]);
    const firstNew = hi === candidates.length ? until : await pageOf(candidates[hi]);
    brackets.push({
      last_old: lastOld.day,
      first_new: firstNew.capture ? firstNew.day : null,
      narrowed_to_adjacent_captures: hi - lo <= 1,
    });
    if (hi === candidates.length) return { brackets, moves_complete: true };
    const onward = await compare(firstNew, until);
    if (onward.status === "same") return { brackets, moves_complete: true };
    if (onward.status !== "differ") return { brackets, moves_complete: false };
    start = firstNew;
    candidates = candidates.slice(hi + 1);
  }
  return { brackets, moves_complete: false };
}

function samePage(a, b) {
  const bare = (url) => String(url).replace(/^https?:\/\/(www\.)?/, "").replace(/\/+$/, "");
  return bare(a) === bare(b);
}

async function capturesOfEither(archive, urls, fromDay, toDay) {
  const captures = [];
  for (const url of urls) {
    const listed = await archive.captures(url, fromDay, toDay);
    if (listed.unavailable) return listed;
    captures.push(...listed.captures);
  }
  const byTimestamp = new Map(captures.map((capture) => [capture.timestamp, capture]));
  return { captures: [...byTimestamp.values()].sort((a, b) => a.timestamp.localeCompare(b.timestamp)) };
}

function describeDay(day, reference, side) {
  return { day, gap_days: daysBetween(day, reference), side };
}

function sideOfRecordDay(day, recordDay) {
  return day < recordDay ? "before" : day > recordDay ? "after" : "on";
}

export async function settleAgainstCaptures({ url, finalUrl, textDay, recordDay, todayText, today, archive, readPair, onRead = () => {}, windowDays = CAPTURE_WINDOW_DAYS }) {
  let reads = 0;
  if (!textDay) return { outcome: "text_day_unknown", reads };
  const judgedOn = recordDay && recordDay < today ? recordDay : today;
  const urls = finalUrl && !samePage(url, finalUrl) ? [url, finalUrl] : [url];
  const listed = await capturesOfEither(archive, urls, null, today);
  if (listed.unavailable) return { outcome: "no_usable_capture", text_day: textDay, record_day: judgedOn, reads, tried: [], why: `the Archive did not answer: ${listed.unavailable}` };
  const captures = listed.captures;

  const texts = new Map();
  const pageOf = async (capture) => {
    if (!texts.has(capture.timestamp)) {
      const stored = await archive.captureHtml(capture);
      const text = stored.unavailable ? "" : stripHtml(stored.html);
      texts.set(capture.timestamp, text.length >= MIN_PAGE_TEXT_LENGTH ? text : null);
    }
    const text = texts.get(capture.timestamp);
    const day = dayOfTimestamp(capture.timestamp);
    return text === null ? null : { page: `capture ${day}`, day, text, capture };
  };
  const todayPage = { page: "today", day: today, text: todayText };
  const compare = async (older, newer) => {
    reads++;
    const verdict = await readPair(older, newer);
    onRead({ older: older.page, newer: newer.page, verdict });
    return verdict;
  };

  const settleFrom = async (old, side) => {
    const nearRecord = judgedOn < today ? recordDayCapture(captures, judgedOn, old.capture, windowDays) : null;
    const unreadable = [];
    let end = null;
    let first = null;
    for (const candidate of [nearRecord, todayPage]) {
      if (!candidate) continue;
      const page = candidate === todayPage ? todayPage : await pageOf(candidate);
      if (!page) {
        unreadable.push(`capture ${dayOfTimestamp(candidate.timestamp)}: the capture could not be read`);
        continue;
      }
      const verdict = await compare(old, page);
      if (verdict.status === "same" || verdict.status === "differ") {
        end = page;
        first = verdict;
        break;
      }
      if (verdict.side === "old" || verdict.side === "both") return { next: true, why: `the reader could not quote the plan's terms from the capture: ${verdict.why}` };
      unreadable.push(`${page.page}: ${verdict.why}`);
    }
    if (!end) return { outcome: "no_usable_capture", why: `the reader could not quote the plan's terms from the page on the record's day (${unreadable.join("; ")})` };
    const comparedWith = { page: end.page, ...describeDay(end.day, judgedOn, sideOfRecordDay(end.day, judgedOn)) };
    const agreed = (verdict, laterMoves = []) =>
      side === "before"
        ? { outcome: "ours", compared_with: comparedWith, terms_then: verdict.old_terms, later_moves: laterMoves }
        : { next: true, why: "the capture states the terms the page stated on the record's day, but a capture after our text's day cannot show the difference was ours" };

    let deciding = first;
    let moves;
    if (first.status === "same") {
      if (!(end.capture && end.day < judgedOn)) return agreed(first);
      const now = await compare(old, todayPage);
      if (now.status === "same") return agreed(first);
      if (now.status !== "differ") return { outcome: "no_usable_capture", compared_with: comparedWith, why: `the capture before the record's day states the old capture's terms, but the reader could not compare today's page: ${now.why}` };
      deciding = now;
      moves = await bracketMoves({ from: end, until: todayPage, pool: captures.filter((capture) => capture.timestamp > end.capture.timestamp), compare, pageOf });
    } else {
      const pool = captures.filter((capture) => capture.timestamp > old.capture.timestamp && (!end.capture || capture.timestamp < end.capture.timestamp));
      moves = await bracketMoves({ from: old, until: end, pool, compare, pageOf });
    }
    const placed = moves.brackets.map((bracket) => ({ ...bracket, relative_to_record: placeBesideRecord(bracket, judgedOn, today) }));
    const recordMoves = placed.filter((bracket) => bracket.relative_to_record !== "after");
    const laterMoves = placed.filter((bracket) => bracket.relative_to_record === "after");
    if (recordMoves.length === 0) return agreed(deciding, laterMoves);
    return {
      outcome: "vendor_changed",
      compared_with: comparedWith,
      previous_state: deciding.old_terms.join(" \u00B7 "),
      terms_then: deciding.old_terms,
      terms_on_record_day: deciding.new_terms,
      differences: deciding.differences,
      direction: deciding.direction,
      brackets: recordMoves,
      later_moves: laterMoves,
      moves_complete: moves.moves_complete,
      date: recordMoves.length === 1 && moves.moves_complete ? recordMoves[0].first_new : null,
    };
  };

  const { before, after } = oldCaptureCandidates(captures, textDay, windowDays);
  const tried = [];
  for (const [capture, side] of [[before, "before"], [after, "after"]]) {
    if (!capture) continue;
    const at = describeDay(dayOfTimestamp(capture.timestamp), textDay, side);
    const old = await pageOf(capture);
    if (!old) {
      tried.push({ ...at, why: "the capture could not be read" });
      continue;
    }
    const settled = await settleFrom(old, side);
    if (settled.next) {
      tried.push({ ...at, why: settled.why });
      continue;
    }
    return { ...settled, text_day: textDay, record_day: judgedOn, capture: at, reads, ...(tried.length ? { tried } : {}) };
  }
  return {
    outcome: "no_usable_capture",
    text_day: textDay,
    record_day: judgedOn,
    reads,
    tried,
    why: tried.length ? "no capture settled it" : `no capture on or before our text's day, nor within ${windowDays} days after it`,
  };
}
