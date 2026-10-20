import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { OfficialMcpCheck, OfficialMcpKind } from "./official-mcp.js";

export interface OfficialMcpProposal {
  key: string;
  vendor: string;
  listing_url: string;
  tier: string;
  kind: OfficialMcpKind;
  target: string;
  failed_on: string;
  reason?: string;
}

export interface OfficialMcpStore {
  checks: Record<string, OfficialMcpCheck>;
  proposals: OfficialMcpProposal[];
}

export function officialMcpStorePath(): string {
  return process.env.AGENTDEALS_OFFICIAL_MCP_CHECKS_PATH
    || fileURLToPath(new URL("../data/official_mcp_checks.json", import.meta.url));
}

export function readOfficialMcpStore(file = officialMcpStorePath()): OfficialMcpStore {
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { checks: {}, proposals: [] };
    throw error;
  }
  const store = JSON.parse(raw);
  if (!store || !store.checks || typeof store.checks !== "object" || Array.isArray(store.checks)
    || !Array.isArray(store.proposals)) throw new Error(`Invalid official MCP check store: ${file}`);
  for (const [key, check] of Object.entries(store.checks) as [string, OfficialMcpCheck][]) {
    if (!/^[a-f0-9]{64}$/.test(key) || !check || typeof check !== "object"
      || typeof check.checked_on !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(check.checked_on)
      || !Number.isFinite(Date.parse(check.checked_on)) || new Date(check.checked_on).toISOString().slice(0, 10) !== check.checked_on
      || typeof check.passed !== "boolean" || typeof check.withheld !== "boolean"
      || !Number.isSafeInteger(check.failure_streak) || check.failure_streak < 0
      || (check.passed && (check.withheld || check.failure_streak !== 0))
      || (!check.passed && (check.failure_streak < 1 || (check.failure_streak >= 2 && !check.withheld)))) {
      throw new Error(`Invalid official MCP check in ${file}: ${key}`);
    }
  }
  return store;
}

export function writeOfficialMcpStore(store: OfficialMcpStore, file = officialMcpStorePath()): void {
  const temporary = `${file}.${process.pid}.tmp`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  try {
    fs.writeFileSync(temporary, JSON.stringify(store, null, 2) + "\n", { flag: "wx" });
    fs.renameSync(temporary, file);
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}
