import { findVendor, loadOffers } from "../dist/data.js";

const offers = loadOffers();

function resolvedBySubstring(name) {
  const lower = name.toLowerCase();
  const exact = offers.find((o) => o.vendor.toLowerCase() === lower);
  if (exact) return { type: "exact", vendor: exact.vendor };
  const fuzzy = offers.filter(
    (o) => o.vendor.toLowerCase().includes(lower) || lower.includes(o.vendor.toLowerCase())
  );
  if (fuzzy.length === 1) return { type: "inferred", vendor: fuzzy[0].vendor };
  return { type: "none" };
}

function resolvedNow(name) {
  const match = findVendor(offers, name);
  if (match.type === "none") return { type: "none" };
  return { type: match.type, vendor: match.offer.vendor };
}

function vocabulary() {
  const words = new Set();
  for (const o of offers) {
    for (const word of String(o.description || "").toLowerCase().match(/[a-z0-9][a-z0-9+.#-]*/g) || []) {
      if (word.length >= 5) words.add(word);
    }
  }
  return [...words].sort();
}

function misresolved(words, resolve) {
  return words.filter((word) => {
    const r = resolve(word);
    return r.type === "inferred" && r.vendor.toLowerCase() !== word;
  });
}

const words = vocabulary();
const before = misresolved(words, resolvedBySubstring);
const after = misresolved(words, resolvedNow);

const vendorsOf = (list, resolve) => new Set(list.map((w) => resolve(w).vendor));

console.log(`vocabulary: ${words.length} distinct words of 5+ chars from ${offers.length} descriptions`);
console.log(`substring rule: ${before.length} words -> ${vendorsOf(before, resolvedBySubstring).size} distinct vendors`);
console.log(`boundary rule:  ${after.length} words -> ${vendorsOf(after, resolvedNow).size} distinct vendors`);

const kept = new Set(after);
console.log(`rejected: ${before.filter((w) => !kept.has(w)).length}, kept: ${after.length}`);

if (process.argv.includes("--dump")) {
  console.log("\nstill resolving:");
  for (const word of after) console.log(`  ${word} -> ${resolvedNow(word).vendor}`);
}

if (process.argv.includes("--rows")) {
  console.log("\nrows:");
  for (const word of process.argv.slice(process.argv.indexOf("--rows") + 1)) {
    const b = resolvedBySubstring(word);
    const a = resolvedNow(word);
    console.log(`  ${word.padEnd(24)} substring=${b.vendor ?? b.type}  boundary=${a.vendor ?? a.type}`);
  }
}
