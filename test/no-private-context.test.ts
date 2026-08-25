// Source and docs must not carry private operational context.
//
// This repo is public. Comments, test fixtures and docs are read by anyone who clones it,
// and they are the easiest place for context to leak, because a comment feels like a note
// to yourself rather than something published. It is not: it ships.
//
// Three things went in this way and had to be taken back out (2026-08-25):
//   - a business identity block (entity name, tax ID, street address) in a docs/ file,
//     added as a convenience for filling in affiliate registrations
//   - two comments explaining a retention choice by pointing at a private commercial
//     conversation, which is context the reader cannot have and we do not want to give
//   - a scatter of comments and test names attributing a decision to an internal role
//     rather than stating the reason for it
//
// The last one is the instructive case, because it is also just worse commenting. "X
// overrode this during review" tells you who to blame; "a 400 here throws away the most
// interesting data this endpoint collects" tells you whether you may change it. Writing
// the reason instead of the authority removes the leak and improves the comment, so this
// guard costs nothing to satisfy.
//
// A note on scope: this bans phrases that only make sense with private context, never
// names on their own. "Rob Hunter" is the author field of package.json and manifest.json
// and belongs there. "Approved by Rob" in a source comment does not.

import { describe, it } from "node:test";
import assert from "node:assert";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = join(__dirname, "..");

// Human-authored surfaces. data/ is excluded deliberately: it is scraped vendor copy,
// not anything we wrote, and it is large enough that a prose pattern would false-positive
// on some vendor's description of their own billing address.
const ROOTS = ["src", "test", "scripts", "docs"];
const EXTENSIONS = [".ts", ".js", ".mjs", ".md", ".json"];
const SKIP_DIRS = new Set(["node_modules", "dist", ".git", "data", "coverage"]);

// This file names the banned patterns in order to ban them.
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
  // Root-level markdown (README, AGENTS, CONTRIBUTING, CHANGELOG...) and the manifests.
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
      /\b\d{3,5}\s+[A-Z][A-Za-z]+(?:\s+[A-Z][A-Za-z]+)?\s+(?:Way|Street|Road|Avenue|Drive|Lane|Boulevard|Court|Place|Terrace|Circle)\b/,
    why: "a street address is personal data whether or not it is also a business address",
  },
  {
    name: "private commercial conversation",
    pattern: /\bpartner(?:ship)?\s+(?:conversation|discussion|talks|call|negotiation)/i,
    why: "pointing a code comment at a private commercial discussion tells a reader it exists and what it is about",
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
    // A guard that silently stops scanning is worse than no guard: it reports success.
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
