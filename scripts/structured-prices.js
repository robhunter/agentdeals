const JSON_LD_BLOCK = /<script[^>]*\btype\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;

export const PRICED_TYPES = new Set([
  "Offer",
  "AggregateOffer",
  "PriceSpecification",
  "UnitPriceSpecification",
]);

const PRICE_KEYS = ["price", "lowPrice"];
const MAX_NODES = 5_000;
const A_FIGURE = /\d/;

export function jsonLdBlocks(html) {
  if (typeof html !== "string") return [];
  return [...html.matchAll(JSON_LD_BLOCK)].map((match) => match[1]);
}

function typeNames(node) {
  const raw = node["@type"];
  if (typeof raw === "string") return [raw];
  if (Array.isArray(raw)) return raw.filter((t) => typeof t === "string");
  return [];
}

function readPrice(raw) {
  if (typeof raw === "number") return Number.isFinite(raw) ? String(raw) : null;
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed || !A_FIGURE.test(trimmed)) return null;
  return trimmed;
}

function readName(node) {
  if (typeof node.name === "string" && node.name.trim()) return node.name.trim();
  const offered = node.itemOffered;
  if (offered && typeof offered === "object" && typeof offered.name === "string" && offered.name.trim()) {
    return offered.name.trim();
  }
  return null;
}

function collect(root, into) {
  const queue = [root];
  let seen = 0;
  while (queue.length > 0 && seen < MAX_NODES) {
    const node = queue.shift();
    if (Array.isArray(node)) {
      for (const child of node) queue.push(child);
      continue;
    }
    if (!node || typeof node !== "object") continue;
    seen++;
    const types = typeNames(node);
    if (types.some((t) => PRICED_TYPES.has(t))) {
      for (const key of PRICE_KEYS) {
        const price = readPrice(node[key]);
        if (price === null) continue;
        into.push({
          type: types.find((t) => PRICED_TYPES.has(t)),
          name: readName(node),
          price,
          currency: typeof node.priceCurrency === "string" ? node.priceCurrency : null,
        });
        break;
      }
    }
    for (const value of Object.values(node)) {
      if (value && typeof value === "object") queue.push(value);
    }
  }
}

export function priceValue(price) {
  const digits = String(price.price).replace(/[^0-9.]/g, "");
  const value = Number(digits);
  return Number.isFinite(value) ? value : null;
}

function amountKey(price) {
  return `${priceValue(price) ?? price.price}|${price.currency ?? ""}`;
}

export function distinctPrices(prices) {
  const seen = new Set();
  const distinct = [];
  for (const price of prices) {
    const key = `${amountKey(price)}|${price.name ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    distinct.push(price);
  }
  const named = new Set(distinct.filter((p) => p.name).map(amountKey));
  return distinct.filter((price) => price.name || !named.has(amountKey(price)));
}

export function typedPrices(html) {
  return readStructuredPrices(html).prices;
}

export function readStructuredPrices(html) {
  const blocks = jsonLdBlocks(html);
  let parsed = 0;
  const prices = [];
  for (const block of blocks) {
    let value;
    try {
      value = JSON.parse(block);
    } catch {
      continue;
    }
    parsed++;
    collect(value, prices);
  }
  return { blocks: blocks.length, parsed, prices: distinctPrices(prices) };
}

export const NO_STRUCTURED_DATA = "its markup carries no structured data";

export function structuredDetail(structured) {
  if (!structured) return null;
  if (structured.blocks === 0) return NO_STRUCTURED_DATA;
  if (structured.prices.length === 0) {
    return `the ${structured.blocks} structured-data block${structured.blocks === 1 ? "" : "s"} in its markup state no price`;
  }
  return `its markup states ${priceList(structured.prices)}`;
}

export function priceLabel(price) {
  const amount = price.currency ? `${price.currency} ${price.price}` : price.price;
  return price.name ? `${price.name} ${amount}` : amount;
}

export function priceList(prices, limit = 3) {
  const shown = prices.slice(0, limit).map(priceLabel).join(", ");
  const rest = prices.length - Math.min(limit, prices.length);
  const count = `${prices.length} typed price${prices.length === 1 ? "" : "s"}`;
  return rest > 0 ? `${count} (${shown}, +${rest} more)` : `${count} (${shown})`;
}

export function isZero(price) {
  return priceValue(price) === 0;
}

export function renderedIn(price, text) {
  if (typeof text !== "string") return false;
  const digits = String(price.price).replace(/[^0-9.]/g, "");
  if (!digits) return false;
  const whole = digits.replace(/\.0+$/, "");
  const withGrouping = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  for (const form of new Set([digits, whole, withGrouping])) {
    if (!form) continue;
    if (new RegExp(`(?<![\\d.,])${form.replace(/\./g, "\\.")}(?![\\d])`).test(text)) return true;
  }
  return false;
}

export function unrenderedPrices(structured, text) {
  if (!structured || structured.prices.length === 0) return [];
  return structured.prices.filter((price) => !isZero(price) && !renderedIn(price, text));
}
