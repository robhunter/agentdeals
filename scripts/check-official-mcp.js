import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { readOfficialMcpStore, writeOfficialMcpStore, officialMcpStorePath } from "../dist/official-mcp-store.js";
import { officialMcpProblems, officialMcpKey, advanceOfficialMcpCheck } from "../dist/official-mcp.js";
import { MCP_PROTOCOL_VERSION } from "../dist/mcp-tool-inventory.js";
import { stripHtml, readBodyWithin } from "./verify-freshness.js";

const normalize = text => text.replace(/\s+/g, " ").replace(/\s+([.,;:!?])/g, "$1").trim();
const renderedText = body => stripHtml(body).replace(/&#(x[0-9a-f]+|[0-9]+);/gi, (entity, code) => {
  const point = code[0].toLowerCase() === "x" ? Number.parseInt(code.slice(1), 16) : Number.parseInt(code, 10);
  return point > 0 && point <= 0x10ffff && !(point >= 0xd800 && point <= 0xdfff)
    ? String.fromCodePoint(point) : entity;
});
const quotePresent = (body, quote) => normalize(renderedText(body)).includes(normalize(quote));

async function readUrl(url, options, init = {}, readBody = true) {
  const response = await (options.fetchImpl ?? fetch)(url, {
    ...init,
    headers: { "User-Agent": "agentdeals-internal-bot/1.0 official-mcp-check", ...init.headers },
    signal: AbortSignal.timeout(options.timeoutMs ?? 10000),
  });
  if (!readBody) {
    await response.body?.cancel();
    return { status: response.status, text: "", headers: response.headers };
  }
  const body = await readBodyWithin(response, options.maxBytes ?? 16000000);
  if (body.tooLarge) throw new Error("response exceeds the size limit");
  return { status: response.status, text: body.html, headers: response.headers };
}

async function npmLatest(target, options) {
  const response = await readUrl(`https://registry.npmjs.org/${encodeURIComponent(target)}`, options, {
    headers: { Accept: "application/vnd.npm.install-v1+json" },
  });
  if (response.status !== 200) throw new Error(`npm returned HTTP ${response.status}`);
  const data = JSON.parse(response.text);
  const latest = data["dist-tags"]?.latest;
  const version = latest && data.versions?.[latest];
  if (!version || typeof version !== "object" || Array.isArray(version) || version.version !== latest) {
    throw new Error("npm returned no valid latest version");
  }
  return version;
}

async function checkTarget(entry, options) {
  if (entry.kind === "npm") {
    const latest = await npmLatest(entry.target, options);
    return typeof latest.deprecated === "string" && latest.deprecated.trim()
      ? `npm marks the latest version deprecated: ${latest.deprecated}` : null;
  }
  if (entry.kind === "pypi") {
    const response = await readUrl(`https://pypi.org/pypi/${encodeURIComponent(entry.target)}/json`, options);
    if (response.status !== 200) return `PyPI returned HTTP ${response.status}`;
    const data = JSON.parse(response.text);
    const files = data.urls;
    if (!data.info?.version || !Array.isArray(files) || files.length === 0) return "PyPI returned no installable latest release";
    if (data.info.yanked === true || files.every(file => file.yanked === true)) return "PyPI has yanked the latest release";
    return null;
  }
  if (entry.kind === "github") {
    const response = await readUrl(entry.target, options);
    return response.status === 200 ? null : `repository returned HTTP ${response.status}`;
  }
  const response = await readUrl(entry.target, options, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {
      protocolVersion: MCP_PROTOCOL_VERSION, capabilities: {},
      clientInfo: { name: "agentdeals-official-mcp-check", version: "1" },
    } }),
  }, false);
  const session = response.headers.get("mcp-session-id");
  if (session) {
    try {
      const cleanup = await (options.fetchImpl ?? fetch)(entry.target, {
        method: "DELETE", headers: { "Mcp-Session-Id": session, "MCP-Protocol-Version": MCP_PROTOCOL_VERSION,
          "User-Agent": "agentdeals-internal-bot/1.0 official-mcp-check" },
        signal: AbortSignal.timeout(options.timeoutMs ?? 10000),
      });
      await cleanup.body?.cancel();
    } catch {}
  }
  return [404, 410].includes(response.status) ? `endpoint returned HTTP ${response.status}` : null;
}

