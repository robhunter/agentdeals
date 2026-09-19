import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const SUITE = ["test/catalogue-verification-claims.test.ts", "test/mcp-tools-published.test.ts"];

const MUTANTS = [
  ["test/published-files.ts", "s/return byPath.size ? \\[/return [/", "no-op"],
  ["test/published-files.ts", "s|for \\(const relative of mcpBundle\\(\\)\\) record\\(relative, \"the extension bundle\"\\);|for (const relative of []) record(relative, \"the extension bundle\");|", "the bundle channel carries nothing"],
  ["test/published-files.ts", "s|return bundleExclusions\\(\\).some\\(|return false \\&\\& bundleExclusions().some(|", "nothing is excluded from the bundle"],
  ["test/published-files.ts", "s|if \\(!relative.endsWith\\(\".json\"\\)\\) return raw;|if (!relative.endsWith(\".json\")) return raw; return \"\";|", "a JSON document reads as no prose"],
  ["test/published-files.ts", "s|record\\(FILED_WITH_THE_MCP_REGISTRY, \"the MCP registry\"\\);||", "the registry channel is dropped"],
  ["test/catalogue-verification-claims.test.ts", "s|A_VERIFICATION_ADJECTIVE.test\\(sentence\\) \\&\\& A_THING_WE_PUBLISH.test\\(sentence\\)|false|", "no sentence is a claim"],
  ["test/catalogue-verification-claims.test.ts", "s|!ADDRESSED_TO_THE_READER.test\\(sentence\\)|false|", "every sentence is addressed to the reader"],
  ["test/catalogue-verification-claims.test.ts", "s|const A_DATE_THE_CATALOGUE_CARRIES =|const A_DATE_THE_CATALOGUE_CARRIES = /(?!)/; const UNUSED_A_DATE =|", "no date is a claim over the catalogue"],
  ["test/catalogue-verification-claims.test.ts", "s|const BY_HAND = |const BY_HAND = /(?!)/; const UNUSED_BY_HAND = |", "no prose claims hand-checking"],
  ["src/mcp-tool-inventory.ts", "s|const entries = MCP_TOOLS.map|const entries = MCP_TOOLS.slice(0, -1).map|", "the skill file renders one tool short"],
  ["src/mcp-tool-inventory.ts", "s|const rows = MCP_TOOLS.map|const rows = MCP_TOOLS.slice(0, -1).map|", "the readme table renders one tool short"],
  ["src/mcp-tool-inventory.ts", "s|`### \\${tool.name}\\\\n\\${tool.brief}`|`### ${tool.name}\\n${tool.card}`|", "the skill file states the short card, not the contract"],
  ["scripts/sync-published-tool-copy.mjs", "s|const end = endOfSection\\(markdown, start, heading\\);|const end = start;|", "the section is never replaced"],
  ["scripts/sync-published-tool-copy.mjs", "s|if \\(line.startsWith\\(\"\\|\"\\)\\) end = cursor;|if (false) end = cursor;|", "the table has no rows to replace"],
];

function run() {
  try {
    execFileSync("node", ["--test", "--test-concurrency", "1", ...SUITE], { encoding: "utf8", stdio: "pipe" });
    return "SURVIVED";
  } catch {
    return "killed";
  }
}

function build() {
  try {
    execFileSync("npx", ["tsc"], { encoding: "utf8", stdio: "pipe" });
    return true;
  } catch (err) {
    return false;
  }
}

let killed = 0;
for (const [file, expression, description] of MUTANTS) {
  const original = readFileSync(file, "utf8");
  execFileSync("perl", ["-0pi", "-e", expression, file]);
  const changed = readFileSync(file, "utf8") !== original;
  if (!changed) {
    console.log(`  NOT APPLIED  ${description} (${file})`);
    continue;
  }
  const compiled = file.startsWith("src/") ? build() : true;
  const verdict = compiled ? run() : "killed by the compiler";
  if (verdict !== "SURVIVED") killed++;
  console.log(`  ${verdict.padEnd(22)} ${description}`);
  writeFileSync(file, original);
  if (file.startsWith("src/")) build();
}

console.log(`\n${killed} of ${MUTANTS.length} killed`);
