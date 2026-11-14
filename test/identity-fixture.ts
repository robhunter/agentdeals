import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const directory = fs.mkdtempSync(path.join(os.tmpdir(), "agentdeals-identity-"));
const dataDirectory = fileURLToPath(new URL("../data/", import.meta.url));
const stores = {
  agents: ["agents.json", "AGENTDEALS_AGENTS_PATH"],
  codes: ["referral_codes.json", "AGENTDEALS_REFERRAL_CODES_PATH"],
  ledger: ["ledger_entries.json", "AGENTDEALS_LEDGER_PATH"],
  balances: ["agent_balances.json", "AGENTDEALS_BALANCES_PATH"],
  requests: ["referral_requests.json", "AGENTDEALS_REFERRAL_REQUESTS_PATH"],
  friends: ["agent_friends.json", "AGENTDEALS_FRIENDS_PATH"],
  clawback: ["vendor_clawback.json", "AGENTDEALS_CLAWBACK_CONFIG_PATH"],
} as const;

export const identityPaths = Object.fromEntries(
  Object.entries(stores).map(([name, [filename, variable]]) => {
    const destination = path.join(directory, filename);
    const original = path.join(dataDirectory, filename);
    if (fs.existsSync(original)) fs.copyFileSync(original, destination);
    process.env[variable] = destination;
    return [name, destination];
  }),
) as Record<keyof typeof stores, string>;

process.once("exit", () => fs.rmSync(directory, { recursive: true, force: true }));
