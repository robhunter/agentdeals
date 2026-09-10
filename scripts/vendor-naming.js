import { priceLabel, structuredDetail, unrenderedPrices } from "./structured-prices.js";

const NAME_QUALIFIERS = new Set([
  "cloud", "ci", "cd", "api", "apis", "ai", "app", "apps", "platform", "hosting",
  "storage", "object", "free", "inc", "ltd", "llc", "labs", "software", "services",
  "service", "tools", "tool", "db", "database", "web", "online", "pro", "plus",
  "enterprise", "team", "suite", "hub", "server", "serverless", "hosted", "managed",
  "the", "and", "for", "com", "io", "dev", "co", "net", "org", "sh", "run",
]);

const NAME_TLDS = ["com", "io", "dev", "ai", "co", "net", "org", "sh", "app", "cloud", "so", "xyz"];

const MIN_FORM_LENGTH = 3;
const MIN_DISTINCTIVE_WORD = 7;

export const SOURCE_CHECK_OK = "ok";
export const SOURCE_CHECK_NO_AMOUNT = "states_no_amount";
export const SOURCE_CHECK_NOT_NAMED = "does_not_name_vendor";
export const SOURCE_CHECK_NOT_THE_PRODUCT = "does_not_name_product";
export const SOURCE_CHECK_NO_TERMS = "states_no_terms";
export const SOURCE_CHECK_UNREADABLE = "unreadable";

export const SOURCE_CHECK_OUTCOMES = [
  SOURCE_CHECK_OK,
  SOURCE_CHECK_NO_AMOUNT,
  SOURCE_CHECK_NOT_NAMED,
  SOURCE_CHECK_NOT_THE_PRODUCT,
  SOURCE_CHECK_NO_TERMS,
  SOURCE_CHECK_UNREADABLE,
];

const OUTCOMES_THAT_HOLD_THE_VERIFIED_DATE = new Set([
  SOURCE_CHECK_NOT_NAMED,
  SOURCE_CHECK_NOT_THE_PRODUCT,
  SOURCE_CHECK_NO_TERMS,
  SOURCE_CHECK_UNREADABLE,
]);

export function holdsVerifiedDate(outcome) {
  return OUTCOMES_THAT_HOLD_THE_VERIFIED_DATE.has(outcome);
}

const A_FIGURE = /\d/;

export function statesAnAmount(signal) {
  return typeof signal === "string" && A_FIGURE.test(signal);
}

export function normalizeForMatch(text) {
  if (typeof text !== "string") return "";
  return ` ${text.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()} `;
}

function stripTld(name) {
  for (const tld of NAME_TLDS) {
    if (name.endsWith(`.${tld}`)) return name.slice(0, -(tld.length + 1));
  }
  return name;
}

function names(vendor, extra) {
  return [vendor, ...extra].filter((raw) => typeof raw === "string" && raw.trim());
}

function camelSplit(raw) {
  return raw.replace(/([a-z0-9])([A-Z])/g, "$1 $2");
}

export function vendorNameForms(vendor, extra = []) {
  const forms = new Set();
  const add = (raw) => {
    if (typeof raw !== "string") return;
    const spaced = normalizeForMatch(raw).trim();
    if (spaced.length >= MIN_FORM_LENGTH) forms.add(spaced);
    const flat = spaced.replace(/ /g, "");
    if (flat.length >= MIN_FORM_LENGTH) forms.add(flat);
  };

  for (const raw of names(vendor, extra)) {
    add(raw);
    add(stripTld(raw.trim().toLowerCase()));
    add(camelSplit(raw));
    const words = normalizeForMatch(raw).trim().split(" ").filter(Boolean);
    if (words.length < 2) continue;
    const withoutQualifiers = words.filter((w) => !NAME_QUALIFIERS.has(w));
    if (withoutQualifiers.length > 1 && withoutQualifiers.length < words.length) {
      add(withoutQualifiers.join(" "));
    }
    for (const word of withoutQualifiers) {
      if (word.length >= MIN_DISTINCTIVE_WORD) forms.add(word);
    }
  }

  return [...forms];
}

