import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ChangeRefusal, ChangeRefusalIndex } from "./change-refusal.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function refusalsPath(): string {
  return (
    process.env.AGENTDEALS_REFUSALS_PATH ||
    path.join(__dirname, "..", "data", "change_refusals.json")
  );
}

let cachedByVendor: Map<string, ChangeRefusal[]> | null = null;

export function resetRefusalStoreCache(): void {
  cachedByVendor = null;
}

export function readRefusalsFile(): ChangeRefusal[] {
  const file = refusalsPath();
  if (!fs.existsSync(file)) return [];
  let parsed: ChangeRefusalIndex;
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf-8"));
  } catch {
    return [];
  }
  return Array.isArray(parsed?.refusals) ? parsed.refusals : [];
}

export function storedRefusalsFor(vendor: string): ChangeRefusal[] {
  if (!cachedByVendor) {
    cachedByVendor = new Map();
    for (const refusal of readRefusalsFile()) {
      if (!refusal?.vendor) continue;
      const key = refusal.vendor.trim().toLowerCase();
      const held = cachedByVendor.get(key);
      if (held) held.push(refusal);
      else cachedByVendor.set(key, [refusal]);
    }
  }
  return cachedByVendor.get(vendor.trim().toLowerCase()) ?? [];
}
