import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const SUITE = ["test/client-class.test.ts", "test/traffic-attribution.test.ts"];

const MUTANTS = [
  ["a-coding-agent-is-filed-as-the-plain-user-family", "src/client-class.ts",
    "  { pattern: /claude-code/i, client_class: \"ai_agent\", family: \"Claude-Code\", trigger: \"user_initiated\" },\n  { pattern: /Claude-User/i, client_class: \"ai_agent\", family: \"Claude-User\", trigger: \"user_initiated\" },",
    "  { pattern: /Claude-User/i, client_class: \"ai_agent\", family: \"Claude-User\", trigger: \"user_initiated\" },\n  { pattern: /claude-code/i, client_class: \"ai_agent\", family: \"Claude-Code\", trigger: \"user_initiated\" },"],
  ["a-broader-rule-above-an-existing-one-strands-it", "src/client-class.ts",
    "  { pattern: /ChatGPT-User/i, client_class: \"ai_agent\", family: \"ChatGPT-User\", trigger: \"user_initiated\" },",
    "  { pattern: /User/i, client_class: \"ai_agent\", family: \"ChatGPT-User\", trigger: \"user_initiated\" },"],
  ["the-split-reports-what-it-attributed-as-the-total", "src/stats.ts",
    "    total: agentHits,\n    user_initiated: perTrigger.user_initiated,",
    "    total: attributed,\n    user_initiated: perTrigger.user_initiated,"],
  ["hits-with-no-family-are-dropped-rather-than-named", "src/stats.ts",
    "    unattributed: agentHits - attributed,",
    "    unattributed: 0,"],
  ["a-family-with-no-rule-is-guessed-as-ambiguous", "src/stats.ts",
    "    const trigger = agentTriggerForFamily(family);\n    if (trigger === null) continue;",
    "    const trigger = agentTriggerForFamily(family) ?? \"ambiguous\";"],
  ["training-crawls-fall-out-of-the-automated-group", "src/stats.ts",
    "    automated: perTrigger.search_index + perTrigger.training,",
    "    automated: perTrigger.search_index,"],
  ["the-search-and-training-detail-does-not-add-up", "src/stats.ts",
    "    automated_by_kind: { search_index: perTrigger.search_index, training: perTrigger.training },",
    "    automated_by_kind: { search_index: perTrigger.search_index, training: 0 },"],
  ["every-agent-hit-reads-as-user-initiated", "src/client-class.ts",
    "  return TRIGGER_BY_FAMILY.get(family) ?? null;",
    "  return TRIGGER_BY_FAMILY.has(family) ? \"user_initiated\" : null;"],
  ["a-crawler-family-is-sold-as-a-person-asking", "src/client-class.ts",
    "  { pattern: /Amazonbot/i, client_class: \"ai_agent\", family: \"Amazonbot\", trigger: \"search_index\" },",
    "  { pattern: /Amazonbot/i, client_class: \"ai_agent\", family: \"Amazonbot\", trigger: \"user_initiated\" },"],
  ["the-coding-agent-family-is-filed-as-a-training-crawl", "src/client-class.ts",
    "  { pattern: /claude-code/i, client_class: \"ai_agent\", family: \"Claude-Code\", trigger: \"user_initiated\" },",
    "  { pattern: /claude-code/i, client_class: \"ai_agent\", family: \"Claude-Code\", trigger: \"training\" },"],
  ["the-published-grouping-loses-a-family", "src/client-class.ts",
    "  for (const [family, trigger] of TRIGGER_BY_FAMILY) out[trigger].push(family);",
    "  for (const [family, trigger] of TRIGGER_BY_FAMILY) if (family !== \"Claude-Code\") out[trigger].push(family);"],
  ["the-endpoint-still-promises-maintainer-traffic-cannot-reach-it", "src/stats.ts",
    "  \"A maintainer running a bare `curl` against a normal page is indistinguishable from any other scripted client and is counted as `sdk_client`, not `internal`, so it inflates web_hits. Coding agents are not: `Claude-Code` and `agent-scraper` are agent tooling classified `ai_agent`, and the automation that maintains this project uses them, so its own requests are inside ai_agent_hits. Read those two families as an upper bound on outside demand rather than a measure of it.\",",
    "  \"A maintainer running a bare `curl` against a normal page is indistinguishable from any other scripted client and is counted as `sdk_client`, not `internal`. It can therefore inflate web_hits but never ai_agent_hits.\","],
  ["the-window-publishes-a-split-of-nothing", "src/stats.ts",
    "  window.ai_agent_by_trigger = splitAgentHitsByTrigger(window.ai_agent_by_family, window.by_class[\"ai_agent\"] ?? 0);",
    "  window.ai_agent_by_trigger = splitAgentHitsByTrigger({}, window.by_class[\"ai_agent\"] ?? 0);"],
  ["the-grouping-is-published-from-somewhere-other-than-the-table", "src/stats.ts",
    "    ai_agent_trigger_families: agentFamiliesByTrigger(),\n    notes: TRAFFIC_NOTES,\n    storage,\n  });\n\n  if (!useRedis()) return unavailable(\"redis-not-configured\");",
    "    ai_agent_trigger_families: { user_initiated: [], search_index: [], training: [], ambiguous: [] },\n    notes: TRAFFIC_NOTES,\n    storage,\n  });\n\n  if (!useRedis()) return unavailable(\"redis-not-configured\");"],
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
const skipped = [];
for (const [name, file, from, to] of MUTANTS) {
  const original = readFileSync(file, "utf-8");
  if (!original.includes(from)) {
    console.log(`SKIP  ${name} — the line it mutates is not in ${file}`);
    skipped.push(name);
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
const killed = MUTANTS.length - survivors.length - uncompiled.length - skipped.length;
console.log(`\n${killed}/${MUTANTS.length} killed`);
if (survivors.length > 0) console.log("survivors:", survivors.join(", "));
if (uncompiled.length > 0) console.log("did not compile:", uncompiled.join(", "));
if (skipped.length > 0) console.log("skipped — target string moved, so these scored nothing:", skipped.join(", "));
