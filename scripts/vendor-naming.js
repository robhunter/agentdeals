/**
 * Does a fetched page state terms about *this* vendor?
 *
 * `priceSignals()` in change-gate.js answers "does this page state terms".
 * A marketplace landing page saturated with other companies' prices scores
 * higher on that question than a real vendor pricing page, so the two
 * questions have to be asked separately (#1109).
 *
 * Every function here is pure. The caller supplies the fetched text.
 */

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
export const SOURCE_CHECK_NOT_NAMED = "does_not_name_vendor";
export const SOURCE_CHECK_NO_TERMS = "states_no_terms";
export const SOURCE_CHECK_UNREADABLE = "unreadable";

export const SOURCE_CHECK_OUTCOMES = [
  SOURCE_CHECK_OK,
  SOURCE_CHECK_NOT_NAMED,
  SOURCE_CHECK_NO_TERMS,
  SOURCE_CHECK_UNREADABLE,
];

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

export function vendorUrlForms(vendor, extra = []) {
  const forms = new Set(vendorNameForms(vendor, extra));
  for (const raw of names(vendor, extra)) {
    const words = normalizeForMatch(raw).trim().split(" ").filter(Boolean);
    if (words.length < 2) continue;
    for (const word of words) {
      if (NAME_QUALIFIERS.has(word)) continue;
      if (word.length >= MIN_FORM_LENGTH) forms.add(word);
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

export function urlText(url) {
  try {
    const parsed = new URL(url);
    return `${parsed.hostname} ${parsed.pathname}`;
  } catch {
    return "";
  }
}

const MIN_HOST_PREFIX = 4;

export function pageNamesVendor(pageText, vendor, options = {}) {
  const aliases = options.aliases ?? [];
  const forms = vendorNameForms(vendor, aliases);
  const result = (named, via, form) => ({ named, via, form, forms });
  if (forms.length === 0) return result(false, null, null);

  const haystack = normalizeForMatch(pageText);
  for (const form of forms) {
    if (haystack.includes(` ${form} `)) return result(true, "text", form);
  }

  const url = options.url ?? "";
  const flatUrl = normalizeForMatch(urlText(url)).replace(/ /g, "");
  for (const form of vendorUrlForms(vendor, aliases)) {
    const flat = form.replace(/ /g, "");
    if (flat.length >= MIN_FORM_LENGTH && flatUrl.includes(flat)) return result(true, "url", form);
  }

  const labels = hostLabels(url).slice(0, -1);
  const short = shortNameForms(vendor, aliases);
  for (const label of labels) {
    for (const form of short) {
      if (label === form) return result(true, "host", form);
      if (label.length >= MIN_HOST_PREFIX && form.startsWith(label)) return result(true, "host", form);
    }
  }

  return result(false, null, null);
}

export function classifySource(offer, page, priceSignalCount) {
  if (!page || !page.ok) {
    return { outcome: SOURCE_CHECK_UNREADABLE, detail: page?.error ?? "not fetched" };
  }
  const naming = pageNamesVendor(page.text, offer.vendor, { url: offer.url });
  if (!naming.named) {
    return {
      outcome: SOURCE_CHECK_NOT_NAMED,
      detail: `the page never names ${offer.vendor} and is not served from its domain`,
    };
  }
  if (!(priceSignalCount > 0)) {
    return {
      outcome: SOURCE_CHECK_NO_TERMS,
      detail: `the page names ${offer.vendor} but states no amount, tier or rate we can read`,
    };
  }
  return { outcome: SOURCE_CHECK_OK, detail: naming.via };
}

export function sourceCheckRecord(offer, page, priceSignalCount, checked) {
  const { outcome, detail } = classifySource(offer, page, priceSignalCount);
  return { checked, outcome, detail };
}
