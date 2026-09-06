import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const SUITE = [
  "test/change-log-only-vendors.test.ts",
  "test/compiled-comparison-figures.test.ts",
];

const MUTANTS = [
  ["subject-is-only-ever-read-from-the-catalogue", "src/compiled-figures.ts",
    `  const named = changeLogVendorNamed(subject.label);`,
    `  const named: string | null = null;`],
  ["subject-prefers-the-change-log-to-the-vendor-s-own-page", "src/compiled-figures.ts",
    `  if (slug) return { slug, vendor: vendorSlugMap.get(slug)! };`,
    `  if (slug && !changeLogVendorNamed(subject.label)) return { slug, vendor: vendorSlugMap.get(slug)! };`],
  ["subject-with-no-page-is-given-one-anyway", "src/compiled-figures.ts",
    `  return named ? { slug: null, vendor: named } : null;`,
    `  return named ? { slug: toSlug(named), vendor: named } : null;`],
  ["subject-records-are-read-under-one-spelling-only", "src/serve.ts",
    `  const names = new Set([named.vendor, ...(changeLogNamesBySubject.get(named.slug) ?? [])]);`,
    `  const names = new Set([named.vendor]);`],
  ["change-log-names-reach-no-subject", "src/serve.ts",
    `    const subject = vendorSlugMap.has(slug) ? slug : namedVendorSlug(vendor);`,
    `    const subject = vendorSlugMap.has(slug) ? slug : null;`],
  ["a-subject-that-is-not-a-vendor-is-named-anyway", "src/vendor-slug.ts",
    `  return NON_VENDOR_SUBJECTS.some(s => toSlug(s) === toSlug(phrase));`,
    `  return false;`],
  ["marker-always-points-at-a-vendor-page", "src/compiled-figures.ts",
    `  if (verdict.slug) return \`/vendor/\${verdict.slug}#changes\`;`,
    `  return \`/vendor/\${verdict.slug ?? toSlug(verdict.vendor)}#changes\`;`],
  ["marker-always-points-at-the-change-log", "src/compiled-figures.ts",
    `  if (verdict.slug) return \`/vendor/\${verdict.slug}#changes\`;`,
    ``],
  ["marker-points-at-the-change-log-with-no-anchor", "src/compiled-figures.ts",
    `  return anchor ? \`\${CHANGE_LOG_PATH}#\${anchor}\` : CHANGE_LOG_PATH;`,
    `  return anchor ? CHANGE_LOG_PATH : CHANGE_LOG_PATH;`],
  ["ending-record-ignores-a-resolution", "src/data.ts",
    `  const inForce = vendorChanges.filter(c => !isNoLongerInForce(c));`,
    `  const inForce = vendorChanges.filter(c => Boolean(c));`],
  ["ending-record-ignores-a-later-restoration", "src/data.ts",
    `  const restored = inForce.some(c => c.change_type === "new_free_tier" && c.date > ending.date);`,
    `  const restored = false;`],
  ["ending-record-lets-an-earlier-restoration-clear-it", "src/data.ts",
    `  const restored = inForce.some(c => c.change_type === "new_free_tier" && c.date > ending.date);`,
    `  const restored = inForce.some(c => c.change_type === "new_free_tier");`],
  ["ending-record-takes-the-oldest-ending", "src/data.ts",
    `    .sort((a, b) => b.date.localeCompare(a.date))[0];`,
    `    .sort((a, b) => a.date.localeCompare(b.date))[0];`],
  ["ending-record-reads-an-ending-out-of-any-change", "src/data.ts",
    `    .filter(c => SEVERE_CHANGE_TYPES.has(c.change_type))`,
    `    .filter(c => Boolean(c.change_type))`],
  ["subject-with-no-page-is-never-called-ended", "src/serve.ts",
    `    const ending = freeTierEndingRecord(changesForSubject(named));
    return { ended: ending !== null, endedBy: ending };`,
    `    return { ended: false, endedBy: null };`],
  ["subject-with-no-page-is-always-called-ended", "src/serve.ts",
    `    const ending = freeTierEndingRecord(changesForSubject(named));
    return { ended: ending !== null, endedBy: ending };`,
    `    const ending = freeTierEndingRecord(changesForSubject(named));
    return { ended: true, endedBy: ending };`],
  ["change-log-anchors-every-record-it-prints", "src/serve.ts",
    `    const anchorAttr = anchor && anchorHolder.get(anchor) === c ? \` id="\${anchor}"\` : "";`,
    `    const anchorAttr = anchor ? \` id="\${anchor}"\` : "";`],
  ["change-log-anchors-nothing", "src/serve.ts",
    `    const anchorAttr = anchor && anchorHolder.get(anchor) === c ? \` id="\${anchor}"\` : "";`,
    `    const anchorAttr = "";`],
  ["ended-cell-is-struck-a-second-time", "src/compiled-figures.ts",
    `  if (slot.alreadyStruck) return inner;`,
    ``],
  ["ended-cell-drops-the-badge-the-page-wrote", "src/compiled-figures.ts",
    `  if (!slot.alreadyStatesRemoval) return strickenName;
  return strickenName + (inner.match(DECORATION_SPAN) ?? []).join("");`,
    `  return strickenName;`],
  ["a-slot-the-page-badged-is-badged-again", "src/compiled-figures.ts",
    `      ? (slot.alreadyStatesRemoval ? "" : endedBadgeHtml(verdict))`,
    `      ? endedBadgeHtml(verdict)`],
  ["a-marker-the-join-drew-does-not-count-as-a-marker", "src/compiled-figures.ts",
    `  return { alreadyStatesRemoval: REMOVED_BADGE.test(inner), alreadyStruck: STRUCK_SUBJECT.test(inner) };`,
    `  const written = inner.replace(RECORD_MARKER, "");
  return { alreadyStatesRemoval: REMOVED_BADGE.test(written), alreadyStruck: STRUCK_SUBJECT.test(written) };`],
  ["change-log-names-are-read-off-the-catalogue", "src/vendor-slug.ts",
    `  for (const change of loadDealChanges()) {
    const slug = toSlug(change.vendor);`,
    `  for (const change of loadOffers()) {
    const slug = toSlug(change.vendor);`],
  ["marker-text-is-not-read-back-off-the-page", "src/compiled-figures.ts",
    `  /<a\\b[^>]*href="(?:\\/vendor\\/[a-z0-9-]+#changes|\\/changes#vendor-[a-z0-9-]+)"[^>]*>[\\s\\S]*?<\\/a>/g;`,
    `  /<a\\b[^>]*href="\\/vendor\\/[a-z0-9-]+#changes"[^>]*>[\\s\\S]*?<\\/a>/g;`],
  ["change-log-anchor-is-shared-by-every-vendor", "src/vendor-slug.ts",
    `  return slug ? \`vendor-\${slug}\` : null;`,
    `  return slug ? "vendor" : null;`],
];

function run(cmd, args) {
  try {
    execFileSync(cmd, args, { stdio: "pipe", encoding: "utf-8" });
    return true;
  } catch {
    return false;
  }
}

const survivors = [];
const uncompiled = [];
for (const [name, file, from, to] of MUTANTS) {
  const original = readFileSync(file, "utf-8");
  if (!original.includes(from)) {
    console.log(`SKIP  ${name} — the line it mutates is not in ${file}`);
    continue;
  }
  writeFileSync(file, original.replace(from, to));
  const built = run("npm", ["run", "build"]);
  const green = built && run("node", ["--test", "--test-concurrency", "1", ...SUITE]);
  writeFileSync(file, original);
  if (!built) uncompiled.push(name);
  console.log(`${green ? "SURVIVED" : built ? "killed  " : "DID NOT COMPILE"}  ${name}`);
  if (green) survivors.push(name);
}
run("npm", ["run", "build"]);
console.log(`\n${MUTANTS.length - survivors.length - uncompiled.length}/${MUTANTS.length} killed`);
if (survivors.length > 0) console.log("survivors:", survivors.join(", "));
if (uncompiled.length > 0) console.log("did not compile:", uncompiled.join(", "));
