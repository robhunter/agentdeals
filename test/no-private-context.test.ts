import { describe, it } from "node:test";
import assert from "node:assert";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = join(__dirname, "..");

const ROOTS = ["src", "test", "scripts", "docs"];
const EXTENSIONS = [".ts", ".js", ".mjs", ".md", ".json"];
const SKIP_DIRS = new Set(["node_modules", "dist", ".git", "data", "coverage"]);

const SELF = relative(REPO, fileURLToPath(import.meta.url));

function walk(dir: string, out: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (EXTENSIONS.some((e) => entry.endsWith(e))) out.push(full);
  }
  return out;
}

function scannedFiles(): string[] {
  const files: string[] = [];
  for (const root of ROOTS) walk(join(REPO, root), files);
  for (const entry of readdirSync(REPO)) {
    if (entry.endsWith(".md") || entry.endsWith(".json")) {
      const full = join(REPO, entry);
      if (statSync(full).isFile()) files.push(full);
    }
  }
  return files.filter((f) => relative(REPO, f) !== SELF);
}

type Rule = { name: string; pattern: RegExp; why: string };

const RULES: Rule[] = [
  {
    name: "business tax identifier",
    pattern: /\b\d{2}-\d{7}\b/,
    why: "an EIN in a public repo is identity data, and it is used to verify identity to vendors and banks",
  },
  {
    name: "postal address",
    pattern:
      /\b\d{1,6}\s+[A-Z][A-Za-z]+(?:\s+[A-Z][A-Za-z]+)?\s+(?:Way|Street|St\.|Road|Rd\.|Avenue|Ave\.?|Drive|Dr\.|Lane|Ln\.|Boulevard|Blvd\.?|Court|Ct\.|Place|Pl\.|Terrace|Circle|Parkway|Pkwy\.?|Highway|Hwy\.?)(?:\b|,)|\b(?:P\.?\s?O\.?\s+Box|Suite|Ste\.|Unit|Apt\.?)\s+#?\d+/i,
    why: "a street address is personal data whether or not it is also a business address",
  },
  {
    name: "city, state and ZIP",
    pattern:
      /\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2},?\s+(?:A[KLRZ]|C[AOT]|D[CE]|FL|GA|HI|I[ADLN]|K[SY]|LA|M[ADEINOST]|N[CDEHJMVY]|O[HKR]|P[AR]|RI|S[CD]|T[NX]|UT|V[AT]|W[AIVY])\s+\d{5}(?:-\d{4})?\b/,
    why:
      "the rule above depends on a street-suffix vocabulary, so an abbreviation, a PO box or " +
      "a bare locality line slips it — a city, state and ZIP together is the part of a US " +
      "address that always looks like one",
  },
  {
    name: "private commercial conversation",
    pattern: /\bpartner(?:ship)?\s+(?:conversation|discussion|talks|call|negotiation)/i,
    why: "pointing a code comment at a private commercial discussion tells a reader it exists and what it is about",
  },
  {
    name: "commercial counterparty as audience",
    pattern:
      /\b(?:going|sent|shown|quoted|promised|reported|shared|pitched|due)\s+to\s+(?:an?|the|our)\s+(?:external\s+|prospective\s+|potential\s+|commercial\s+)?(?:partner|investor|acquirer|buyer)\b|\b(?:our|my)\s+(?:external\s+|prospective\s+|potential\s+|commercial\s+)?(?:partner|investor|acquirer|buyer)\b/i,
    why:
      "'partner' alone is ordinary product vocabulary here — vendors run partner programs, " +
      "/disclosure lists referral partners, and type: 'partner' is a schema value. What is " +
      "banned is a counterparty of ours as the audience for a number or a decision: that is " +
      "what reveals a commercial relationship and what it turns on",
  },
  {
    name: "internal role attribution",
    pattern: /\bthe PM\b|\bPM's\b|\bPM agent\b/,
    why: "state the reason for a decision, not who made it — the reason is what a future reader needs",
  },
  {
    name: "named approval",
    pattern: /\b(?:approved|confirmed|blocked on|awaiting|greenlit|signed off)\s+(?:by\s+)?Rob\b/i,
    why: "internal approval state is not a property of the code and reveals who decides what",
  },
  {
    name: "legal entity",
    pattern: /\bRobbobobbo\s+LLC\b/i,
    why: "the operating entity's legal name belongs in business records, not in the source tree",
  },
];

describe("no private operational context in tracked source", () => {
  const files = scannedFiles();

  it("scans a meaningful number of files", () => {
    assert.ok(files.length > 50, `only ${files.length} files scanned — the walk is broken`);
    const rel = files.map((f) => relative(REPO, f));
    for (const expected of ["src/serve.ts", "src/stats.ts", "README.md"]) {
      assert.ok(rel.includes(expected), `${expected} was not scanned`);
    }
  });

  for (const rule of RULES) {
    it(`no ${rule.name}`, () => {
      const hits: string[] = [];
      for (const file of files) {
        const text = readFileSync(file, "utf8");
        if (!rule.pattern.test(text)) continue;
        const lines = text.split("\n");
        for (let i = 0; i < lines.length; i++) {
          if (rule.pattern.test(lines[i])) {
            hits.push(`${relative(REPO, file)}:${i + 1}: ${lines[i].trim().slice(0, 120)}`);
          }
        }
      }
      assert.deepStrictEqual(hits, [], `${rule.why}\n\n${hits.join("\n")}`);
    });
  }
});
