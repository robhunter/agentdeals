import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const { getGuideList } = await import("../dist/guides.js");
const { latestPricingChangesText } = await import("../dist/upcoming-changes.js");

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const WHOLE_LOG = "2020-01-01";
const THE_ROUTE_DEFAULT_PAGE = 20;
const COPIES_PAST_THE_DEFAULT_PAGE = THE_ROUTE_DEFAULT_PAGE + 1;

type Change = { vendor: string; date: string; change_type: string; summary: string; resolution?: { state?: string } | null; previous_state?: string; current_state?: string };
type Listed = { uri: string; name: string; description?: string };

const catalogue = JSON.parse(readFileSync(path.join(REPO, "data", "index.json"), "utf-8"));
const changeLog: Change[] = JSON.parse(readFileSync(path.join(REPO, "data", "deal_changes.json"), "utf-8")).changes;

const slugOf = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/-+$/, "");
const listedVendors = new Set<string>(catalogue.offers.map((offer: { vendor: string }) => offer.vendor));
const servedByDefault = (change: Change) => change.resolution?.state !== "retracted" && change.current_state !== "Removed from index";

const ownRecordsOf = (vendor: string) => changeLog.filter(change => change.vendor === vendor && servedByDefault(change));
const vendorWithTheMostRecords = [...listedVendors].sort((a, b) => ownRecordsOf(b).length - ownRecordsOf(a).length || a.localeCompare(b))[0]!;
const copied = ownRecordsOf(vendorWithTheMostRecords)[0]!;
const copies: Change[] = Array.from({ length: COPIES_PAST_THE_DEFAULT_PAGE }, (_, index) => ({
  ...copied,
  date: `2021-01-${String(index + 1).padStart(2, "0")}`,
  summary: `${copied.summary} (copy ${index + 1})`,
}));

const dir = mkdtempSync(path.join(tmpdir(), "stdio-resources-read-every-record-"));
const scratchChanges = path.join(dir, "deal_changes.json");
writeFileSync(scratchChanges, JSON.stringify({ changes: [...changeLog, ...copies] }));

function startApi(): Promise<{ proc: ChildProcess; base: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn("node", [path.join(REPO, "dist", "serve.js")], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, PORT: "0", BASE_URL: "http://localhost", TZ: "UTC", AGENTDEALS_CHANGES_PATH: scratchChanges },
    });
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("server startup timeout")); }, 60000);
    child.stderr!.on("data", (buffer: Buffer) => {
      const found = buffer.toString().match(/running on http:\/\/localhost:(\d+)/);
      if (found) { clearTimeout(timer); resolve({ proc: child, base: `http://localhost:${found[1]}` }); }
    });
    child.on("error", (err) => { clearTimeout(timer); reject(err); });
  });
}

function askTheStdioPackage(base: string, requests: Array<{ method: string; params: unknown }>): Promise<unknown[]> {
  const child = spawn("node", [path.join(REPO, "dist", "index.js")], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, AGENTDEALS_API_URL: base },
  });
  const answers = new Map<number, unknown>();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(new Error("stdio MCP timeout")); }, 120000);
    let buffer = "";
    child.stdout!.on("data", (chunk: Buffer) => {
      buffer += chunk.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        let payload: { id?: number; result?: unknown };
        try { payload = JSON.parse(line); } catch { continue; }
        if (typeof payload.id !== "number" || payload.id < 2) continue;
        answers.set(payload.id, payload.result);
        if (answers.size === requests.length) {
          clearTimeout(timer);
          child.kill();
          resolve(requests.map((_, index) => answers.get(index + 2)));
        }
      }
    });
    child.on("error", (err) => { clearTimeout(timer); reject(err); });
    child.stdin!.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "stdio-resources-read-every-record", version: "1" } } })}\n`);
    child.stdin!.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
    requests.forEach((request, index) => child.stdin!.write(`${JSON.stringify({ jsonrpc: "2.0", id: index + 2, ...request })}\n`));
  });
}

async function readThroughTheStdioPackage(base: string, uris: string[]): Promise<Map<string, string>> {
  const answers = await askTheStdioPackage(base, uris.map(uri => ({ method: "resources/read", params: { uri } })));
  return new Map(uris.map((uri, index) => [uri, (answers[index] as { contents?: Array<{ text?: string }> } | undefined)?.contents?.[0]?.text ?? ""]));
}

async function everyRecordTheApiServes(base: string, query: string): Promise<{ changes: Change[]; index_housekeeping_excluded: number }> {
  const { total } = await (await fetch(`${base}/api/changes?since=${WHOLE_LOG}&limit=0${query}`)).json() as { total: number };
  return await (await fetch(`${base}/api/changes?since=${WHOLE_LOG}&limit=${total}${query}`)).json() as { changes: Change[]; index_housekeeping_excluded: number };
}

const sectionOf = (text: string, heading: string): string[] => {
  const after = text.split(`\n## ${heading}\n\n`)[1];
  return after === undefined ? [] : after.split("\n## ")[0]!.split("\n").filter(line => line.startsWith("- **"));
};

