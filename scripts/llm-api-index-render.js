import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function indexPath() {
  return process.env.AGENTDEALS_LLM_INDEX_PATH || path.join(ROOT, "artifacts", "free-llm-api-index", "README.md");
}

export function servedOnFrom(args) {
  const onArg = args.find(a => a.startsWith("--on="));
  return onArg ? onArg.slice("--on=".length) : new Date().toISOString().slice(0, 10);
}

export async function renderIndex(servedOn) {
  const { excludedByReason, readmeCensus, readmeSelection, renderReadme } = await import(`${ROOT}/dist/llm-api-readme.js`);
  const { reverificationIntervalDays } = await import(`${ROOT}/dist/badge-staleness.js`);

  const nowMs = Date.parse(`${servedOn}T00:00:00Z`);
  if (!Number.isFinite(nowMs)) throw new Error(`Not a date: ${servedOn}`);

  const offers = JSON.parse(readFileSync(path.join(ROOT, "data", "index.json"), "utf8")).offers;
  const changes = JSON.parse(readFileSync(path.join(ROOT, "data", "deal_changes.json"), "utf8")).changes;

  const staleAfterDays = reverificationIntervalDays(offers.map(o => o.verifiedDate), nowMs);
  const { rows, excluded } = readmeSelection(offers, changes, { servedOn, nowMs, staleAfterDays });

  return {
    rows,
    excluded,
    census: readmeCensus(rows),
    excludedByReason: excludedByReason(excluded),
    rendered: renderReadme(rows, { staleAfterDays, excluded }),
    staleAfterDays,
    servedOn,
  };
}

export function heldIndex(at = indexPath()) {
  try {
    return readFileSync(at, "utf8");
  } catch {
    return null;
  }
}
