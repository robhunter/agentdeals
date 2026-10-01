import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const PAGE = "/auth-comparison-2026";
const RETIRED = "Stack Auth";
const SURVIVOR = "Hexclave";
const FILED_UNDER_RETIRED = "Synthetic change filed under the listing's retired name";
const FILED_UNDER_SURVIVOR = "Synthetic change filed under the listing's new name";

type Change = Record<string, unknown> & { vendor: string; date: string; summary: string };

function readJson(file: string) {
  return JSON.parse(readFileSync(path.join(REPO, "data", file), "utf8"));
}

function catalogueAfterTheRename() {
  const index = readJson("index.json");
  index.offers = index.offers.map((offer: { vendor: string }) => (offer.vendor === RETIRED ? { ...offer, vendor: SURVIVOR } : offer));
  return index;
}

function mergesAfterTheRename() {
  const merges = readJson("vendor_merges.json");
  if (!merges.merges.some((merge: { retired: string }) => merge.retired === RETIRED)) {
    merges.merges.push({ retired: RETIRED, survivor: SURVIVOR });
  }
  return merges;
}

function changesWithOneUnderEachName() {
  const log = readJson("deal_changes.json");
  const changes: Change[] = log.changes;
  const template = changes.find((change) => change.vendor === "Clerk" && change.change_type === "limits_increased" && !change.resolution)
    ?? changes.find((change) => change.vendor === "Clerk" && !change.resolution)!;
  const latest = changes.map((change) => change.date).filter((date) => /^\d{4}-\d{2}-\d{2}$/.test(String(date))).sort().at(-1)!;
  const filed = (vendor: string, summary: string): Change => ({ ...template, vendor, summary, date: latest, recorded_date: latest });
  log.changes = [filed(RETIRED, FILED_UNDER_RETIRED), filed(SURVIVOR, FILED_UNDER_SURVIVOR), ...changes];
  return log;
}

function startServer(env: NodeJS.ProcessEnv): Promise<{ proc: ChildProcess; port: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn("node", [path.join(REPO, "dist", "serve.js")], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, PORT: "0", BASE_URL: "http://localhost:3000", ...env },
    });
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error("Server startup timeout"));
    }, 40000);
    child.stderr!.on("data", (data: Buffer) => {
      const m = data.toString().match(/running on http:\/\/localhost:(\d+)/);
      if (m) {
        clearTimeout(timeout);
        resolve({ proc: child, port: parseInt(m[1], 10) });
      }
    });
    child.on("error", (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });
}

function timelineRows(html: string): string[][] {
  const table = [...html.matchAll(/<table[^>]*>[\s\S]*?<\/table>/g)].map(([t]) => t).find((t) => t.includes("<th>Impact</th>"));
  assert.ok(table, "the page has a timeline headed Impact");
  return [...table.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)]
    .map(([, row]) => [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map(([, cell]) => cell.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim()))
    .filter((cells) => cells.length >= 3);
}

describe("the auth comparison's timeline after a tabulated listing is renamed", () => {
  let server: { proc: ChildProcess; port: number };
  let dir = "";
  let html = "";

  before(async () => {
    dir = mkdtempSync(path.join(tmpdir(), "auth-renamed-listing-"));
    const write = (file: string, value: unknown) => {
      writeFileSync(path.join(dir, file), JSON.stringify(value));
      return path.join(dir, file);
    };
    server = await startServer({
      AGENTDEALS_INDEX_PATH: write("index.json", catalogueAfterTheRename()),
      AGENTDEALS_MERGES_PATH: write("vendor_merges.json", mergesAfterTheRename()),
      AGENTDEALS_CHANGES_PATH: write("deal_changes.json", changesWithOneUnderEachName()),
    });
    html = await (await fetch(`http://localhost:${server.port}${PAGE}`)).text();
  });

  after(() => {
    server?.proc.kill();
    rmSync(dir, { recursive: true, force: true });
  });

  it("keeps the records filed under either name", () => {
    const summaries = timelineRows(html).map((cells) => cells[2]);
    assert.deepStrictEqual([FILED_UNDER_RETIRED, FILED_UNDER_SURVIVOR].filter((summary) => !summaries.some((cell) => cell.includes(summary))), []);
  });

  it("names the listing as the catalogue now publishes it", () => {
    const vendors = timelineRows(html).filter((cells) => cells[2].startsWith("Synthetic change")).map((cells) => cells[1]);
    assert.deepStrictEqual(vendors, [SURVIVOR, SURVIVOR]);
  });
});