function shortNameForms(vendor, extra = []) {
  const forms = new Set();
  for (const raw of names(vendor, extra)) {
    for (const variant of [raw, stripTld(raw.trim().toLowerCase()), camelSplit(raw)]) {
      const spaced = normalizeForMatch(variant).trim();
      if (!spaced) continue;
      forms.add(spaced.replace(/ /g, ""));
      for (const word of spaced.split(" ")) if (word) forms.add(word);
    }
  }
  return [...forms];
}

export function hostLabels(url) {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "").split(".").filter(Boolean);
  } catch {
    return [];
  }
}

const MIN_HOST_PREFIX = 4;

export const NAMED_IN_PAGE_TEXT = "text";
export const NAMED_BY_A_HOST_THE_PAGE_WRITES = "host_in_text";

export const NAMING_LAYERS_RECORDED_INSTEAD_OF_A_FINDING = [NAMED_IN_PAGE_TEXT, "url", "host"];

export function checkRecordedAFinding(check) {
  const detail = (check?.detail ?? "").trim();
  if (detail === "") return false;
  return !NAMING_LAYERS_RECORDED_INSTEAD_OF_A_FINDING.includes(detail);
}

function hostLabelMatchesVendor(label, vendor, aliases) {
  for (const form of shortNameForms(vendor, aliases)) {
    if (label === form) return true;
    if (label.length >= MIN_HOST_PREFIX && form.startsWith(label)) return true;
  }
  return false;
}

export function servedFromTheVendorsDomain(offer, aliases = []) {
  return hostLabels(offer?.url ?? "")
    .slice(0, -1)
    .some((label) => hostLabelMatchesVendor(label, offer?.vendor ?? "", aliases));
}

const NAME_TLD_SET = new Set(NAME_TLDS);

function nameTokens(vendor) {
  return normalizeForMatch(vendor).trim().split(" ").filter(Boolean);
}

function labelRestatesToken(label, token) {
  if (label.length < MIN_FORM_LENGTH) return false;
  if (label === token) return true;
  return label.length >= MIN_HOST_PREFIX && token.startsWith(label);
}

function distinguishesTheProduct(token) {
  if (token.length < MIN_FORM_LENGTH) return false;
  return !NAME_QUALIFIERS.has(token) && !NAME_TLD_SET.has(token) && !/^\d+$/.test(token);
}

