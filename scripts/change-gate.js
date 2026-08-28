export const REJECT_NULL_COMPARISON = "null_comparison";
export const REJECT_STATES_NO_DIFFERENCE = "states_no_difference";
export const REJECT_CONFIRMED_UNCHANGED = "confirmed_unchanged";

export const GATE_REASONS = [
  REJECT_NULL_COMPARISON,
  REJECT_STATES_NO_DIFFERENCE,
  REJECT_CONFIRMED_UNCHANGED,
];

const QUANTITY_CHANGE_TYPES = ["limits_reduced", "limits_increased"];

const COMPARISON_CONNECTIVES = [
  "instead of",
  "down from",
  "up from",
  "reduced from",
  "increased from",
  "rather than",
  "previously",
];

const AGREEMENT_PHRASES = [
  "matches the stored",
  "matches what we",
  "matches our stored",
  "aligns with the stored",
  "same as the stored",
  "identical to the stored",
  "consistent with the stored",
  "unchanged from the stored",
  "agrees with the stored",
  "confirms the stored",
  "no change from the stored",
  "no changes from the stored",
];

const OPERAND_WINDOW = 30;
const NUMBER = /\d+(?:,\d{3})*(?:\.\d+)?/g;

export function quantities(text) {
  if (typeof text !== "string") return [];
  return [...text.matchAll(NUMBER)].map((m) => Number(m[0].replace(/,/g, "")));
}

function multisetEqual(a, b) {
  if (a.length !== b.length) return false;
  const sortNum = (xs) => [...xs].sort((x, y) => x - y);
  const left = sortNum(a);
  const right = sortNum(b);
  return left.every((v, i) => v === right[i]);
}

function containsAll(haystack, needles) {
  const pool = [...haystack];
  for (const n of needles) {
    const at = pool.indexOf(n);
    if (at === -1) return false;
    pool.splice(at, 1);
  }
  return true;
}

export function nullComparisons(summary) {
  if (typeof summary !== "string") return [];
  const lower = summary.toLowerCase();
  const found = [];
  for (const connective of COMPARISON_CONNECTIVES) {
    let at = lower.indexOf(connective);
    while (at !== -1) {
      const before = summary.slice(Math.max(0, at - OPERAND_WINDOW), at);
      const after = summary.slice(at + connective.length, at + connective.length + OPERAND_WINDOW);
      const left = quantities(before).pop();
      const right = quantities(after).shift();
      if (left !== undefined && right !== undefined && left === right) {
        found.push({ connective, value: left });
      }
      at = lower.indexOf(connective, at + connective.length);
    }
  }
  return found;
}

export function assertsAgreement(summary) {
  if (typeof summary !== "string") return false;
  const lower = summary.toLowerCase();
  return AGREEMENT_PHRASES.some((phrase) => lower.includes(phrase));
}

export function describesChange(entry) {
  const previous = quantities(entry?.previous_state);
  const current = quantities(entry?.current_state);

  const nulls = nullComparisons(entry?.summary);
  if (nulls.length > 0 && containsAll(current, previous)) {
    return {
      ok: false,
      reason: REJECT_NULL_COMPARISON,
      detail: `summary states "${nulls[0].connective}" between two values of ${nulls[0].value} and no stored quantity is absent from the current state`,
    };
  }

  if (
    QUANTITY_CHANGE_TYPES.includes(entry?.change_type) &&
    assertsAgreement(entry?.summary) &&
    multisetEqual(previous, current)
  ) {
    return {
      ok: false,
      reason: REJECT_STATES_NO_DIFFERENCE,
      detail: `${entry.change_type} claimed, summary asserts the page matches what we stored, and the two states carry the same quantities`,
    };
  }

  return { ok: true };
}

export function changeConfirmationPrompt(entry) {
  return `A monitoring job compared a stored description of a vendor's free tier against the vendor's live page and reported a change. Decide whether the report actually describes a change.

STORED DESCRIPTION (what we published before):
${entry.previous_state}

CURRENT PAGE (what the job read today):
${entry.current_state}

THE JOB'S REPORT:
${entry.summary}

Answer "no" if the two descriptions state the same terms in different words, if the report restates the stored description, if the report says the page matches what was stored, or if the only difference is wording, formatting, or detail the stored description never claimed.

Answer "yes" only if a developer relying on the stored description would get something different today.

Respond with EXACTLY one JSON object and no other text:
{"change":"yes"}
{"change":"no","reason":"<short reason>"}`;
}

export function parseConfirmation(raw) {
  const text =
    typeof raw === "string"
      ? raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/```$/, "").trim()
      : "";
  const accept = (parsed) =>
    parsed && (parsed.change === "yes" || parsed.change === "no") ? parsed : null;
  try {
    const parsed = accept(JSON.parse(text));
    if (parsed) return { verdict: parsed.change, reason: parsed.reason ?? null };
  } catch {
    const match = text.match(/\{[^}]*\}/);
    if (match) {
      try {
        const parsed = accept(JSON.parse(match[0]));
        if (parsed) return { verdict: parsed.change, reason: parsed.reason ?? null };
      } catch { /* fall through */ }
    }
  }
  return { verdict: "unparsed", reason: null };
}

export async function confirmDescribesChange(client, entry) {
  return parseConfirmation(await client.complete(changeConfirmationPrompt(entry)));
}

export async function gateCandidates(candidates, options = {}) {
  const confirmFn = options.confirmFn;
  const accepted = [];
  const rejected = [];
  const unchecked = [];

  for (const candidate of candidates) {
    const verdict = describesChange(candidate);
    if (!verdict.ok) {
      rejected.push({ candidate, reason: verdict.reason, detail: verdict.detail });
      continue;
    }
    if (!confirmFn) {
      accepted.push(candidate);
      continue;
    }
    let confirmation;
    try {
      confirmation = await confirmFn(candidate);
    } catch (err) {
      unchecked.push({ candidate, error: err.message });
      accepted.push(candidate);
      continue;
    }
    if (confirmation.verdict === "no") {
      rejected.push({
        candidate,
        reason: REJECT_CONFIRMED_UNCHANGED,
        detail: confirmation.reason || "a second pass judged the report to describe no change",
      });
      continue;
    }
    if (confirmation.verdict === "unparsed") {
      unchecked.push({ candidate, error: "second pass returned no usable verdict" });
    }
    accepted.push(candidate);
  }

  return { accepted, rejected, unchecked };
}
