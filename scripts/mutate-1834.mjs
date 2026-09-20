import { readFileSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";

const TEST = "test/badged-ending-contradicted.test.ts";

const MUTANTS = [
  {
    name: "the zero-price rule never fires",
    file: "src/retired-terms.ts",
    from: `  if (ZERO_PRICE.test(text)) return "prices it at zero";\n`,
    to: ``,
  },
  {
    name: "the zero-price rule reads any price as free",
    file: "src/retired-terms.ts",
    from: `const ZERO_PRICE = /[$€£]\\s?0(?:\\.0+)?(?![\\d.,])/;`,
    to: `const ZERO_PRICE = /[$€£]\\s?\\d/;`,
  },
  {
    name: "the zero-price rule reads a price under a dollar as free",
    file: "src/retired-terms.ts",
    from: `const ZERO_PRICE = /[$€£]\\s?0(?:\\.0+)?(?![\\d.,])/;`,
    to: `const ZERO_PRICE = /[$€£]\\s?0/;`,
  },
  {
    name: "card descriptions are not read",
    file: "src/retired-terms.ts",
    from: `  for (const m of html.matchAll(CARD_DESCRIPTION)) {\n    spans.push({ tag: "div", start: m.index!, end: m.index! + m[0].length });\n  }\n`,
    to: ``,
  },
  {
    name: "the licence rule swallows every mention of free",
    file: "src/retired-terms.ts",
    from: `const FREE_AS_A_LICENCE = /\\bfree (?:software|and open[- ]source)\\b/gi;`,
    to: `const FREE_AS_A_LICENCE = /\\bfree\\b/gi;`,
  },
  {
    name: "the credential rule swallows every mention of free",
    file: "src/retired-terms.ts",
    from: `const FREE_AS_A_CREDENTIAL = /\\bfree (?:auth(?:entication)?|access|api)?\\s?(?:token|key|sign-?up|registration)\\b/gi;`,
    to: `const FREE_AS_A_CREDENTIAL = /\\bfree\\b/gi;`,
  },
  {
    name: "the change timeline is read as a recommendation",
    file: "src/retired-terms.ts",
    from: `  return blankOut(timeline ? html.slice(0, timeline.index) : html, SOURCE_REGISTER_ENTRY);`,
    to: `  return blankOut(html, SOURCE_REGISTER_ENTRY);`,
  },
  {
    name: "the source register is read as a recommendation",
    file: "src/retired-terms.ts",
    from: `  return blankOut(timeline ? html.slice(0, timeline.index) : html, SOURCE_REGISTER_ENTRY);`,
    to: `  return timeline ? html.slice(0, timeline.index) : html;`,
  },
  {
    name: "no claim is ever found",
    file: "src/retired-terms.ts",
    from: `function claimIn(unit: string): StatedTerms["reason"] | null {`,
    to: `function claimIn(unit: string): StatedTerms["reason"] | null {\n  if (unit.length >= 0) return null;`,
  },
  {
    name: "every unit is read as a claim",
    file: "src/retired-terms.ts",
    from: `function claimIn(unit: string): StatedTerms["reason"] | null {`,
    to: `function claimIn(unit: string): StatedTerms["reason"] | null {\n  if (unit.length >= 0) return "names a free tier";`,
  },
  {
    name: "the page badges nobody",
    file: "src/badged-endings.ts",
    from: `  return [...found].sort();`,
    to: `  return [];`,
  },
  {
    name: "the badge markup is left in the vendor name",
    file: "src/badged-endings.ts",
    from: `  const badgeAt = inner.search(BADGE_ELEMENT);`,
    to: `  const badgeAt = -1 as number;`,
  },
  {
    name: "a qualifier tagline is left in the vendor name",
    file: "src/badged-endings.ts",
    from: `  const text = plainText(withoutTheQualifier(head)).split(SUBJECT_TAGLINE)[0]!.trim();`,
    to: `  const text = plainText(head).trim();`,
  },
  {
    name: "any table cell is read as a provider cell",
    file: "src/badged-endings.ts",
    from: `    if (tag === "td" && !PROVIDER_CELL_ATTRS.test(attrs)) continue;`,
    to: ``,
  },
  {
    name: "the vendor a finding names is not checked against the exemption",
    file: TEST,
    from: `    one.route.test(route) && one.vendors.includes(vendor) && one.unit.test(said));`,
    to: `    one.route.test(route));`,
  },
  {
    name: "the exemption covers any claim on a route it names",
    file: TEST,
    from: `    one.route.test(route) && one.vendors.includes(vendor) && one.unit.test(said));`,
    to: `    one.route.test(route) && one.vendors.includes(vendor));`,
  },
];

const originals = new Map();
for (const m of MUTANTS) if (!originals.has(m.file)) originals.set(m.file, readFileSync(m.file, "utf8"));

const restore = () => { for (const [f, text] of originals) writeFileSync(f, text); };

process.on("exit", restore);

let killed = 0;
const survived = [];

for (const mutant of MUTANTS) {
  restore();
  const before = readFileSync(mutant.file, "utf8");
  if (!before.includes(mutant.from)) {
    survived.push(`${mutant.name} — NOT APPLIED, the text it aims at is not in ${mutant.file}`);
    continue;
  }
  if (before.split(mutant.from).length !== 2) {
    survived.push(`${mutant.name} — NOT APPLIED, the text it aims at appears more than once in ${mutant.file}`);
    continue;
  }
  writeFileSync(mutant.file, before.replace(mutant.from, mutant.to));
  const after = readFileSync(mutant.file, "utf8");
  if (after === before || !after.includes(mutant.to.trim().split("\n")[0] ?? "")) {
    survived.push(`${mutant.name} — NOT APPLIED`);
    continue;
  }
  let outcome;
  try {
    execSync("npm run build", { stdio: "pipe" });
  } catch {
    survived.push(`${mutant.name} — the compiler refused it, which is not a kill`);
    continue;
  }
  try {
    execSync(`node --test --test-concurrency 1 ${TEST}`, { stdio: "pipe", timeout: 180000 });
    outcome = "SURVIVED";
  } catch {
    outcome = "killed";
  }
  if (outcome === "killed") { killed++; console.log(`killed    ${mutant.name}`); }
  else { survived.push(mutant.name); console.log(`SURVIVED  ${mutant.name}`); }
}

restore();
execSync("npm run build", { stdio: "pipe" });
console.log(`\n${killed} of ${MUTANTS.length} killed`);
if (survived.length) { console.log("\nsurvived:"); for (const s of survived) console.log("  " + s); }
