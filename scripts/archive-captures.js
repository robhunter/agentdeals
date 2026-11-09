import { execFileSync } from "node:child_process";
import { readDeprecation } from "../dist/product-deprecation.js";
import { descriptionDeniesFreeTier } from "../dist/ranking.js";
import { MIN_PAGE_TEXT_LENGTH, stripHtml } from "./verify-freshness.js";

export const MAX_ARCHIVE_PAGE_TEXT_LENGTH = 12_000;

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

export function archivedCopyUrl(capture) {
  return `${WAYBACK}/${capture.timestamp}/${capture.original}`;
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

export function decodedText(text) {
  return String(text ?? "")
    .replace(/&#x([0-9a-f]+);/gi, (original, hex) => codePointOr(parseInt(hex, 16), original))
    .replace(/&#(\d+);/g, (original, decimal) => codePointOr(Number(decimal), original))
    .replace(/&([a-z]+);/gi, (original, name) => NAMED_ENTITIES[name.toLowerCase()] ?? original)
    .replace(/[\u2018\u2019\u201A\u201B\u2032]/g, "'")
    .replace(/[\u201C\u201D\u201E\u201F\u2033]/g, '"')
    .replace(/[\u2010-\u2015\u2212]/g, "-")
    .replace(/\u2026/g, "...");
}

export function comparableText(text) {
  return decodedText(text).replace(/[\s\u200B-\u200D\u2060\uFEFF]+/g, "");
}

export function pairedPrompt(listing, older, newer, maxLength = MAX_ARCHIVE_PAGE_TEXT_LENGTH) {
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
Step 2. Decide whether the plan's terms are the same on both pages. Ignore changes of wording, order or layout, renamed features, and other plans. The terms differ only if a price, a limit, an included feature or who can get the plan is different, or the plan is offered on only one of the pages.
Step 3. For each term that differs, copy the words that state it from OLD PAGE and from NEW PAGE. Include the words that say what a figure counts ("500 MB database", not "500 MB"). If the term is on only one of the pages, leave the other side empty.
Step 4. If one page does not offer this plan at all, give an empty list for that page's terms, and copy into offered_instead the words on that page that show what it offers in the plan's place: other plans, a trial, or a line saying the plan ended.

Respond with exactly one JSON object and no other text:
{"old_terms":["<fragment copied from OLD PAGE>"],"new_terms":["<fragment copied from NEW PAGE>"],"offered_instead":["<fragment copied from the page that does not offer the plan>"],"same":<true or false>,"differences":[{"old":"<words copied from OLD PAGE, or empty>","new":"<words copied from NEW PAGE, or empty>"}],"direction":"<narrowed, unchanged or widened: is the plan worse, the same or better for a user on NEW PAGE than on OLD PAGE>"}

If a page does not state this plan's terms, give an empty list for that page's terms. If both pages offer the plan, give an empty list for offered_instead. If the terms are the same, give an empty list of differences.`;
}

function parseAnswerHolding(raw, key) {
  const text = typeof raw === "string" ? raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim() : "";
  const first = text.indexOf("{");
  const last = text.lastIndexOf("}");
  const candidates = first >= 0 && last > first ? [text, text.slice(first, last + 1)] : [text];
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === "object" && key in parsed) return parsed;
    } catch {}
  }
  return null;
}

export function parsePairedAnswer(raw) {
  return parseAnswerHolding(raw, "same");
}

export function parseStatedBeforeAnswer(raw) {
  return parseAnswerHolding(raw, "changes");
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

function occursMoreThanOnce(text, words) {
  const first = text.indexOf(words);
  return first >= 0 && text.indexOf(words, first + 1) >= 0;
}

function wordsTooCommonToRefute(claim, older, newer) {
  const repeatedOn = (text) => [claim.old, claim.new].filter((words) => words && occursMoreThanOnce(text, comparableText(words)));
  const onOld = repeatedOn(older);
  const onNew = repeatedOn(newer);
  if (onOld.length === 0 && onNew.length === 0) return null;
  const side = sideOfBoth(onOld.length > 0, onNew.length > 0);
  const repeated = [...new Set([...onOld, ...onNew])];
  const quoted = repeated.map((words) => `"${words}"`).join(" and ");
  const [verb, pronoun] = repeated.length > 1 ? ["occur", "they"] : ["occurs", "it"];
  const pages = side === "both" ? "old and the new pages" : `${side} page`;
  return { unverifiable: side, why: `${quoted} ${verb} more than once on the ${pages}, so ${pronoun} cannot refute the difference` };
}

function refutationOf(claim, olderHas, newerHas) {
  if (!claim.old && olderHas(claim.new)) return { why: "the new words were already on the old page" };
  if (!claim.new && newerHas(claim.old)) return { why: "the old words are still on the new page" };
  if (claim.old && claim.new && newerHas(claim.old) && olderHas(claim.new)) return { why: "each page carries both the old and the new words" };
  return null;
}

const VALUE_WORDS = ["not included", "unlimited", "included", "none"];
const MULTIPLIERS = { k: 1_000, m: 1_000_000, b: 1_000_000_000 };
const FIGURE = /(\d[\d,]*(?:\.\d+)?)(?:([kmb])(?![a-z]))?/g;

export function valuesStated(words) {
  let rest = String(words ?? "").toLowerCase();
  const values = [];
  for (const word of VALUE_WORDS) {
    rest = rest.replace(new RegExp(`\\b${word.replace(" ", "\\s+")}\\b`, "g"), () => {
      values.push(word);
      return " ";
    });
  }
  for (const [, figure, multiplier] of rest.matchAll(FIGURE)) {
    values.push(String(Number(figure.replaceAll(",", "")) * (MULTIPLIERS[multiplier] ?? 1)));
  }
  return values;
}

function valuesMissingFrom(values, others) {
  const unmatched = [...others];
  return values.filter((value) => {
    const at = unmatched.indexOf(value);
    if (at < 0) return true;
    unmatched.splice(at, 1);
    return false;
  });
}

const SEATS = /(?:\bper[\s-]+|\/\s*)(?:active\s+)?(?:user|seat|member|editor|developer|person)s?\b/g;
const PERIOD_NAMES = { second: "second", sec: "second", s: "second", minute: "minute", min: "minute", hour: "hour", hr: "hour", h: "hour", day: "day", week: "week", wk: "week", month: "month", mon: "month", mo: "month", year: "year", yr: "year", hourly: "hour", daily: "day", weekly: "week", monthly: "month", yearly: "year", annually: "year", annual: "year" };
const PERIODS = [
  /\bper[\s-]+(second|sec|minute|min|hour|hr|day|week|wk|month|mo|year|yr)s?\b/g,
  /\b(?:a|an|each|every)\s+(second|minute|hour|day|week|month|year)\b/g,
  /\/\s*(second|sec|s|minute|min|hour|hr|h|day|week|wk|month|mon|mo|year|yr)s?\b/g,
  /\b(hourly|daily|weekly|monthly|yearly|annually|annual)\b/g,
];
const DATA_UNITS = /(?<![a-z])([kmgtp])i?b\b/g;
const TIME_UNITS = { second: "second", sec: "second", minute: "minute", min: "minute", hour: "hour", hr: "hour", day: "day", week: "week", wk: "week", month: "month", mo: "month", year: "year", yr: "year" };
const TIME_UNIT = /\b(second|sec|minute|min|hour|hr|day|week|wk|month|mo|year|yr)s?\b/g;
const NEGATION = /\b(no|not|without)\b/g;
const FUNCTION_WORDS = new Set(["a", "an", "the", "of", "to", "up", "for", "and", "or", "in", "on", "at", "by", "with", "per", "plus", "from", "your", "you", "each", "every", "all", "any", "is", "are", "it"]);

function wordsBesidesTerms(rest) {
  const found = (rest.replace(FIGURE, " ").match(/\p{L}+/gu) ?? []).map((word) => word.replace(/s$/, ""));
  return [...new Set(found.filter((word) => word && !FUNCTION_WORDS.has(word)))].sort();
}

function takeAll(text, pattern, name) {
  const taken = [];
  const rest = text.replace(pattern, (...match) => {
    taken.push(name(match[1]));
    return " ";
  });
  return { taken, rest };
}

export function termsOfLine(words) {
  const values = valuesStated(words);
  let rest = String(words ?? "").toLowerCase();
  for (const word of VALUE_WORDS) rest = rest.replace(new RegExp(`\\b${word.replace(" ", "\\s+")}\\b`, "g"), " ");
  const seats = takeAll(rest, SEATS, () => "per seat");
  rest = seats.rest;
  const periods = [];
  for (const pattern of PERIODS) {
    const found = takeAll(rest, pattern, (name) => `per ${PERIOD_NAMES[name]}`);
    periods.push(...found.taken);
    rest = found.rest;
  }
  const data = takeAll(rest, DATA_UNITS, (prefix) => `${prefix}b`);
  const time = takeAll(data.rest, TIME_UNIT, (name) => TIME_UNITS[name]);
  const negations = takeAll(time.rest, NEGATION, (word) => word);
  const sorted = (list) => [...list].sort();
  return { values, units: sorted([...data.taken, ...time.taken]), periods: sorted(periods), seats: seats.taken, negations: sorted(negations.taken), words: wordsBesidesTerms(negations.rest) };
}

const QUALIFIERS = ["units", "periods", "seats", "negations"];
const QUALIFIERS_A_CHANGE_CAN_MOVE = ["units", "periods"];

function sameList(a, b) {
  return a.length === b.length && a.every((item, i) => item === b[i]);
}

const quoteAll = (values) => values.map((value) => `"${value}"`).join(", ");

function valueRuleFor(claim) {
  if (!claim.old) return { kind: "one_sided", why: "only the new page states it" };
  if (!claim.new) return { kind: "one_sided", why: "only the old page states it" };
  const was = termsOfLine(claim.old);
  const now = termsOfLine(claim.new);
  const gone = valuesMissingFrom(was.values, now.values);
  const added = valuesMissingFrom(now.values, was.values);
  if (gone.length > 0 && added.length > 0) return { kind: "counts" };
  if (gone.length > 0) return { kind: "one_sided", why: `only the old words state ${quoteAll(gone)}` };
  if (added.length > 0) return { kind: "one_sided", why: `only the new words state ${quoteAll(added)}` };
  if (was.values.length === 0) return { kind: "unmatched", why: "neither the old nor the new words state a value" };
  if (QUALIFIERS_A_CHANGE_CAN_MOVE.some((name) => was[name].length > 0 && now[name].length > 0 && !sameList(was[name], now[name]))) return { kind: "counts" };
  const differing = QUALIFIERS.find((name) => !sameList(was[name], now[name]));
  if (!differing) return { kind: "reworded", why: "the old and the new words state the same values" };
  const onlyOld = valuesMissingFrom(was[differing], now[differing]);
  const onlyNew = valuesMissingFrom(now[differing], was[differing]);
  const sides = [onlyOld.length ? `the old words say ${quoteAll(onlyOld)}` : null, onlyNew.length ? `the new words say ${quoteAll(onlyNew)}` : null].filter(Boolean);
  return { kind: "unmatched", why: `the figures match, but only ${sides.join(" and only ")}` };
}

function wordsOnTheOtherPage(claim, olderHas, newerHas) {
  if (newerHas(claim.old)) return { kind: "one_sided", why: "the old words are still on the new page" };
  if (olderHas(claim.new)) return { kind: "one_sided", why: "the new words were already on the old page" };
  return null;
}

function classifyClaim(claim, older, newer) {
  const olderHas = (words) => older.includes(comparableText(words));
  const newerHas = (words) => newer.includes(comparableText(words));
  if (claim.old && !olderHas(claim.old)) return { kind: "unverifiable", side: "old", why: "the old words are not on the old page" };
  if (claim.new && !newerHas(claim.new)) return { kind: "unverifiable", side: "new", why: "the new words are not on the new page" };
  if (comparableText(claim.old) === comparableText(claim.new)) return { kind: "refuted", why: "the old and the new words are the same" };
  const refutation = refutationOf(claim, olderHas, newerHas);
  if (!refutation) {
    const rule = valueRuleFor(claim);
    return rule.kind === "counts" ? wordsOnTheOtherPage(claim, olderHas, newerHas) ?? rule : rule;
  }
  const tooCommon = wordsTooCommonToRefute(claim, older, newer);
  return tooCommon ? { kind: "unverifiable", side: tooCommon.unverifiable, why: tooCommon.why } : { kind: "refuted", why: refutation.why };
}

function sideOfBoth(oldFailed, newFailed) {
  return oldFailed && newFailed ? "both" : oldFailed ? "old" : "new";
}

function notOnPage(fragments, text) {
  return fragments.filter((fragment) => !text.includes(comparableText(fragment)));
}

function judgePlanOnOnePage({ oldTerms, newTerms, instead, older, newer, direction }) {
  const disappeared = newTerms.length === 0;
  const [planSide, otherSide] = disappeared ? ["old", "new"] : ["new", "old"];
  const [planTerms, planPage, otherPage] = disappeared ? [oldTerms, older, newer] : [newTerms, newer, older];
  const quoted = { old_terms: oldTerms, new_terms: newTerms, offered_instead: instead, direction };
  const planMisquoted = notOnPage(planTerms, planPage);
  const insteadMisquoted = notOnPage(instead, otherPage);
  if (planMisquoted.length > 0 || insteadMisquoted.length > 0) {
    const why = [...planMisquoted.map((f) => `not on the ${planSide} page: "${f}"`), ...insteadMisquoted.map((f) => `not on the ${otherSide} page: "${f}"`)].join("; ");
    const failed = { [planSide]: planMisquoted.length > 0, [otherSide]: insteadMisquoted.length > 0 };
    return { status: "unquotable", side: sideOfBoth(failed.old, failed.new), why, ...quoted };
  }
  const lingering = planTerms.filter((fragment) => valuesStated(fragment).length > 0 && otherPage.includes(comparableText(fragment)));
  if (lingering.length > 0) {
    const why = `the plan's words are still on the ${otherSide} page: ${lingering.map((f) => `"${f}"`).join(", ")}`;
    const claim = disappeared ? { old: oldTerms.join(" \u00B7 "), new: instead.join(" \u00B7 ") } : { old: instead.join(" \u00B7 "), new: newTerms.join(" \u00B7 ") };
    return { status: "unquotable", side: otherSide, why, ...quoted, plan_claimed: disappeared ? "disappeared" : "appeared", review: [{ ...claim, why }] };
  }
  return { status: "differ", ...quoted, plan: disappeared ? "disappeared" : "appeared", differences: [{ old: oldTerms.join(" \u00B7 "), new: newTerms.join(" \u00B7 ") }] };
}

function judgePlanOnNeitherPage(instead, older, newer) {
  const quoted = { old_terms: [], new_terms: [], offered_instead: instead };
  const onPage = (text) => instead.filter((fragment) => text.includes(comparableText(fragment)));
  const misquoted = instead.filter((fragment) => !onPage(older).includes(fragment) && !onPage(newer).includes(fragment));
  if (misquoted.length > 0) return { status: "unquotable", side: "both", why: misquoted.map((f) => `on neither page: "${f}"`).join("; "), ...quoted };
  if (onPage(older).length === 0 || onPage(newer).length === 0) return { status: "unquotable", side: "both", why: "no words copied from each page to show what it offers instead of the plan", ...quoted };
  return { status: "absent", side: "both", why: "neither page offers the plan", ...quoted };
}

function sameTerms(a, b) {
  return sameList([...a.values].sort(), [...b.values].sort()) && QUALIFIERS.every((name) => sameList(a[name], b[name]));
}

function occursOnce(text, words) {
  return text.includes(words) && !occursMoreThanOnce(text, words);
}

function sharesAWord(line, other) {
  return line.words.length === 0 || line.words.some((word) => other.words.includes(word));
}

function matchCopiedLines(lines, otherLines, otherPage) {
  const unmatched = otherLines.map((line) => ({ line, terms: termsOfLine(decodedText(line)) }));
  const onlyThisSide = [];
  const matched = [];
  for (const line of lines) {
    const terms = termsOfLine(decodedText(line));
    if (terms.values.length === 0 && terms.negations.length === 0) continue;
    const at = unmatched.findIndex((other) => sameTerms(other.terms, terms) && sharesAWord(terms, other.terms));
    if (at >= 0) {
      const [other] = unmatched.splice(at, 1);
      matched.push({ line, other: other.line, shared: terms.words.filter((word) => other.terms.words.includes(word)) });
    } else if (!occursOnce(otherPage, comparableText(line))) {
      onlyThisSide.push(line);
    }
  }
  return { onlyThisSide, matched };
}

export function wordsOfTierName(tier) {
  return termsOfLine(decodedText(tier)).words;
}

function judgeSameAnswer(quoted, older, newer) {
  const fromOld = matchCopiedLines(quoted.old_terms, quoted.new_terms, newer);
  const fromNew = matchCopiedLines(quoted.new_terms, quoted.old_terms, older);
  const matched = fromOld.matched.map(({ line, other, shared }) => ({ old: line, new: other, shared }));
  const review = [
    ...fromOld.onlyThisSide.map((line) => ({ old: line, new: "", why: "the reader called the terms the same, but only the old page states this line" })),
    ...fromNew.onlyThisSide.map((line) => ({ old: "", new: line, why: "the reader called the terms the same, but only the new page states this line" })),
  ];
  if (review.length === 0) return { status: "same", ...quoted, matched };
  return { status: "review", ...quoted, review, matched, why: "the reader called the terms the same, but a line stating a value or a negation is on one page only, so the lines go to review" };
}

export function judgePair(answer, olderText, newerText) {
  if (!answer) return { status: "unquotable", side: "both", why: "the reader's answer could not be parsed" };
  const older = comparableText(olderText);
  const newer = comparableText(newerText);
  const oldTerms = fragmentsOf(answer.old_terms);
  const newTerms = fragmentsOf(answer.new_terms);
  const instead = fragmentsOf(answer.offered_instead);
  const direction = typeof answer.direction === "string" ? answer.direction : null;
  const saysSame = answer.same === true || answer.same === "true";
  if (instead.length > 0 && oldTerms.length === 0 && newTerms.length === 0) return judgePlanOnNeitherPage(instead, older, newer);
  if (!saysSame && instead.length > 0 && (oldTerms.length === 0) !== (newTerms.length === 0)) {
    return judgePlanOnOnePage({ oldTerms, newTerms, instead, older, newer, direction });
  }
  const oldProblem = oldTerms.length === 0 ? "no terms quoted from the old page" : notOnPage(oldTerms, older).map((f) => `not on the old page: "${f}"`).join("; ");
  const newProblem = newTerms.length === 0 ? "no terms quoted from the new page" : notOnPage(newTerms, newer).map((f) => `not on the new page: "${f}"`).join("; ");
  if (oldProblem || newProblem) {
    return { status: "unquotable", side: sideOfBoth(Boolean(oldProblem), Boolean(newProblem)), why: [oldProblem, newProblem].filter(Boolean).join("; "), old_terms: oldTerms, new_terms: newTerms };
  }
  const quoted = { old_terms: oldTerms, new_terms: newTerms, direction };
  if (saysSame) return judgeSameAnswer(quoted, older, newer);
  const differences = [];
  const refuted = [];
  const reworded = [];
  const oneSided = [];
  const unmatched = [];
  const unverifiable = [];
  for (const claim of claimsOf(answer.differences)) {
    const verdict = classifyClaim(claim, older, newer);
    if (verdict.kind === "counts") differences.push(claim);
    else if (verdict.kind === "unverifiable") unverifiable.push({ ...claim, side: verdict.side, why: verdict.why });
    else if (verdict.kind === "one_sided") oneSided.push({ ...claim, why: verdict.why });
    else if (verdict.kind === "unmatched") unmatched.push({ ...claim, why: verdict.why });
    else if (verdict.kind === "reworded") reworded.push({ ...claim, why: verdict.why });
    else refuted.push({ ...claim, why: verdict.why });
  }
  const set = { refuted, reworded, one_sided: oneSided, unmatched };
  if (differences.length > 0) return { status: "differ", ...quoted, differences, ...set, unverifiable };
  if (unverifiable.length > 0) {
    const side = sideOfBoth(unverifiable.some((c) => c.side !== "new"), unverifiable.some((c) => c.side !== "old"));
    return { status: "unquotable", side, why: unverifiable.map((claim) => claim.why).join("; "), ...quoted, ...set, unverifiable };
  }
  const review = [...oneSided, ...unmatched];
  if (review.length > 0) return { status: "review", ...quoted, ...set, review, why: "no difference is a value both pages state moving, so the lines go to review" };
  if (refuted.length > 0 || reworded.length > 0) return { status: "same", ...quoted, ...set };
  return { status: "unquotable", side: "both", why: "the reader said the terms differ but quoted no difference", ...quoted, ...set, unverifiable };
}

export function pairedReaderFor(client, listing) {
  return async (older, newer) => judgePair(parsePairedAnswer(await client.complete(pairedPrompt(listing, older, newer))), older.text, newer.text);
}

export function freeTierRemovalPrompt(record, older, maxLength = MAX_ARCHIVE_PAGE_TEXT_LENGTH) {
  return `You are checking whether an archived pricing page offers any permanent free plan.

THE RECORD:
${record.summary}

THE CURRENT DESCRIPTION (context only):
${record.current_state}

OLD PAGE (saved ${older.day}, truncated):
${String(older.text ?? "").slice(0, maxLength)}

Check only the removal of the free plan. Paid prices, paid limits and the removed plan's limits in THE RECORD are context, not claims this capture must state. Copy the shortest exact fragment of THE RECORD naming the removal into record.
List every plan this page offers for the relevant product, including free plans. Copy each plan's name and a contiguous fragment containing that name and its price or sales terms. Classify it as paid, free, trial or contact_sales. A free trial is not a permanent free plan; a trial needs a stated time limit. Never infer removal from an omitted section, an app shell or a page with no readable plan list. If you cannot read the offered plans, return an empty list. Do not copy our record's wording as page evidence.

Respond with exactly one JSON object and no other text:
{"changes":[],"record":"<removal fragment copied from THE RECORD>","offered_plans":[{"name":"<plan name copied from OLD PAGE>","old_page":"<contiguous plan and pricing fragment copied from OLD PAGE>","kind":"<paid, free, trial or contact_sales>"}]}`;
}

function judgeFreeTierRemoval(answer, record, text) {
  const refusal = (why) => ({ status: "unstated", why, review: [] });
  const plans = answer?.offered_plans;
  if (!Array.isArray(plans) || plans.length === 0) return refusal("the capture has no readable offered-plan list");
  if (String(text ?? "").length < MIN_PAGE_TEXT_LENGTH) return refusal("too little page text to establish the offered plans");
  const claim = String(answer.record ?? "").trim();
  if (!claim || !comparableText(record.summary).includes(comparableText(claim)) || !(/\bfree\b/i.test(claim) && /\b(?:removed?|ended|no longer exists|no free|nothing free)\b/i.test(claim))) return refusal("the quoted record fragment does not state the free-plan removal");
  if (/\bfree forever\b|[\p{Sc}]\s*0(?:\.0+)?\s*\/\s*(?:mo(?:nth)?|year|yr)\b/iu.test(decodedText(text))) return refusal("the capture still states permanent free-plan terms");
  const page = comparableText(text);
  const quoted = [];
  const names = new Set();
  for (const plan of plans) {
    const name = String(plan?.name ?? "").trim();
    const line = String(plan?.old_page ?? "").trim();
    if (!name || !line || !page.includes(comparableText(line)) || !comparableText(line).includes(comparableText(name))) return refusal("an offered plan is not quoted from the capture");
    if (names.has(comparableText(name))) return refusal("the offered-plan list repeats a plan");
    names.add(comparableText(name));
    if (plan.kind === "free" || /\bfree\b/i.test(name) && plan.kind !== "trial") return refusal("the capture still offers a free plan");
    if (plan.kind === "paid") {
      const price = [...decodedText(line).matchAll(/[\p{Sc}]\s*(\d[\d,]*(?:\.\d+)?)/gu)];
      if (price.length === 0 || price.some((match) => Number(match[1].replaceAll(",", "")) === 0)) return refusal("an offered paid plan has no positive quoted price");
    } else if (plan.kind === "trial") {
      if (!/\btrial\b/i.test(line) || !/\b\d+[ -]*(?:day|week|month)s?\b/i.test(line)) return refusal("an offered trial has no quoted time limit");
    } else if (plan.kind === "contact_sales") {
      if (!/\b(?:custom|contact|talk|sales)\b/i.test(line)) return refusal("an offered sales plan has no quoted sales terms");
    } else return refusal("an offered plan has no recognized pricing kind");
    quoted.push({ record: claim, old: line });
  }
  if (!plans.some((plan) => plan.kind === "paid" || plan.kind === "contact_sales")) return refusal("the capture lists only a trial");
  return { status: "removal_stated", stated_then: quoted, offered_plans: plans };
}

export function statedBeforePrompt(record, older, maxLength = MAX_ARCHIVE_PAGE_TEXT_LENGTH) {
  if (record.change_type === "free_tier_removed") return freeTierRemovalPrompt(record, older, maxLength);
  const clip = (text) => String(text ?? "").slice(0, maxLength);
  return `You are checking whether an old copy of a web page already said what a change record calls new.

THE RECORD (written from a reading of this page on ${record.date}):
${record.summary}

THE NEW DESCRIPTION:
${record.current_state}

OLD PAGE (saved ${older.day}, truncated):
${clip(older.text)}

Step 1. List only the resulting terms THE RECORD calls new: each resulting price, limit, included feature or condition, who can get the plan, and any product or plan it says has ended or is ending. THE NEW DESCRIPTION gives context, not additional claims to check. Copy a short exact fragment of THE RECORD for each resulting term. In "from X to Y", check Y, never X. Exclude previous-term clauses introduced by "before", "previously", "instead of" or "down from", and sentences about archive copies, changelogs or our evidence. A statement that an old limit is no longer listed or mentioned is an observation about missing text, not a resulting allowance: omit it, without inferring an unlimited allowance. Do not ask the page to describe the transition or say that a limit increased. For a removal, keep the removal claim; the page must state the removal, not merely omit the old plan.
Step 2. For each change, copy the words on OLD PAGE that already state the same thing, exactly as they appear on that page, as one short fragment. Never reword the fragment, and never join words that are apart on the page. If OLD PAGE does not state it, leave it empty.

Respond with exactly one JSON object and no other text:
{"changes":[{"record":"<words copied from THE RECORD>","old_page":"<words copied from OLD PAGE, or empty>"}]}`;
}

function figuresStated(words) {
  return new Set(valuesStated(words).filter((value) => !VALUE_WORDS.includes(value)));
}

function allowanceFigures(text) {
  const source = String(text ?? "").toLowerCase();
  const matches = [...source.matchAll(FIGURE)];
  return matches.map((match, index) => {
    const end = Math.min(matches[index + 1]?.index ?? source.length, match.index + match[0].length + 65);
    const tail = source.slice(match.index + match[0].length, end).split(/[,;().!?]/)[0];
    const terms = termsOfLine(match[0] + tail);
    return { figure: valuesStated(match[0])[0], currency: source.slice(Math.max(0, match.index - 3), match.index).match(/[\p{Sc}]/u)?.[0] ?? "", ...terms };
  });
}

function changedFiguresIn(text, previous) {
  const earlier = allowanceFigures(previous);
  const labels = (term) => term.words.filter((word) => !["free", "plan", "tier", "limit", "now", "include", "ha", "allow", "cap"].includes(word));
  return new Set(allowanceFigures(text).filter((term) => !earlier.some((old) =>
    term.figure === old.figure && term.currency === old.currency && QUALIFIERS.every((name) => sameList(term[name], old[name])) &&
    (labels(term).some((word) => labels(old).includes(word)) || labels(term).length === 0 && labels(old).length === 0 && (term.units.length > 0 || term.periods.length > 0))
  )).map((term) => term.figure));
}

const LINE_STATING_THE_REMOVAL = {
  product_deprecated: { states: (line) => readDeprecation(line) !== null, missing: "no line copied from it reads as a deprecation" },
  free_tier_removed: { states: (line) => descriptionDeniesFreeTier(line), missing: "no line copied from it says there is no free tier" },
  restriction: null,
  open_source_killed: null,
};

function removalUnstatedBecause(changeType, changes) {
  const rule = LINE_STATING_THE_REMOVAL[changeType];
  if (!rule) return `${changeType} records always go to review`;
  return changes.some((change) => rule.states(change.old)) ? null : rule.missing;
}

export function resultingTermsIn(summary) {
  return String(summary ?? "").split(/(?<=[.!?])\s+(?=[A-Z])/).map((sentence) => sentence
    .replace(/^[^;]*\bno longer\s+(?:explicitly\s+)?(?:listed|mentioned|specified|mentions?|lists?|specifies)\b[^;]*/gi, "")
    .replace(/\bfrom\s+[^;]+?\s+to\s+/gi, "to ")
    .replace(/(^|[;,(])\s*before\b[^;]*/gi, "$1")
    .replace(/\bpreviously\b[^;]*/gi, "")
    .replace(/\b(?:instead of|down from)\s+.*?(?=;|,\s+(?:and|with|including)\b|$)/gi, "")
    .replace(/\b(?:the Internet Archive(?:'s|’s)? copy|its changelog|the changelog)\b[^;]*/gi, "")
  ).join(" ");
}

export function judgeStatedBefore(answer, record, olderText) {
  if (record.change_type === "free_tier_removed") return judgeFreeTierRemoval(answer, record, olderText);
  if (!Array.isArray(answer?.changes)) return { status: "unstated", why: "the reader's answer could not be parsed", review: [] };
  const changes = answer.changes
    .map((change) => ({ record: String(change?.record ?? "").trim(), old: String(change?.old_page ?? "").trim() }))
    .filter((change) => /[\p{L}\d]/u.test(resultingTermsIn(change.record)));
  if (changes.length === 0) return { status: "unstated", why: "the reader named no change in the record", review: [] };
  const summary = comparableText(record.summary);
  const notInRecord = changes.filter((change) => !summary.includes(comparableText(change.record)));
  if (notInRecord.length > 0) return { status: "unstated", why: `the reader named changes that are not the record's words: ${quoteAll(notInRecord.map((change) => change.record))}`, review: [] };
  const named = new Set(changes.flatMap((change) => [...figuresStated(change.record)]));
  const reading = figuresStated(record.current_state);
  const leftOut = [...changedFiguresIn(resultingTermsIn(record.summary), record.previous_state)].filter((figure) => reading.has(figure) && !named.has(figure));
  if (leftOut.length > 0) return { status: "unstated", why: `the reader named no change stating ${quoteAll(leftOut)}, which the record's summary and its reading both state`, review: [] };
  const page = comparableText(olderText);
  const whyUnstated = (change) => {
    if (!comparableText(change.old)) return "the capture does not state it";
    if (!page.includes(comparableText(change.old))) return "these words are not on the capture";
    const onTheLine = figuresStated(change.old);
    const missing = [...changedFiguresIn(resultingTermsIn(change.record), record.previous_state)].filter((figure) => reading.has(figure) && !onTheLine.has(figure));
    return missing.length > 0 ? `the capture's words do not state ${quoteAll(missing)}` : null;
  };
  const unstated = changes.map((change) => ({ ...change, why: whyUnstated(change) })).filter((change) => change.why);
  if (unstated.length === 0) {
    if (!Object.hasOwn(LINE_STATING_THE_REMOVAL, record.change_type)) return { status: "stated", stated_then: changes };
    const removalUnstated = removalUnstatedBecause(record.change_type, changes);
    return removalUnstated ? { status: "unstated", why: removalUnstated, review: [] } : { status: "removal_stated", stated_then: changes };
  }
  return {
    status: "unstated",
    why: `no line already states ${quoteAll(unstated.map((change) => change.record))}`,
    review: unstated,
  };
}

export function statedBeforeReaderFor(client, record) {
  return async (older) => judgeStatedBefore(parseStatedBeforeAnswer(await client.complete(statedBeforePrompt(record, older))), record, older.text);
}

export const PREVIOUS_VALUE_MAX_PAGE_TEXT_LENGTH = 100_000;

export function previousValuePrompt(record, older, maxLength = PREVIOUS_VALUE_MAX_PAGE_TEXT_LENGTH) {
  return `You are checking whether an archived page states an earlier value that a change record says changed.

THE RECORD (${record.date}):
${record.summary}

THE PREVIOUS DESCRIPTION:
${record.previous_state}

THE NEW DESCRIPTION:
${record.current_state}

ARCHIVED PAGE (saved ${older.day}):
${String(older.text ?? "").slice(0, maxLength)}

Find only one earlier value that THE RECORD says was replaced or removed. One supported value is sufficient: stop after the first clear witness. Do not include a value that is unchanged, or a limit merely absent from THE PREVIOUS DESCRIPTION. All quoted fragments must refer to the same plan and feature; a different plan's price is not evidence.
Copy three short exact fragments: the earlier value from THE PREVIOUS DESCRIPTION or THE RECORD, its replacement from THE NEW DESCRIPTION, and the earlier value from ARCHIVED PAGE. Use the smallest fragment naming that value, without unrelated limits or extra parenthetical values. For a qualitative feature without a number, the earlier fragment must occur word for word in both THE RECORD or THE PREVIOUS DESCRIPTION and ARCHIVED PAGE. For example, quote "cloud models" against "Access cloud models", rather than a whole description naming individual models or other features. Generic words such as "Free plan" alone do not state a feature. ${record.change_type === "free_tier_removed" && /\bFree forever\b/.test(record.previous_state ?? "") ? 'For this free-plan removal, an exact "Free forever" fragment is sufficient evidence of the old free plan; do not include its unrelated numeric limits. ' : ""}Do not join separated words. Give an empty list if the page states no such earlier value.

Respond with exactly one JSON object and no other text:
{"previous_values":[{"previous":"<earlier value copied from the previous description or record>","current":"<replacement copied from the new description>","old_page":"<earlier value copied from the archived page>"}]}`;
}

export function currentValuePrompt(record, older, maxLength = PREVIOUS_VALUE_MAX_PAGE_TEXT_LENGTH) {
  const context = previousValuePrompt(record, older, maxLength).split("\n\nFind only")[0]
    .replace("You are checking whether an archived page states an earlier value that a change record says changed.", "You are checking whether an archived page already states a replacement value.");
  return `${context}

Inspect every occurrence of each changed feature for the same plan, including both plan cards and comparison tables. Quote any replacement value from THE NEW DESCRIPTION that ARCHIVED PAGE already states, even when a stale table also states the earlier value. Exclude unchanged allowances and other plans or features. Copy the earlier value from THE PREVIOUS DESCRIPTION or THE RECORD and its replacement from THE NEW DESCRIPTION, then quote the replacement from ARCHIVED PAGE. All three fragments must be exact and refer to the same plan and feature. Never join separated words. Return an empty list only after checking the complete page.

Respond with exactly one JSON object and no other text:
{"current_values":[{"previous":"<earlier value copied from the previous description or record>","current":"<replacement copied from the new description>","old_page":"<replacement value copied from the archived page>"}]}`;
}

function changedValueOnPage(value, record, page, currentOnPage) {
  const before = comparableText(record.previous_state);
  const summary = comparableText(record.summary);
  const current = comparableText(record.current_state);
  let previous = String(value?.previous ?? "").trim();
  const replacement = String(value?.current ?? "").trim();
  const old = String(value?.old_page ?? "").trim();
  if (![previous, replacement, old].every((words) => comparableText(words))) return { why: "an earlier-value fragment is empty" };
  const inRecord = (words) => before.includes(comparableText(words)) || summary.includes(comparableText(words));
  if (!inRecord(previous) && valuesStated(previous).length === 0) {
    const feature = previous.replace(/^access(?: to)?\s+/i, "");
    if (inRecord(feature) && comparableText(old).includes(comparableText(feature))) previous = feature;
  }
  if (!inRecord(previous)) return { why: "the earlier value is not quoted from the record" };
  if (!current.includes(comparableText(replacement))) return { why: "the replacement is not quoted from the new description" };
  if (!page.includes(comparableText(old))) return { why: "the value is not quoted from the capture" };
  const was = termsOfLine(previous);
  if (comparableText(previous) === comparableText(replacement) || (was.values.length > 0 && sameTerms(was, termsOfLine(replacement)))) return { why: "the quoted earlier and replacement values do not differ" };
  const expected = currentOnPage ? replacement : previous;
  const expectedTerms = termsOfLine(expected);
  const freePlanStated = !currentOnPage && record.change_type === "free_tier_removed" && /\bfree forever\b/i.test(previous) && comparableText(old).includes(comparableText(expected));
  const qualitativeValueStated = freePlanStated || expectedTerms.words.filter((word) => !["free", "plan", "tier"].includes(word)).length >= 2 && comparableText(old).includes(comparableText(expected));
  if (expectedTerms.values.length === 0 ? !qualitativeValueStated : valuesMissingFrom(expectedTerms.values, valuesStated(old)).length > 0) return { why: "the capture's words do not state the quoted value" };
  return { value: { previous, current: replacement, old } };
}

export function judgePreviousValue(answer, record, olderText, maxLength = PREVIOUS_VALUE_MAX_PAGE_TEXT_LENGTH) {
  const unknown = (why) => ({ status: "unknown", why });
  if (!Array.isArray(answer?.previous_values) || !Array.isArray(answer?.current_values)) return unknown("the earlier-value reader did not check both earlier and replacement values");
  const page = comparableText(String(olderText ?? "").slice(0, maxLength));
  const current = answer.current_values.map((value) => changedValueOnPage(value, record, page, true));
  if (current.some((value) => value.why)) return unknown(current.find((value) => value.why).why);
  const previous = answer.previous_values.map((value) => changedValueOnPage(value, record, page, false));
  const values = previous.filter((value) => value.value).map((value) => value.value);
  if (current.length > 0) return { status: "new_stated", current_values: current.map((value) => value.value), previous_values: values };
  if (String(olderText ?? "").length > maxLength) return unknown("the earlier-value reader did not see the whole capture");
  if (previous.some((value) => value.why)) return unknown(previous.find((value) => value.why).why);
  if (values.length > 0) return { status: "stated", current_values_checked: true, previous_values: values };
  return { status: "not_stated", current_values_checked: true };
}

export function previousValueReaderFor(client, record) {
  return async (older) => {
    const previous = parseAnswerHolding(await client.complete(previousValuePrompt(record, older)), "previous_values");
    const current = parseAnswerHolding(await client.complete(currentValuePrompt(record, older)), "current_values");
    return judgePreviousValue({ previous_values: previous?.previous_values, current_values: current?.current_values }, record, older.text);
  };
}

export const CAPTURE_WINDOW_DAYS = 60;
export const MAX_READS_PER_BRACKET = 12;
export const MAX_MOVES_BRACKETED = 3;
export const OURS_MIN_CAPTURE_AGE_DAYS = 365;
export const OURS_MAX_HISTORICAL_READINGS = 3;

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

function showsNoMove(verdict) {
  return verdict?.status === "same" || verdict?.status === "absent";
}

export function bracketStatesRecord(bracket) {
  const older = bracket.claim_proof?.older?.verdict;
  const newer = bracket.claim_proof?.newer?.verdict;
  return older?.status === "stated" && older.current_values_checked === true && older.previous_values?.length > 0 &&
    ["stated", "removal_stated"].includes(newer?.status) && newer.stated_then?.length > 0;
}

export async function readBracketClaims(older, newer, readPreviousValue, readStatedBefore) {
  const witness = async (page, read) => {
    let verdict;
    try {
      verdict = read ? await read(page) : { status: "unknown", why: "no reader was supplied for this endpoint" };
    } catch (error) {
      verdict = { status: "unknown", why: `the endpoint reader failed: ${error?.message ?? error}` };
    }
    return { day: page.day, url: page.capture ? archivedCopyUrl(page.capture) : null, verdict };
  };
  return {
    older: await witness(older, readPreviousValue),
    newer: await witness(newer, readStatedBefore),
  };
}

async function bracketMoves({ from, until, pool, earlierCaptures, compare, pageOf, readClaims, statesWhatTheRecordCallsNew = async () => null, planNotOfferedAtStart = false }) {
  const brackets = [];
  let start = from;
  let candidates = pool;
  let withoutThePlanIsOld = planNotOfferedAtStart;
  while (brackets.length < MAX_MOVES_BRACKETED) {
    let lo = -1;
    let hi = candidates.length;
    let reads = 0;
    let startStatesIt;
    const statesItWhereTheStartDoesNot = async (page) => {
      if (startStatesIt === undefined) startStatesIt = await statesWhatTheRecordCallsNew(start);
      return startStatesIt === false ? statesWhatTheRecordCallsNew(page) : null;
    };
    const sideOfAReviewReading = async (page) => {
      const states = await statesItWhereTheStartDoesNot(page);
      return states === true ? "new" : states === false ? "old" : null;
    };
    const sideOfTheMove = async (verdict, page) => {
      if (verdict?.status === "same") return "old";
      if (verdict?.status === "differ") return "new";
      if (verdict?.status === "absent") return withoutThePlanIsOld ? "old" : null;
      if (verdict?.status === "review") return sideOfAReviewReading(page);
      return null;
    };
    while (hi - lo > 1 && reads < MAX_READS_PER_BRACKET) {
      const mid = Math.floor((lo + hi) / 2);
      const page = await pageOf(candidates[mid]);
      const verdict = page ? await compare(start, page) : null;
      if (page) reads++;
      const side = page ? await sideOfTheMove(verdict, page) : null;
      if (side === "old") lo = mid;
      else if (side === "new") hi = mid;
      else {
        candidates = [...candidates.slice(0, mid), ...candidates.slice(mid + 1)];
        hi--;
      }
    }
    let lastOld = lo === -1 ? start : await pageOf(candidates[lo]);
    let firstNew = hi === candidates.length ? until : await pageOf(candidates[hi]);
    let proof = await readClaims(lastOld, firstNew);
    let adjacent = hi - lo <= 1;
    const rejected = [];
    if (proof.older.verdict.status === "new_stated") {
      let newer = lastOld;
      rejected.push(proof.older);
      const earlier = earlierCaptures.filter((capture) => capture.timestamp < lastOld.capture.timestamp).sort((a, b) => b.timestamp.localeCompare(a.timestamp));
      for (const capture of earlier.slice(0, MAX_READS_PER_BRACKET)) {
        const page = await pageOf(capture);
        if (!page) continue;
        const candidate = await readClaims(page, newer);
        if (candidate.older.verdict.status === "new_stated") {
          rejected.push(candidate.older);
          newer = page;
          continue;
        }
        if (bracketStatesRecord({ claim_proof: candidate }) && !brackets.some((held) => held.last_old_capture === candidate.older.url && held.first_new_capture === candidate.newer.url)) {
          firstNew = newer;
          lastOld = page;
          proof = candidate;
          adjacent = !earlierCaptures.some((copy) => copy.timestamp > page.capture.timestamp && copy.timestamp < newer.capture.timestamp);
        }
        break;
      }
    }
    brackets.push({
      last_old: lastOld.day,
      first_new: firstNew.capture ? firstNew.day : null,
      last_old_capture: lastOld.capture ? archivedCopyUrl(lastOld.capture) : null,
      first_new_capture: firstNew.capture ? archivedCopyUrl(firstNew.capture) : null,
      narrowed_to_adjacent_captures: adjacent,
      claim_proof: proof,
      ...(rejected.length ? { rejected_older_endpoints: rejected } : {}),
    });
    if (hi === candidates.length) return { brackets, moves_complete: true };
    const onward = await compare(firstNew, until);
    if (onward?.status === "review") return { brackets, moves_complete: (await statesItWhereTheStartDoesNot(firstNew)) === true };
    if (showsNoMove(onward)) return { brackets, moves_complete: true };
    if (onward.status !== "differ") return { brackets, moves_complete: false };
    start = firstNew;
    candidates = candidates.slice(hi + 1);
    withoutThePlanIsOld = false;
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
  const byUrl = new Map(captures.map((capture) => [captureUrl(capture), capture]));
  return { captures: [...byUrl.values()].sort((a, b) => a.timestamp.localeCompare(b.timestamp)) };
}

function describeDay(day, reference, side) {
  return { day, gap_days: daysBetween(day, reference), side };
}

function sideOfRecordDay(day, recordDay) {
  return day < recordDay ? "before" : day > recordDay ? "after" : "on";
}

export async function settleAgainstCaptures({ url, finalUrl, textDay, recordDay, todayText, today, archive, readPair, readStatedBefore, readPreviousValue, onRead = () => {}, windowDays = CAPTURE_WINDOW_DAYS }) {
  let reads = 0;
  if (!textDay) return { outcome: "text_day_unknown", reads };
  const judgedOn = recordDay && recordDay < today ? recordDay : today;
  const urls = finalUrl && !samePage(url, finalUrl) ? [url, finalUrl] : [url];
  const listed = await capturesOfEither(archive, urls, null, today);
  if (listed.unavailable) return { outcome: "no_usable_capture", text_day: textDay, record_day: judgedOn, reads, tried: [], why: `the Archive did not answer: ${listed.unavailable}` };
  const captures = listed.captures;

  const texts = new Map();
  const captureProblems = new Map();
  const pageOf = async (capture) => {
    const key = captureUrl(capture);
    if (!texts.has(key)) {
      const stored = await archive.captureHtml(capture);
      const redirect = !stored.unavailable && (
        /<meta\b[^>]*http-equiv\s*=\s*["']?refresh\b/i.test(stored.html) ||
        [...stored.html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script\s*>/gi)].some((match) => /^\s*(?:(?:window|document|self|top)\.)?location(?:(?:\.href)?\s*=\s*["'][^"']+["']|\.(?:replace|assign)\s*\(\s*["'][^"']+["']\s*\))\s*;?\s*$/i.test(match[1]))
      );
      const text = stored.unavailable || redirect ? "" : stripHtml(stored.html);
      if (stored.unavailable) captureProblems.set(key, { unavailable: stored.unavailable });
      else if (redirect || text.length < MIN_PAGE_TEXT_LENGTH) captureProblems.set(key, { skipped: redirect ? "redirect shell" : "too little page text" });
      texts.set(key, text.length >= MIN_PAGE_TEXT_LENGTH ? text : null);
    }
    const text = texts.get(key);
    const day = dayOfTimestamp(capture.timestamp);
    return text === null ? null : { page: `capture ${day}`, day, text, capture };
  };
  const todayPage = { page: "today", day: today, text: todayText };
  let unsettledPlan = null;
  const compare = async (older, newer) => {
    reads++;
    const verdict = await readPair(older, newer);
    onRead({ older: older.page, newer: newer.page, verdict });
    if (!unsettledPlan && verdict?.status === "unquotable" && verdict.review) unsettledPlan = { page: newer, verdict };
    return verdict;
  };

  const statedBeforeReadings = new Map();
  const statedBefore = async (older) => {
    if (!readStatedBefore) return { status: "unstated", why: "no reader was asked for a line that already states what the record calls new", review: [] };
    const key = older.capture ? captureUrl(older.capture) : older.page;
    if (!statedBeforeReadings.has(key)) {
      reads++;
      const verdict = await readStatedBefore(older);
      onRead({ older: older.page, newer: "the record", verdict });
      statedBeforeReadings.set(key, verdict);
    }
    return statedBeforeReadings.get(key);
  };
  const statesWhatTheRecordCallsNew = async (page) => {
    const verdict = await statedBefore(page);
    if (verdict.status === "stated" || verdict.status === "removal_stated") return true;
    return verdict.status === "unstated" && verdict.review?.length > 0 ? false : null;
  };
  const previousValueReadings = new Map();
  const previousValue = async (older) => {
    const key = older.capture ? captureUrl(older.capture) : older.page;
    if (!previousValueReadings.has(key)) {
      reads++;
      let verdict;
      try {
        verdict = readPreviousValue ? await readPreviousValue(older) : { status: "unknown", why: "no earlier-value reader was supplied" };
      } catch (error) {
        verdict = { status: "unknown", why: `the earlier-value reader failed: ${error?.message ?? error}` };
      }
      onRead({ older: older.page, newer: "the record's previous values", verdict });
      previousValueReadings.set(key, verdict);
    }
    return previousValueReadings.get(key);
  };
  const bracketStatedBefore = async (page) => {
    try {
      return await statedBefore(page);
    } catch (error) {
      const verdict = { status: "unknown", why: `the new-claim reader failed: ${error?.message ?? error}` };
      onRead({ older: page.page, newer: "the record", verdict });
      statedBeforeReadings.set(page.capture ? captureUrl(page.capture) : page.page, verdict);
      return verdict;
    }
  };
  const readClaims = (older, newer) => readBracketClaims(older, newer, previousValue, bracketStatedBefore);

  const describePage = (page) => ({ page: page.page, ...describeDay(page.day, judgedOn, sideOfRecordDay(page.day, judgedOn)) });
  const forReview = (page, verdict) => ({ outcome: "no_usable_capture", compared_with: describePage(page), review: verdict.review, why: verdict.why });
  const unsettled = (result) => (unsettledPlan ? { ...result, ...forReview(unsettledPlan.page, unsettledPlan.verdict), why: `${result.why}; ${unsettledPlan.verdict.why}` } : result);

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
      if (verdict.status === "same" || verdict.status === "differ" || verdict.status === "review") {
        end = page;
        first = verdict;
        break;
      }
      if (verdict.side === "old" || verdict.side === "both") return { next: true, why: `the capture settles nothing: ${verdict.why}` };
      unreadable.push(`${page.page}: ${verdict.why}`);
    }
    if (!end) return unsettled({ outcome: "no_usable_capture", why: `no reading of the page on the record's day settles it (${unreadable.join("; ")})` });
    const comparedWith = describePage(end);
    const agreement = async (verdict, laterMoves, comparison) => {
      const comparedWith = describePage(comparison);
      if (side !== "before") return { next: true, why: "the capture states the terms the page stated on the record's day, but a capture after our text's day cannot show the difference was ours" };
      const before = await statedBefore(old);
      if (before.status === "removal_stated") return { outcome: "removal_stated_before", compared_with: comparedWith, stated_then: before.stated_then, why: `the ${old.page} already states the removal, so it predates our text: to be dated` };
      if (before.status !== "stated") return { outcome: "no_usable_capture", compared_with: comparedWith, review: before.review, why: `the ${old.page} states the plan's terms as the page did on the record's day, but ${before.why}` };
      const cutoff = new Date(Date.parse(`${today}T00:00:00Z`) - OURS_MIN_CAPTURE_AGE_DAYS * 86_400_000).toISOString().slice(0, 10);
      const eligible = captures.filter((capture) => dayOfTimestamp(capture.timestamp) <= cutoff).sort((a, b) => b.timestamp.localeCompare(a.timestamp));
      const candidates = old.day <= cutoff ? [old.capture, ...eligible.filter((capture) => captureUrl(capture) !== captureUrl(old.capture))] : eligible;
      const historicalProof = { minimum_age_days: OURS_MIN_CAPTURE_AGE_DAYS, cutoff_day: cutoff, readings: [], skipped: [] };
      for (const capture of candidates) {
        const witness = { day: dayOfTimestamp(capture.timestamp), url: archivedCopyUrl(capture) };
        const earlier = await pageOf(capture);
        if (!earlier) {
          const problem = captureProblems.get(captureUrl(capture));
          if (problem?.unavailable) return { outcome: "no_usable_capture", compared_with: comparedWith, historical_proof: historicalProof, prior_capture: witness, why: `the Archive did not return an eligible historical capture: ${problem.unavailable}` };
          historicalProof.skipped.push({ ...witness, why: problem?.skipped ?? "unreadable capture" });
          continue;
        }
        const historical = await statedBefore(earlier);
        historicalProof.readings.push({ ...witness, verdict: historical });
        if (historical.status === "stated") return { outcome: "ours", compared_with: comparedWith, terms_then: verdict.old_terms, stated_then: before.stated_then, historical_proof: historicalProof, later_moves: laterMoves };
        if (historicalProof.readings.length >= OURS_MAX_HISTORICAL_READINGS) break;
      }
      return { outcome: "no_usable_capture", compared_with: comparedWith, historical_proof: historicalProof, why: "none of the three newest readable year-old captures states what the record calls new" };
    };
    const agreed = async (verdict, laterMoves = [], comparison = end) => {
      if (verdict.status !== "review") return agreement(verdict, laterMoves, comparison);
      try {
        const before = await statedBefore(old);
        if (side !== "before" || !["stated", "removal_stated"].includes(before.status)) return forReview(comparison, verdict);
        const result = await agreement(verdict, laterMoves, comparison);
        return { ...result, compared_with: result.compared_with ?? describePage(comparison), review: verdict.review, review_reason: verdict.why, settled_from_review: ["ours", "removal_stated_before"].includes(result.outcome) };
      } catch (error) {
        return { outcome: "reader_failed", compared_with: describePage(comparison), review: verdict.review, review_reason: verdict.why, why: `the reader failed: ${error?.message ?? error}` };
      }
    };

    let deciding = first;
    let moves;
    if (first.status === "review") return agreed(first);
    if (first.status === "same") {
      if (!(end.capture && end.day < judgedOn)) return agreed(first);
      const now = await compare(old, todayPage);
      if (now.status === "same") return agreed(first);
      if (now.status === "review") return agreed(now, [], todayPage);
      if (now.status !== "differ") return unsettled({ outcome: "no_usable_capture", compared_with: comparedWith, why: `the capture before the record's day states the old capture's terms, but the reader could not compare today's page: ${now.why}` });
      deciding = now;
      moves = await bracketMoves({ from: end, until: todayPage, pool: captures.filter((capture) => capture.timestamp > end.capture.timestamp), earlierCaptures: captures, compare, pageOf, readClaims, statesWhatTheRecordCallsNew });
    } else {
      const pool = captures.filter((capture) => capture.timestamp > old.capture.timestamp && (!end.capture || capture.timestamp < end.capture.timestamp));
      moves = await bracketMoves({ from: old, until: end, pool, earlierCaptures: captures, compare, pageOf, readClaims, statesWhatTheRecordCallsNew, planNotOfferedAtStart: first.plan === "appeared" });
    }
    const placed = moves.brackets.map((bracket) => ({ ...bracket, relative_to_record: placeBesideRecord(bracket, judgedOn, today) }));
    const unverified = placed.filter((bracket) => !bracketStatesRecord(bracket));
    const verified = placed.filter(bracketStatesRecord);
    const recordMoves = verified.filter((bracket) => bracket.relative_to_record !== "after");
    const laterMoves = verified.filter((bracket) => bracket.relative_to_record === "after");
    if (recordMoves.length === 0) {
      if (unverified.length > 0) return {
        outcome: "no_usable_capture",
        compared_with: comparedWith,
        why: "no bracket's endpoints establish the record's earlier value and new claim",
        differences: deciding.differences,
        unverified_brackets: unverified,
        later_moves: laterMoves,
      };
      return agreed(deciding, laterMoves);
    }
    return {
      outcome: "vendor_changed",
      compared_with: comparedWith,
      previous_state: (deciding.plan === "appeared" ? deciding.offered_instead : deciding.old_terms).join(" \u00B7 "),
      terms_then: deciding.old_terms,
      terms_on_record_day: deciding.new_terms,
      ...(deciding.plan ? { plan: deciding.plan, offered_instead: deciding.offered_instead } : {}),
      differences: deciding.differences,
      direction: deciding.direction,
      brackets: recordMoves,
      ...(unverified.length ? { unverified_brackets: unverified } : {}),
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
    return { ...settled, text_day: textDay, record_day: judgedOn, capture: { ...at, url: archivedCopyUrl(capture) }, reads, ...(tried.length ? { tried } : {}) };
  }
  return unsettled({
    outcome: "no_usable_capture",
    text_day: textDay,
    record_day: judgedOn,
    reads,
    tried,
    why: tried.length ? "no capture settled it" : `no capture on or before our text's day, nor within ${windowDays} days after it`,
  });
}
