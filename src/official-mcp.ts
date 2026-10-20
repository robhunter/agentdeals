import { createHash } from "node:crypto";

export const OFFICIAL_MCP_KINDS = ["remote", "npm", "pypi", "github"] as const;
export type OfficialMcpKind = typeof OFFICIAL_MCP_KINDS[number];

export interface RetiredMcpName {
  kind: OfficialMcpKind;
  target: string;
  notice: string;
  url: string;
  read_on: string;
}

export interface OfficialMcpServer {
  kind: OfficialMcpKind;
  target: string;
  transport: string;
  authentication: string;
  doc_url: string;
  source_quote: string;
  read_on: string;
  retired_names?: RetiredMcpName[];
}

export interface OfficialMcpCheck {
  checked_on: string;
  passed: boolean;
  failure_streak: number;
  withheld: boolean;
  detail?: string;
}

function isDay(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)
    && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
}

function isHttpsUrl(value: unknown): boolean {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname !== "" && !url.username && !url.password;
  } catch {
    return false;
  }
}

function fieldsOf(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

function targetProblems(kind: unknown, target: unknown, at: string): string[] {
  if (!OFFICIAL_MCP_KINDS.includes(kind as OfficialMcpKind)) return [`${at}.kind is not supported`];
  if (typeof target !== "string" || target.trim() === "") return [`${at}.target is missing`];
  if (kind === "remote" && !isHttpsUrl(target)) return [`${at}.target must be an HTTPS endpoint`];
  if (kind === "github") {
    if (!isHttpsUrl(target)) return [`${at}.target must be a GitHub repository URL`];
    const url = new URL(target);
    if (url.hostname !== "github.com" || !/^\/[^/]+\/[^/]+\/?$/.test(url.pathname) || url.search || url.hash) {
      return [`${at}.target must be a GitHub repository URL`];
    }
  }
  if (kind === "npm" && !/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/.test(target)) {
    return [`${at}.target must be an npm package name`];
  }
  if (kind === "pypi" && !/^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/.test(target)) {
    return [`${at}.target must be a PyPI package name`];
  }
  return [];
}

function evidenceProblems(fields: Record<string, unknown>, at: string, urlField: string, quoteField: string): string[] {
  const problems: string[] = [];
  if (!isHttpsUrl(fields[urlField])) problems.push(`${at}.${urlField} must be an HTTPS URL`);
  if (typeof fields[quoteField] !== "string" || (fields[quoteField] as string).trim() === "") {
    problems.push(`${at}.${quoteField} is missing`);
  }
  if (!isDay(fields.read_on)) problems.push(`${at}.read_on must be a calendar date in YYYY-MM-DD`);
  return problems;
}

export function officialMcpProblems(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length === 0) return ["official_mcp_servers must be a non-empty list when present"];
  const problems: string[] = [];
  const targets = new Set<string>();
  value.forEach((entry: unknown, i: number) => {
    const at = `official_mcp_servers[${i}]`;
    const fields = fieldsOf(entry);
    if (!fields) {
      problems.push(`${at} must be an object`);
      return;
    }
    problems.push(...targetProblems(fields.kind, fields.target, at), ...evidenceProblems(fields, at, "doc_url", "source_quote"));
    for (const name of ["transport", "authentication"]) {
      if (typeof fields[name] !== "string" || (fields[name] as string).trim() === "") problems.push(`${at}.${name} is missing`);
    }
    const target = `${fields.kind}|${fields.target}`;
    if (targets.has(target)) problems.push(`${at} repeats a server`);
    targets.add(target);
    if (fields.retired_names === undefined) return;
    if (!Array.isArray(fields.retired_names)) {
      problems.push(`${at}.retired_names must be a list`);
      return;
    }
    fields.retired_names.forEach((retired: unknown, j: number) => {
      const nameAt = `${at}.retired_names[${j}]`;
      const name = fieldsOf(retired);
      if (!name) {
        problems.push(`${nameAt} must be an object`);
        return;
      }
      problems.push(...targetProblems(name.kind, name.target, nameAt), ...evidenceProblems(name, nameAt, "url", "notice"));
    });
  });
  return problems;
}

export function officialMcpKey(listing: { vendor: string; url: string; tier: string }, entry: OfficialMcpServer): string {
  const retired = (entry.retired_names ?? []).map(name => [name.kind, name.target, name.notice, name.url, name.read_on]);
  const evidence = [listing.vendor, listing.url, listing.tier, entry.kind, entry.target, entry.transport,
    entry.authentication, entry.doc_url, entry.source_quote, entry.read_on, retired];
  return createHash("sha256").update(JSON.stringify(evidence)).digest("hex");
}

export function advanceOfficialMcpCheck(
  previous: OfficialMcpCheck | undefined,
  passed: boolean,
  checkedOn: string,
  detail?: string,
): OfficialMcpCheck {
  if (!isDay(checkedOn)) throw new Error("The check date must be a calendar date in YYYY-MM-DD");
  if (previous && previous.checked_on >= checkedOn) return previous;
  if (passed) return { checked_on: checkedOn, passed: true, failure_streak: 0, withheld: false };
  const yesterdayFailed = previous && !previous.passed
    && Date.parse(checkedOn) - Date.parse(previous.checked_on) === 86400000;
  const streak = yesterdayFailed ? previous.failure_streak + 1 : 1;
  return { checked_on: checkedOn, passed: false, failure_streak: streak,
    withheld: previous?.withheld === true || streak >= 2, ...(detail ? { detail } : {}) };
}

export function withCheckedOfficialMcp<T extends {
  vendor: string; url: string; tier: string; official_mcp_servers?: OfficialMcpServer[];
}>(listing: T, checks: Record<string, OfficialMcpCheck>): T {
  if (!listing.official_mcp_servers) return listing;
  const entries = listing.official_mcp_servers.filter(entry => !checks[officialMcpKey(listing, entry)]?.withheld);
  if (entries.length === listing.official_mcp_servers.length) return listing;
  const { official_mcp_servers: _checkedEntries, ...rest } = listing;
  return (entries.length ? { ...rest, official_mcp_servers: entries } : rest) as T;
}

const TARGET_LABELS: Record<OfficialMcpKind, string> = {
  remote: "endpoint", npm: "npm package", pypi: "PyPI package", github: "GitHub repository",
};
const NOTICE_LABELS: Record<OfficialMcpKind, string> = {
  remote: "The vendor", npm: "npm", pypi: "PyPI", github: "GitHub",
};

export function officialMcpPassage(vendor: string, entry: OfficialMcpServer): string {
  const passage = `${vendor} runs its own MCP server. "${entry.source_quote}" (From ${entry.doc_url}, read ${entry.read_on}.)`
    + ` The ${TARGET_LABELS[entry.kind]} is ${entry.target}, the transport is ${entry.transport}, and authentication uses ${entry.authentication}.`;
  const retired = (entry.retired_names ?? []).map(name =>
    `${NOTICE_LABELS[name.kind]} marks ${name.target} "${name.notice}" (From ${name.url}, read ${name.read_on}.)`);
  return [passage, ...retired].join(" ");
}

export function officialMcpField(offer: { official_mcp_servers?: unknown }): { official_mcp_servers?: unknown } {
  return offer.official_mcp_servers ? { official_mcp_servers: offer.official_mcp_servers } : {};
}

export function withOfficialMcpPassages(text: string, offer: {
  vendor: string; official_mcp_servers?: OfficialMcpServer[];
}): string {
  const passages = (offer.official_mcp_servers ?? []).map(entry => officialMcpPassage(offer.vendor, entry));
  return passages.length ? [text, ...passages].join(" ") : text;
}
