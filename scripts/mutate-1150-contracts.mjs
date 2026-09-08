import { readFileSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";

const SERVE = "src/serve.ts";
const SERVER = "src/server.ts";
const INVENTORY = "src/mcp-tool-inventory.ts";
const PLATFORM = "src/platform-codes.ts";
const RETIRED = "data/retired_agent_submissions.json";

const TESTS = [
  "test/mcp-tools-published.test.ts",
  "test/agent-submitted-codes-withheld.test.ts",
  "test/marketplace-api.test.ts",
].join(" ");

const MUTANTS = [
  {
    name: "a withdrawn tool is registered again",
    file: SERVER,
    from: '  server.registerTool(\n    "get_referral_code",',
    to: '  server.registerTool(\n    "manage_friends",\n    { description: "Manage your agent friendships.", inputSchema: { action: z.string() } },\n    async () => ({ content: [{ type: "text" as const, text: "{}" }] }),\n  );\n\n  server.registerTool(\n    "get_referral_code",',
  },
  {
    name: "the withdrawn register loses an entry, so nothing checks that tool stayed gone",
    file: INVENTORY,
    from: '  { name: "manage_friends", reason:',
    to: '  { name: "not_a_tool_we_ever_had", reason:',
  },
  {
    name: "the homepage stat tile states the count as a literal again",
    file: SERVE,
    from: '<div class="stat-num stat-cyan">${MCP_TOOL_COUNT}</div><div class="stat-label">MCP Tools</div>',
    to: '<div class="stat-num stat-cyan">4</div><div class="stat-label">MCP Tools</div>',
  },
  {
    name: "llms.txt states the count as a literal again",
    file: SERVE,
    from: "## MCP Tools (${MCP_TOOL_COUNT})",
    to: "## MCP Tools (4)",
  },
  {
    name: "a guide lists fewer tools than the protocol offers",
    file: SERVE,
    from: "    MCP_TOOLS.map(function(t){return '    <div class=\"tool-card\"><code>' + t.name + '</code><p>' + escHtmlServer(t.card) + '</p></div>\\n'}).join('') +",
    to: "    MCP_TOOLS.slice(0, 4).map(function(t){return '    <div class=\"tool-card\"><code>' + t.name + '</code><p>' + escHtmlServer(t.card) + '</p></div>\\n'}).join('') +",
  },
  {
    name: "the server card names a tool the protocol does not offer",
    file: SERVER,
    from: '        name: "get_referral_code",\n        description: MCP_TOOLS.find((t) => t.name === "get_referral_code")!.brief,',
    to: '        name: "get_referral_code_v2",\n        description: MCP_TOOLS.find((t) => t.name === "get_referral_code")!.brief,',
  },
  {
    name: "a tool description points the caller at a withdrawn tool again",
    file: INVENTORY,
    from: 'brief: "Look up the referral link we hold for a vendor, with the reader benefit and every restriction attached to it. We hold codes for a handful of vendors and earn a commission on them; /disclosure lists all of them.",',
    to: 'brief: "Look up the referral link we hold for a vendor. Supply the API key from register_agent for attribution.",',
  },
  {
    name: "a tool advertises a capability that does not work",
    file: INVENTORY,
    from: 'brief: "Track pricing changes across developer tools — free tier removals, limit reductions, new free tiers, and upcoming expirations.",',
    to: 'brief: "Track pricing changes across developer tools. Webhook delivery is not enabled yet.",',
  },
  {
    name: "a submitted code can reach a listing again",
    file: PLATFORM,
    from: "  return getAllPlatformCodes().map((c) => ({",
    to: "  const submitted = JSON.parse(fs.readFileSync(path.join(__dirname, \"..\", \"data\", \"referral_codes.json\"), \"utf-8\")).referral_codes.filter((c: any) => c.status === \"active\").map((c: any) => ({ ...c, referee_benefit: c.description }));\n  return [...getAllPlatformCodes(), ...submitted].map((c) => ({",
  },
  {
    name: "a submitted code can reach the best-code slot again",
    file: PLATFORM,
    from: "  const platformCode = getPlatformCodeForVendor(vendorName);\n  if (!platformCode) return null;",
    to: "  const platformCode = getPlatformCodeForVendor(vendorName) ?? JSON.parse(fs.readFileSync(path.join(__dirname, \"..\", \"data\", \"referral_codes.json\"), \"utf-8\")).referral_codes.find((c: any) => c.status === \"active\" && c.vendor.toLowerCase() === vendorName.toLowerCase());\n  if (!platformCode) return null;",
  },
  {
    name: "the submission path accepts a code again",
    file: SERVE,
    from: '    res.writeHead(410, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });\n    res.end(JSON.stringify({ error: AGENT_SUBMISSION_RETIRED_REASON }));',
    to: '    res.writeHead(201, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });\n    res.end(JSON.stringify({ id: "code_stub" }));',
  },
  {
    name: "an empty answer stops saying why it is empty",
    file: SERVE,
    from: "citedUndated({ codes: [], total: 0, withheld_reason: AGENT_SUBMISSION_RETIRED_REASON }, REFERRAL_CODE_LISTING_PAGE)",
    to: "citedUndated({ codes: [], total: 0 }, REFERRAL_CODE_LISTING_PAGE)",
  },
  {
    name: "the withdrawn submission is dropped instead of recorded",
    file: RETIRED,
    from: '"code": "supabase-referral-2026"',
    to: '"code": "some-other-code"',
  },
  {
    name: "/disclosure describes agent submission again",
    file: SERVE,
    from: "    <h2>Current Referral Partners</h2>",
    to: "    <h2>Agent-Submitted Referral Codes</h2>\n    <p>Some referral codes on AgentDeals were submitted by community agents.</p>\n    <h2>Current Referral Partners</h2>",
  },
];

const only = process.argv[2] ? Number(process.argv[2]) : null;

for (const [i, mutant] of MUTANTS.entries()) {
  if (only !== null && only !== i) continue;
  const original = readFileSync(mutant.file, "utf8");
  if (!original.includes(mutant.from)) {
    console.log(`SKIP  ${i} ${mutant.name} — anchor not found in ${mutant.file}`);
    continue;
  }
  writeFileSync(mutant.file, original.replace(mutant.from, mutant.to));
  let killed = false;
  let output = "";
  try {
    execSync("npx tsc", { stdio: "pipe" });
    output = execSync(`node --test --test-concurrency 1 ${TESTS}`, { stdio: "pipe" }).toString();
  } catch (e) {
    killed = true;
    output = `${e.stdout ?? ""}${e.stderr ?? ""}`;
  } finally {
    writeFileSync(mutant.file, original);
    execSync("npx tsc", { stdio: "pipe" });
  }
  const failing = [...output.matchAll(/^ {2,4}✖ (.+?) \(/gm)].map(([, name]) => name);
  console.log(`${killed ? "KILLED" : "SURVIVED"}  ${i} ${mutant.name}`);
  if (killed) console.log(`        by: ${failing.join("; ") || "(build or startup)"}`);
}
