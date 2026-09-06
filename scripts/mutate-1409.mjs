import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const SUITE = [
  "test/compiled-comparison-figures.test.ts",
];

const MUTANTS = [
  ["join-ignores-the-compile-date", "src/compiled-figures.ts",
    `    .filter(change => change.date > compiledOn && change.date <= servedOn)`,
    `    .filter(change => change.date <= servedOn)`],
  ["join-admits-a-record-not-yet-in-force", "src/compiled-figures.ts",
    `    .filter(change => change.date > compiledOn && change.date <= servedOn)`,
    `    .filter(change => change.date > compiledOn)`],
  ["join-orders-the-records-oldest-first", "src/compiled-figures.ts",
    `    .sort((a, b) => b.date.localeCompare(a.date));`,
    `    .sort((a, b) => a.date.localeCompare(b.date));`],
  ["marker-is-never-drawn", "src/compiled-figures.ts",
    `    if (!verdict.freeTierEnded && verdict.since.length === 0) continue;`,
    `    if (!verdict.freeTierEnded || verdict.since.length >= 0) continue;`],
  ["marker-is-drawn-on-every-slot", "src/compiled-figures.ts",
    `    if (!verdict.freeTierEnded && verdict.since.length === 0) continue;`,
    `    if (false) continue;`],
  ["ended-row-keeps-its-figures", "src/compiled-figures.ts",
    `        verdict.freeTierEnded && !slot.alreadyStatesRemoval
          ? withEndedRowCells(withProvider, cellEndInRow + shift)
          : withProvider,`,
    `        withProvider,`],
  ["ended-card-quotes-the-newest-record-rather-than-the-ending", "src/compiled-figures.ts",
    `  const ending = verdict.endedBy;`,
    `  const ending = verdict.since[0] ?? null;`],
  ["ending-record-is-never-passed", "src/serve.ts",
    `    endedBy: ending
      ? { date: ending.date, summary: ending.summary, dateClause: changeDateClause(ending) }
      : null,`,
    `    endedBy: null,`],
  ["ended-card-keeps-the-free-tier-it-states", "src/compiled-figures.ts",
    `      if (!verdict.freeTierEnded || slot.alreadyStatesRemoval) continue;`,
    `      if (verdict.since.length >= 0) continue;`],
  ["ended-slot-reads-as-a-change-rather-than-an-ending", "src/compiled-figures.ts",
    `    const badge = verdict.freeTierEnded
      ? endedBadgeHtml(verdict)
      : recordedSinceBadgeHtml(verdict, options);`,
    `    const badge = verdict.freeTierEnded && verdict.since.length === 0
      ? endedBadgeHtml(verdict)
      : recordedSinceBadgeHtml(verdict, options);`],
  ["marker-is-drawn-below-the-timeline-heading-too", "src/compiled-figures.ts",
    `  const timeline = TIMELINE_HEADING.exec(html);
  return timeline ? html.slice(0, timeline.index) : html;`,
    `  return html;`],
  ["card-subject-keeps-its-tagline", "src/compiled-figures.ts",
    `  const withoutTagline = heading.split(SUBJECT_TAGLINE)[0]!.trim();`,
    `  const withoutTagline = heading.trim();`],
  ["card-subject-keeps-its-qualifier", "src/compiled-figures.ts",
    `  const qualified = withoutTagline.match(TRAILING_QUALIFIER);
  return (qualified ? qualified[1]! : withoutTagline).trim();`,
    `  return withoutTagline.trim();`],
  ["compared-services-counts-a-repeat-twice", "src/compiled-figures.ts",
    `    if (slot.label !== "") named.add(slot.label);`,
    `    if (slot.label !== "") named.add(slot.label + String(named.size));`],
  ["compared-services-counts-the-cards-too", "src/compiled-figures.ts",
    `    if (slot.kind !== "row") continue;`,
    `    if (slot.kind === "card" && false) continue;`],
  ["impact-scale-admits-any-string", "src/change-impact.ts",
    `  return typeof impact === "string" && (CHANGE_IMPACT_LEVELS as readonly string[]).includes(impact);`,
    `  return typeof impact === "string";`],
  ["ungraded-impact-takes-the-lowest-grade-colour", "src/change-impact.ts",
    `  return isChangeImpactLevel(impact) ? IMPACT_COLOR[impact] : UNGRADED_IMPACT_COLOR;`,
    `  return isChangeImpactLevel(impact) ? IMPACT_COLOR[impact] : IMPACT_COLOR.low;`],
  ["ungraded-impact-prints-itself-as-a-grade", "src/change-impact.ts",
    `  return isChangeImpactLevel(impact) ? impact.toUpperCase() : UNGRADED_IMPACT_LABEL;`,
    `  return String(impact ?? "").toUpperCase();`],
  ["card-heading-resolves-through-a-generalisation", "src/compiled-figures.ts",
    `  if (resolution.type === "redirect" && resolution.slug.startsWith(slug + "-")) return resolution.slug;`,
    `  if (resolution.type === "redirect") return resolution.slug;`],
  ["subject-never-resolves-from-the-link-the-page-carries", "src/compiled-figures.ts",
    `  if (subject.linkedSlug && vendorSlugMap.has(subject.linkedSlug)) return subject.linkedSlug;`,
    `  if (subject.linkedSlug && false) return subject.linkedSlug;`],
  ["subject-trusts-a-link-the-catalogue-does-not-hold", "src/compiled-figures.ts",
    `  if (subject.linkedSlug && vendorSlugMap.has(subject.linkedSlug)) return subject.linkedSlug;`,
    `  if (subject.linkedSlug) return subject.linkedSlug;`],
  ["subject-reads-a-card-heading-as-loosely-as-a-row", "src/compiled-figures.ts",
    `  if (subject.kind === "card") return slugNamedByHeading(subject.label);`,
    `  if (subject.kind === "card" && false) return slugNamedByHeading(subject.label);`],
  ["timeline-drops-the-vendors-the-page-names", "src/compiled-figures.ts",
    `  for (const subject of subjects) {
    const vendor = vendorNameForSubject(subject);
    if (!vendor) continue;
    for (const change of changesForVendor(vendor)) timeline.add(change);
  }`,
    `  for (const subject of subjects) void subject;`],
  ["timeline-forgets-the-scope-the-page-declares", "src/compiled-figures.ts",
    `  const timeline = new Set<T>(declaredScope);`,
    `  const timeline = new Set<T>();`],
  ["timeline-takes-the-oldest-records", "src/compiled-figures.ts",
    `  return [...timeline].sort((a, b) => b.date.localeCompare(a.date)).slice(0, limit);`,
    `  return [...timeline].sort((a, b) => a.date.localeCompare(b.date)).slice(0, limit);`],
  ["timeline-ignores-its-row-limit", "src/compiled-figures.ts",
    `  return [...timeline].sort((a, b) => b.date.localeCompare(a.date)).slice(0, limit);`,
    `  return [...timeline].sort((a, b) => b.date.localeCompare(a.date));`],
  ["services-compared-is-never-filled-in", "src/compiled-figures.ts",
    `  if (!html.includes(COMPARED_SERVICES_PLACEHOLDER)) return html;`,
    `  return html;`],
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
  console.log(`${green ? "SURVIVED" : built ? "killed  " : "killed (did not compile)"}  ${name}`);
  if (green) survivors.push(name);
}
run("npm", ["run", "build"]);
console.log(`\n${MUTANTS.length - survivors.length}/${MUTANTS.length} killed`);
if (survivors.length > 0) console.log("survivors:", survivors.join(", "));
