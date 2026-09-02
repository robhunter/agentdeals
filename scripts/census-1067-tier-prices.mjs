import { readFileSync } from "node:fs";
import ts from "typescript";

const SOURCE = "src/serve.ts";

const src = ts.createSourceFile(SOURCE, readFileSync(SOURCE, "utf8"), ts.ScriptTarget.Latest, true);

const rows = [];

function stringValue(node) {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  return null;
}

function visit(node) {
  if (ts.isObjectLiteralExpression(node)) {
    const props = new Map();
    for (const p of node.properties) {
      if (!ts.isPropertyAssignment(p)) continue;
      const key = ts.isIdentifier(p.name) || ts.isStringLiteral(p.name) ? p.name.text : null;
      if (!key) continue;
      const value = stringValue(p.initializer);
      if (value !== null) props.set(key, value);
    }
    if (props.has("slug")) {
      const { line } = src.getLineAndCharacterOfPosition(node.getStart(src));
      rows.push({ slug: props.get("slug"), line: line + 1, props });
    }
  }
  ts.forEachChild(node, visit);
}
visit(src);

const catalogue = new Map();
for (const offer of JSON.parse(readFileSync("data/index.json", "utf8")).offers) {
  const slug = offer.vendor.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  const prior = catalogue.get(slug) || { vendor: offer.vendor, text: "" };
  prior.text += " " + (offer.description || "");
  catalogue.set(slug, prior);
}

const TIER = "(Free|Hobby|Starter|Basic|Individual|Pro\\+|Pro|Plus|Premium|Team|Teams|Business|Standard|Ultra|Ultimate|Max|Power|Enterprise|Indie|Student|Personal|Growth|Scale)";
const priceAfter = new RegExp("\\b" + TIER + "\\b(?: plan| tier| seat)?(?: is| at|:)?[ (\\u2014-]{0,3}\\$(\\d[\\d,]*)", "gi");
const priceBefore = new RegExp("\\$(\\d[\\d,]*)(?:/[a-z]+)*(?:/[a-z]+)? \\(" + TIER + "\\)", "gi");

export function tierPrices(text) {
  const out = new Map();
  const add = (tier, price) => {
    const key = tier.toLowerCase();
    if (!out.has(key)) out.set(key, new Set());
    out.get(key).add(Number(price.replace(/,/g, "")));
  };
  for (const m of text.matchAll(priceAfter)) add(m[1], m[2]);
  for (const m of text.matchAll(priceBefore)) add(m[2], m[1]);
  return out;
}

let pagesWithSlug = 0;
let compared = 0;
const contradictions = [];
const recordSilent = [];

for (const row of rows) {
  const record = catalogue.get(row.slug);
  if (!record) continue;
  pagesWithSlug++;
  const pageText = [...row.props.entries()].filter(([k]) => k !== "slug" && k !== "url").map(([, v]) => v).join(". ");
  const pageTiers = tierPrices(pageText);
  const recordTiers = tierPrices(record.text);
  for (const [tier, pagePrices] of pageTiers) {
    const recordPrices = recordTiers.get(tier);
    if (!recordPrices) {
      if (new RegExp("\\b" + tier.replace("+", "\\+") + "\\b", "i").test(record.text)) {
        recordSilent.push({ slug: row.slug, line: row.line, tier, page: [...pagePrices].join("/") });
      }
      continue;
    }
    compared++;
    for (const price of pagePrices) {
      if (!recordPrices.has(price)) {
        contradictions.push({
          slug: row.slug,
          line: row.line,
          tier,
          page: [...pagePrices].join("/"),
          record: [...recordPrices].join("/"),
        });
      }
    }
  }
}

console.log(`object literals with a slug: ${rows.length}`);
console.log(`resolving to a catalogue vendor: ${pagesWithSlug}`);
console.log(`tier names priced on both sides: ${compared}`);
console.log(`contradictions: ${contradictions.length}`);
console.log(`page prices a tier the record names but never prices: ${recordSilent.length}`);
console.log("");
for (const c of contradictions) {
  console.log(`DISAGREE ${SOURCE}:${c.line}  ${c.slug}  ${c.tier}: page $${c.page} vs record $${c.record}`);
}
for (const c of recordSilent) {
  console.log(`SILENT   ${SOURCE}:${c.line}  ${c.slug}  ${c.tier}: page $${c.page}, record names the tier with no price`);
}

const withdrawnCursorString =
  "6 plans: Free (2,000 completions/month), Hobby ($10/mo), Pro ($20/mo), Pro+ ($60/mo), Business ($40/seat), Ultra ($200/mo).";
const cursorRecord =
  "Hobby is Cursor's free plan - no credit card required. Pro $20/mo, Pro+ $60/mo, Ultra $200/mo, Teams $40/user/mo.";
const withdrawn = tierPrices(withdrawnCursorString);
const held = tierPrices(cursorRecord);

console.log("");
console.log("against the withdrawn Cursor string:");
console.log(`  disagreements: ${[...withdrawn].filter(([t, p]) => held.has(t) && [...p].some(x => !held.get(t).has(x))).length}`);
console.log(`  page priced, record silent: ${[...withdrawn].filter(([t]) => !held.has(t) && new RegExp("\\b" + t + "\\b", "i").test(cursorRecord)).map(([t]) => t).join(", ")}`);
