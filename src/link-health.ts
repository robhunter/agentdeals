import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { LinkUnreachable } from "./types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function linkHealthPath(): string {
  return process.env.AGENTDEALS_LINK_HEALTH_PATH || path.join(__dirname, "..", "data", "link_health.json");
}

export type LivenessOutcome = "reachable" | "unreachable" | "unknown";

export const LINK_GRACE_DAYS = 14;

const STATUS_UNREACHABLE = new Set([404, 410]);

const NETWORK_ERROR_UNREACHABLE = new Set(["ENOTFOUND"]);

export interface LinkCheckRecord {
  url: string;
  checked: string;
  outcome: LivenessOutcome;
  detail: string;
  terminal: boolean;
  last_reachable: string | null;
  consecutive_unreachable: number;
}

export interface LinkHealthIndex {
  generated_at: string;
  links: LinkCheckRecord[];
}

export function classifyHttpStatus(status: number): LivenessOutcome {
  if (status >= 200 && status < 400) return "reachable";
  if (STATUS_UNREACHABLE.has(status)) return "unreachable";
  return "unknown";
}

export function classifyNetworkError(code: string | undefined): LivenessOutcome {
  if (code && NETWORK_ERROR_UNREACHABLE.has(code)) return "unreachable";
  return "unknown";
}

export function isTerminalStatus(status: number): boolean {
  return status === 410;
}

let cachedLinkHealth: Map<string, LinkCheckRecord> | null = null;

export function resetLinkHealthCache(): void {
  cachedLinkHealth = null;
}

export function loadLinkHealth(): Map<string, LinkCheckRecord> {
  if (cachedLinkHealth) return cachedLinkHealth;

  const empty = new Map<string, LinkCheckRecord>();
  const sourcePath = linkHealthPath();

  if (!fs.existsSync(sourcePath)) {
    cachedLinkHealth = empty;
    return cachedLinkHealth;
  }

  let parsed: LinkHealthIndex;
  try {
    parsed = JSON.parse(fs.readFileSync(sourcePath, "utf-8"));
  } catch (err) {
    console.error(`Link health index unreadable, treating every link as unchecked: ${err}`);
    cachedLinkHealth = empty;
    return cachedLinkHealth;
  }

  if (!parsed || !Array.isArray(parsed.links)) {
    console.error("Link health index is missing 'links', treating every link as unchecked");
    cachedLinkHealth = empty;
    return cachedLinkHealth;
  }

  const map = new Map<string, LinkCheckRecord>();
  for (const record of parsed.links) {
    if (record && typeof record.url === "string") map.set(record.url, record);
  }
  cachedLinkHealth = map;
  return cachedLinkHealth;
}

export function unreachableNotice(
  record: LinkCheckRecord | undefined,
  nowMs: number = Date.now(),
  graceDays: number = LINK_GRACE_DAYS
): LinkUnreachable | null {
  if (!record) return null;
  if (record.outcome !== "unreachable") return null;

  if (!record.terminal) {
    if (!record.last_reachable) return null;
    const elapsedDays = Math.floor(
      (nowMs - new Date(record.last_reachable).getTime()) / (24 * 60 * 60 * 1000)
    );
    if (!Number.isFinite(elapsedDays) || elapsedDays < graceDays) return null;
  }

  return {
    last_reachable: record.last_reachable,
    checked: record.checked,
    terminal: record.terminal,
  };
}

export function unreachableNoticeForUrl(
  url: string,
  nowMs: number = Date.now()
): LinkUnreachable | null {
  return unreachableNotice(loadLinkHealth().get(url), nowMs);
}