describe("the stdio package's resources read every record they describe", () => {
  let api: { proc: ChildProcess; base: string };

  before(async () => {
    api = await startApi();
  });

  after(() => api?.proc.kill());

  it("reads every category it lists under that category's own name, with the count it lists", async () => {
    const [listed] = await askTheStdioPackage(api.base, [{ method: "resources/list", params: {} }]) as Array<{ resources: Listed[] }>;
    const categories = listed!.resources.filter(resource => resource.uri.startsWith("agentdeals://category/"));
    const { categories: held } = await (await fetch(`${api.base}/api/categories`)).json() as { categories: Array<{ name: string; count: number }> };
    assert.deepStrictEqual(categories.map(resource => resource.name).sort(), held.map(category => category.name).sort());
    assert.ok(
      held.some(category => slugOf(category.name) !== category.name.toLowerCase()),
      "every category's slug is its lowercased name, so a slug passed as a name would still resolve",
    );
    const read = await readThroughTheStdioPackage(api.base, categories.map(resource => resource.uri));
    const wrong = held
      .filter(category => !read.get(`agentdeals://category/${slugOf(category.name)}`)!.startsWith(`# ${category.name}\n\n${category.count} offers.\n`))
      .map(category => `${category.name}: ${read.get(`agentdeals://category/${slugOf(category.name)}`)!.split("\n")[0]}`);
    assert.deepStrictEqual(wrong, []);
  });

  it("lists every record the API holds on the changes resource, housekeeping included, and says how many", async () => {
    const withHousekeeping = await everyRecordTheApiServes(api.base, "&include_index_housekeeping=true");
    const byDefault = await everyRecordTheApiServes(api.base, "");
    assert.ok(byDefault.index_housekeeping_excluded > 0, "the log holds no index housekeeping, so leaving it out would go unseen");
    assert.ok(withHousekeeping.changes.length > THE_ROUTE_DEFAULT_PAGE, "the log fits on the route's default page, so reading one page would go unseen");
    const text = (await readThroughTheStdioPackage(api.base, ["agentdeals://changes"])).get("agentdeals://changes")!;
    const stated = text.match(/This list holds (\d+) entries/);
    assert.ok(stated, `the changes resource does not say how many entries it holds: ${text.slice(0, 300)}`);
    const listed = text.split("\n").filter(line => line.startsWith("- **"));
    assert.strictEqual(Number(stated[1]), listed.length);
    assert.deepStrictEqual(
      listed,
      withHousekeeping.changes.map(change => `- **${change.date}** | ${change.vendor} | ${change.change_type} | ${change.summary}`),
    );
  });

  it("builds changes/latest from every record the API holds, not only the newest page", async () => {
    const { changes } = await everyRecordTheApiServes(api.base, "");
    const entry = (change: Change) => `- **${change.date}** | ${change.vendor} [${change.change_type}]\n  ${change.summary}\n  Previous: ${change.previous_state}\n  Current: ${change.current_state}`;
    assert.notStrictEqual(
      latestPricingChangesText(changes.slice(0, THE_ROUTE_DEFAULT_PAGE), entry),
      latestPricingChangesText(changes, entry),
      "the newest page alone gives the same text, so reading one page would go unseen",
    );
    const text = (await readThroughTheStdioPackage(api.base, ["agentdeals://changes/latest"])).get("agentdeals://changes/latest")!;
    assert.strictEqual(text, latestPricingChangesText(changes, entry));
  });

  it("lists on a vendor's resource every change the API holds for that vendor, and none of another vendor's", async () => {
    const { changes } = await everyRecordTheApiServes(api.base, "");
    const vendorsAnotherNameContains = [...listedVendors].filter(vendor =>
      changes.some(change => change.vendor !== vendor && change.vendor.toLowerCase().includes(vendor.toLowerCase())),
    );
    assert.ok(vendorsAnotherNameContains.length > 0, "no vendor's name sits inside another's, so a name match would read only the vendor's own records");
    const vendors = [vendorWithTheMostRecords, ...vendorsAnotherNameContains.filter(vendor => vendor !== vendorWithTheMostRecords)];
    const read = await readThroughTheStdioPackage(api.base, vendors.map(vendor => `agentdeals://vendor/${slugOf(vendor)}`));
    const own = (vendor: string) => changes.filter(change => change.vendor.toLowerCase() === vendor.toLowerCase());
    assert.ok(own(vendorWithTheMostRecords).length > THE_ROUTE_DEFAULT_PAGE, `${vendorWithTheMostRecords} fits on the route's default page`);
    const wrong = vendors
      .map(vendor => ({
        vendor,
        listed: sectionOf(read.get(`agentdeals://vendor/${slugOf(vendor)}`)!, "Pricing Changes"),
        held: own(vendor).map(change => `- **${change.date}** [${change.change_type}] ${change.summary}`),
      }))
      .filter(({ listed, held }) => JSON.stringify(listed) !== JSON.stringify(held))
      .map(({ vendor, listed, held }) => `${vendor}: lists ${listed.length}, holds ${held.length}`);
    assert.deepStrictEqual(wrong, []);
  });

  it("draws a guide's related changes from every record, not only the newest page", async () => {
    const { changes } = await everyRecordTheApiServes(api.base, "");
    const newestPage = changes.slice(0, THE_ROUTE_DEFAULT_PAGE);
    const vendorSlug = (change: Change) => change.vendor.toLowerCase().replace(/[^a-z0-9]+/g, "-");
    const guidesNamingAVendor = (getGuideList() as Array<{ slug: string }>)
      .filter(guide => guide.slug.endsWith("-alternatives"))
      .filter(guide => changes.some(change => vendorSlug(change) === guide.slug.replace(/-alternatives$/, "")));
    const outsideTheNewestPage = guidesNamingAVendor.filter(guide =>
      !newestPage.some(change => vendorSlug(change) === guide.slug.replace(/-alternatives$/, "")),
    );
    assert.ok(outsideTheNewestPage.length > 0, "every guide's vendor has a record on the newest page, so reading one page would go unseen");
    const read = await readThroughTheStdioPackage(api.base, guidesNamingAVendor.map(guide => `agentdeals://guide/${guide.slug}`));
    const served = new Set(changes.map(change => `- **${change.date}** | ${change.vendor} [${change.change_type}] ${change.summary}`));
    const missing = guidesNamingAVendor
      .filter(guide => sectionOf(read.get(`agentdeals://guide/${guide.slug}`)!, "Related Pricing Changes").length === 0)
      .map(guide => guide.slug);
    assert.deepStrictEqual(missing, []);
    const unknown = guidesNamingAVendor.flatMap(guide =>
      sectionOf(read.get(`agentdeals://guide/${guide.slug}`)!, "Related Pricing Changes")
        .filter(line => !served.has(line))
        .map(line => `${guide.slug}: ${line}`),
    );
    assert.deepStrictEqual(unknown, []);
  });
});