export function nameWords(vendor) {
  return String(vendor ?? "")
    .replace(/\([^)]*\)/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

const NOTHING_RESTATED = { tokens: [], labels: [], remainder: [] };

export function hostRestatement(vendor, url) {
  const words = nameWords(vendor);
  if (words.length < 2) return NOTHING_RESTATED;
  const tokens = nameTokens(words.join(" "));
  const restated = new Set();
  const labels = [];
  for (const label of hostLabels(url)) {
    const hits = tokens.filter((token) => labelRestatesToken(label, token));
    if (hits.length === 0) continue;
    labels.push(label);
    for (const hit of hits) restated.add(hit);
  }
  const remainder = tokens.filter((token) => !restated.has(token));
  if (!remainder.some(distinguishesTheProduct)) return NOTHING_RESTATED;
  return { tokens: [...restated], labels, remainder };
}

export function productHalf(vendor, restated) {
  const restating = new Set(restated.tokens);
  const kept = nameWords(vendor).filter((word) => !nameTokens(word).some((token) => restating.has(token)));
  return kept.length > 0 ? kept.join(" ") : restated.remainder.join(" ");
}

export function pageNamesVendor(pageText, vendor, options = {}) {
  const aliases = options.aliases ?? [];
  const url = options.url ?? "";
  const restated = hostRestatement(vendor, url);
  const restating = new Set(restated.tokens);
  const forms = vendorNameForms(vendor, [...aliases, productHalf(vendor, restated)])
    .filter((form) => !restating.has(form));
  const result = (named, via, form) => ({ named, via, form, forms });
  if (forms.length === 0) return result(false, null, null);

  const haystack = normalizeForMatch(pageText);
  for (const form of forms) {
    if (haystack.includes(` ${form} `)) return result(true, NAMED_IN_PAGE_TEXT, form);
  }

  const written = haystack.replace(/ /g, "");
  for (const label of hostLabels(url).slice(0, -1).reverse()) {
    if (restated.labels.includes(label)) continue;
    if (label.length < MIN_FORM_LENGTH || !written.includes(label)) continue;
    if (hostLabelMatchesVendor(label, vendor, aliases)) {
      return result(true, NAMED_BY_A_HOST_THE_PAGE_WRITES, label);
    }
  }

  return result(false, null, null);
}

export function pageNamesOnlyTheHost(pageText, vendor, url) {
  const restated = hostRestatement(vendor, url);
  if (restated.tokens.length === 0) return false;
  return restated.tokens.some((token) => pageNamesVendor(pageText, token, { url }).named);
}

export const READ_FROM_MARKUP = "markup";

function markupClause(structured) {
  const detail = structuredDetail(structured);
  return detail ? `, and ${detail}` : "";
}

function namedClause(vendor, naming) {
  return naming.via === NAMED_BY_A_HOST_THE_PAGE_WRITES
    ? `the page writes "${naming.form}", the domain we cite ${vendor} from,`
    : `the page names ${vendor} as "${naming.form}"`;
}

export function classifySource(offer, page, signals) {
  if (!page || !page.ok) {
    return { outcome: SOURCE_CHECK_UNREADABLE, detail: page?.error ?? "not fetched" };
  }
  const naming = pageNamesVendor(page.text, offer.vendor, { url: offer.url });
  if (!naming.named) {
    if (pageNamesOnlyTheHost(page.text, offer.vendor, offer.url)) {
      const restated = hostRestatement(offer.vendor, offer.url);
      return {
        outcome: SOURCE_CHECK_NOT_THE_PRODUCT,
        detail: `the page names the platform in the domain we cite ${offer.vendor} from and never names ${productHalf(offer.vendor, restated)}`,
      };
    }
    return {
      outcome: SOURCE_CHECK_NOT_NAMED,
      detail: servedFromTheVendorsDomain(offer)
        ? `the page never names ${offer.vendor}, on a domain that carries its name`
        : `the page never names ${offer.vendor} and is not served from its domain`,
    };
  }
  const structured = page.structured ?? null;
  const found = Array.isArray(signals) ? signals : [];
  const rendersAnAmount = found.some(statesAnAmount);
  if (!rendersAnAmount && structured && structured.prices.length > 0) {
    const rendered = found.length === 0 ? "renders no terms we can read" : `renders "${found[0]}" and no amount`;
    return {
      outcome: SOURCE_CHECK_OK,
      detail: `the page names ${offer.vendor}, ${rendered}, and ${structuredDetail(structured)}`,
      read: READ_FROM_MARKUP,
    };
  }
  if (found.length === 0) {
    return {
      outcome: SOURCE_CHECK_NO_TERMS,
      detail: `the page names ${offer.vendor} but states no amount, tier or rate we can read${markupClause(structured)}`,
    };
  }
  if (!rendersAnAmount) {
    return {
      outcome: SOURCE_CHECK_NO_AMOUNT,
      detail: `the page names ${offer.vendor} and says "${found[0]}" but states no amount, rate or price we can read${markupClause(structured)}`,
    };
  }
  return { outcome: SOURCE_CHECK_OK, detail: `${namedClause(offer.vendor, naming)} and states "${found[0]}"` };
}

export const MAX_UNRENDERED_PRICES_RECORDED = 6;

export function sourceCheckRecord(offer, page, signals, checked) {
  const { outcome, detail, read } = classifySource(offer, page, signals);
  const record = { checked, outcome, detail };
  if (read) record.read = read;
  const unrendered = page?.ok ? unrenderedPrices(page.structured, page.text) : [];
  if (unrendered.length > 0) {
    record.unrendered_prices = unrendered.slice(0, MAX_UNRENDERED_PRICES_RECORDED).map(priceLabel);
  }
  return record;
}