async function checkRetiredName(name, options) {
  if (name.kind === "npm") {
    const version = await npmLatest(name.target, options);
    return typeof version.deprecated === "string" && normalize(version.deprecated).includes(normalize(name.notice))
      ? null : `npm no longer states the notice for ${name.target}`;
  }
  const response = await readUrl(name.url, options);
  if (response.status !== 200) return `retirement notice returned HTTP ${response.status}`;
  return quotePresent(response.text, name.notice) ? null : `retirement notice no longer contains its quote for ${name.target}`;
}

export async function checkOfficialMcpEntry(entry, options = {}) {
  const problems = officialMcpProblems([entry]);
  if (problems.length) return { passed: false, detail: problems.join("; ") };
  try {
    const doc = await readUrl(entry.doc_url, options);
    if (doc.status !== 200) return { passed: false, detail: `documentation returned HTTP ${doc.status}` };
    if (!quotePresent(doc.text, entry.source_quote)) return { passed: false, detail: "documentation no longer contains its quote" };
    const targetProblem = await checkTarget(entry, options);
    if (targetProblem) return { passed: false, detail: targetProblem };
    for (const name of entry.retired_names ?? []) {
      const problem = await checkRetiredName(name, options);
      if (problem) return { passed: false, detail: problem };
    }
    return { passed: true };
  } catch (error) {
    return { passed: false, detail: `${error.cause?.code ?? error.code ?? error.name}: ${error.message}` };
  }
}

export async function checkOfficialMcpListings(offers, previous = { checks: {}, proposals: [] }, checkedOn, options = {}) {
  advanceOfficialMcpCheck(undefined, true, checkedOn);
  for (const offer of offers) {
    const problems = officialMcpProblems(offer.official_mcp_servers);
    if (problems.length) throw new Error(`${offer.vendor}: ${problems.join("; ")}`);
  }
  const checks = { ...previous.checks };
  const proposals = [...previous.proposals];
  for (const offer of offers) {
    for (const entry of offer.official_mcp_servers ?? []) {
      const key = officialMcpKey(offer, entry);
      if (checks[key]?.checked_on >= checkedOn) continue;
      const result = await checkOfficialMcpEntry(entry, options);
      const before = checks[key];
      const after = advanceOfficialMcpCheck(before, result.passed, checkedOn, result.detail);
      checks[key] = after;
      if (after.withheld && !before?.withheld) {
        const proposal = { key, vendor: offer.vendor, listing_url: offer.url, tier: offer.tier,
          kind: entry.kind, target: entry.target, failed_on: checkedOn, reason: after.detail };
        const existing = proposals.findIndex(item => item.key === key);
        if (existing < 0) proposals.push(proposal);
        else proposals[existing] = proposal;
      }
    }
  }
  return { checks, proposals };
}

export async function runOfficialMcpCheck(options = {}) {
  const indexPath = options.indexPath ?? process.env.AGENTDEALS_INDEX_PATH ?? new URL("../data/index.json", import.meta.url);
  const storePath = options.storePath ?? officialMcpStorePath();
  const offers = JSON.parse(readFileSync(indexPath, "utf8")).offers;
  if (!Array.isArray(offers)) throw new Error("The catalogue must carry an offers array");
  const previous = readOfficialMcpStore(storePath);
  const checkedOn = options.checkedOn ?? new Date().toISOString().slice(0, 10);
  const result = await checkOfficialMcpListings(offers, previous, checkedOn, options);
  if (options.write) writeOfficialMcpStore(result, storePath);
  const entries = offers.flatMap(offer => (offer.official_mcp_servers ?? []).map(entry => ({
    vendor: offer.vendor, target: entry.target, ...result.checks[officialMcpKey(offer, entry)],
  })));
  return { ...result, entries };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    const { values } = parseArgs({ options: {
      write: { type: "boolean", default: false }, index: { type: "string" }, state: { type: "string" },
      date: { type: "string" }, preflight: { type: "boolean", default: false },
    } });
    const result = await runOfficialMcpCheck({ write: values.write, indexPath: values.index,
      storePath: values.state, checkedOn: values.date });
    console.log(JSON.stringify(result, null, 2));
    if (values.preflight && result.entries.some(entry => !entry.passed)) process.exitCode = 1;
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
