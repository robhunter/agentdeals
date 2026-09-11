import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const SUITE = [
  "test/catalogue-wide-route-citation.test.ts",
  "test/response-provenance.test.ts",
  "test/documented-route-citation.test.ts",
];
const PROVENANCE = "src/provenance.ts";
const SERVER = "src/serve.ts";
const MCP = "src/server.ts";

const STATED = '  const path = options.path ?? (derived === "/" ? options.listingPath ?? "/" : derived);';

const MUTANTS = [
  ["the-records-outrank-the-stated-page", PROVENANCE,
    STATED,
    '  const path = derived === "/" ? options.listingPath ?? "/" : derived;'],

  ["a-listing-page-outranks-the-stated-page", PROVENANCE,
    STATED,
    '  const path = derived === "/" ? options.listingPath ?? options.path ?? "/" : options.path ?? derived;'],

  ["the-stated-page-is-taken-only-where-the-records-agree", PROVENANCE,
    STATED,
    '  const path = derived === "/" ? options.path ?? options.listingPath ?? "/" : derived;'],

  ["the-whole-index-is-one-category", SERVER,
    'const THE_WHOLE_INDEX = "/";',
    'const THE_WHOLE_INDEX = "/changes";'],

  ["a-catalogue-wide-answer-is-dated-from-its-records-again", SERVER,
    "function citedAcrossTheWholeIndex<T extends object>(payload: T): T & { _provenance: Record<string, unknown> } {\n  return citedAt(payload, THE_WHOLE_INDEX);\n}",
    "function citedAcrossTheWholeIndex<T extends object>(payload: T): T & { _provenance: Record<string, unknown> } {\n  return cited(payload);\n}"],

  ["the-agent-block-drops-the-page-it-was-given", SERVER,
    "      ...(citePath ? { path: citePath } : {}),",
    "      ...(citePath ? {} : {}),"],

  ["the-new-offers-cite-their-records", SERVER,
    'endpoint: "/api/new", params: { days }, user_agent: req.headers["user-agent"] ?? "unknown", result_count: result.offers.length });\n    res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });\n    res.end(JSON.stringify(citedAcrossTheWholeIndex(result)));',
    'endpoint: "/api/new", params: { days }, user_agent: req.headers["user-agent"] ?? "unknown", result_count: result.offers.length });\n    res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });\n    res.end(JSON.stringify(cited(result)));'],

  ["the-newest-offers-cite-their-records", SERVER,
    "    res.end(JSON.stringify(citedAcrossTheWholeIndex(dealsWithCodes)));",
    "    res.end(JSON.stringify(cited(dealsWithCodes)));"],

  ["the-stack-audit-cites-its-records", SERVER,
    "    res.end(JSON.stringify(citedAcrossTheWholeIndex(auditResult)));",
    "    res.end(JSON.stringify(cited(auditResult)));"],

  ["the-stack-recommendation-cites-its-records", SERVER,
    "    res.end(JSON.stringify(withAgentBlock(result, null, THE_WHOLE_INDEX)));",
    "    res.end(JSON.stringify(withAgentBlock(result)));"],

  ["the-cost-estimate-cites-its-records", SERVER,
    'endpoint: "/api/costs", params: { services, scale }, user_agent: req.headers["user-agent"] ?? "unknown", result_count: result.services.length });\n    res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });\n    res.end(JSON.stringify(citedAcrossTheWholeIndex(result)));',
    'endpoint: "/api/costs", params: { services, scale }, user_agent: req.headers["user-agent"] ?? "unknown", result_count: result.services.length });\n    res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });\n    res.end(JSON.stringify(cited(result)));'],

  ["the-tool-answers-are-dated-from-their-records-again", MCP,
    "  return JSON.stringify(\n    withProvenance(BASE_URL, payload, { dateForSlug: oldestVerifiedDateForSlug, path: THE_WHOLE_INDEX }),",
    "  return JSON.stringify(\n    withProvenance(BASE_URL, payload, { dateForSlug: oldestVerifiedDateForSlug }),"],

  ["the-tool-search-since-a-date-cites-its-records", MCP,
    "text: citedJsonAcrossTheWholeIndex(enrichedResult) }",
    "text: citedJson(enrichedResult) }"],

  ["the-tool-stack-recommendation-cites-its-records", MCP,
    'params: { mode, use_case, requirements }, result_count: result.stack.length, session_id: getSessionId?.() });\n          return {\n            content: [{ type: "text" as const, text: citedJsonAcrossTheWholeIndex(result) }',
    'params: { mode, use_case, requirements }, result_count: result.stack.length, session_id: getSessionId?.() });\n          return {\n            content: [{ type: "text" as const, text: citedJson(result) }'],

  ["the-tool-cost-estimate-cites-its-records", MCP,
    'params: { mode, services, scale: scale ?? "hobby" }, result_count: result.services.length, session_id: getSessionId?.() });\n          return {\n            content: [{ type: "text" as const, text: citedJsonAcrossTheWholeIndex(result) }',
    'params: { mode, services, scale: scale ?? "hobby" }, result_count: result.services.length, session_id: getSessionId?.() });\n          return {\n            content: [{ type: "text" as const, text: citedJson(result) }'],

  ["the-tool-stack-audit-cites-its-records", MCP,
    'params: { mode, services }, result_count: result.services_analyzed, session_id: getSessionId?.() });\n          return {\n            content: [{ type: "text" as const, text: citedJsonAcrossTheWholeIndex(result) }',
    'params: { mode, services }, result_count: result.services_analyzed, session_id: getSessionId?.() });\n          return {\n            content: [{ type: "text" as const, text: citedJson(result) }'],

  ["the-fixture-catalogue-is-the-published-one", "test/catalogue-wide-route-citation.test.ts",
    "    writeFileSync(fixture, JSON.stringify({ ...index, offers: [only] }));",
    "    writeFileSync(fixture, JSON.stringify(index));"],
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
