import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HELP = `End-to-end check for the change-log writer.

Runs the real reverify-rolling CLI in --ai mode against a stub Anthropic endpoint
and stub vendor pages, then reads what landed on disk. Covers what unit tests
cannot: that the CLI itself writes a detected change to the change log, that a
record whose terms moved keeps its stale verification date, that a second run over
the same record does not write the entry twice, and that the staleness alarm exits
non-zero on a log that has stopped growing.

Usage: node scripts/e2e-1074.mjs
`;

if (process.argv.includes("--help") || process.argv.includes("-h")) {
  console.log(HELP);
  process.exit(0);
}

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const work = mkdtempSync(join(tmpdir(), "e2e-1074-"));
const indexPath = join(work, "index.json");
const changesPath = join(work, "deal_changes.json");

let checks = 0;
let failures = 0;
function check(label, condition, detail = "") {
  checks++;
  if (condition) {
    console.log(`  ✓ ${label}`);
  } else {
    failures++;
    console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

const PAGE_TEXT = {
  moved: "Examplebase pricing. The Starter plan is a 14 day trial of 500 MB. After the trial it is 19 dollars per month. Effective 1 August 2026.",
  same: "Steadybase pricing. The free plan gives 1 GB of storage every month with no time limit and no card required.",
  vague: "Vaguebase pricing. Plans and limits are listed in the console after you sign in. Contact sales for details.",
};

const pages = createServer((req, res) => {
  const key = req.url.replace("/", "");
  const text = PAGE_TEXT[key];
  if (!text) {
    res.writeHead(404, { "Content-Type": "text/html" });
    res.end("<html><body>not found</body></html>");
    return;
  }
  res.writeHead(200, { "Content-Type": "text/html" });
  res.end(`<html><head><title>Pricing</title></head><body><main>${text}</main></body></html>`);
});

const REPLIES = {
  Examplebase: {
    status: "changed",
    summary: "The free 500 MB plan is now a 14-day trial that converts to $19/month",
    change_type: "free_tier_removed",
    current_state: "500 MB for 14 days, then $19 per month",
    impact: "high",
    effective_date: "2026-08-01",
  },
  Steadybase: { status: "confirmed" },
  Vaguebase: { status: "changed", summary: "something about the plans looks different" },
};

let modelCalls = 0;
const anthropic = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    modelCalls++;
    const parsed = JSON.parse(body || "{}");
    const prompt = parsed.messages?.[0]?.content ?? "";
    const vendor = Object.keys(REPLIES).find((v) => prompt.includes(`Vendor: ${v}`));
    const reply = REPLIES[vendor] ?? { status: "unclear", summary: "no stub for this vendor" };
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      id: "msg_stub",
      type: "message",
      role: "assistant",
      model: parsed.model,
      content: [{ type: "text", text: JSON.stringify(reply) }],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 100, output_tokens: 60 },
    }));
  });
});

function listen(server) {
  return new Promise((r) => server.listen(0, "127.0.0.1", () => r(server.address().port)));
}

function run(script, args, env) {
  return new Promise((r) => {
    const child = spawn("node", [join(ROOT, "scripts", script), ...args], {
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    child.on("close", (code) => r({ code, out }));
  });
}

const pagesPort = await listen(pages);
const anthropicPort = await listen(anthropic);

const offers = [
  {
    vendor: "Examplebase", category: "Databases", tier: "Free",
    description: "500 MB storage and 2 GB egress per month, free forever",
    url: `http://127.0.0.1:${pagesPort}/moved`, tags: ["database"], verifiedDate: "2026-01-01",
  },
  {
    vendor: "Steadybase", category: "Databases", tier: "Free",
    description: "1 GB of storage per month with no time limit",
    url: `http://127.0.0.1:${pagesPort}/same`, tags: ["database"], verifiedDate: "2026-01-02",
  },
  {
    vendor: "Vaguebase", category: "Databases", tier: "Free",
    description: "A free plan with unspecified limits",
    url: `http://127.0.0.1:${pagesPort}/vague`, tags: ["database"], verifiedDate: "2026-01-03",
  },
];

writeFileSync(indexPath, JSON.stringify({ offers }, null, 2) + "\n");
writeFileSync(changesPath, JSON.stringify({ changes: [] }, null, 2) + "\n");

const env = {
  AGENTDEALS_INDEX_PATH: indexPath,
  AGENTDEALS_CHANGES_PATH: changesPath,
  ANTHROPIC_API_KEY: "stub-key-not-a-real-credential",
  ANTHROPIC_BASE_URL: `http://127.0.0.1:${anthropicPort}`,
};

console.log("── Run 1: AI mode over three records ──");
const first = await run("reverify-rolling.js", ["--ai", "--limit", "3"], env);
console.log(first.out.split("\n").map((l) => `    ${l}`).join("\n"));

check("the CLI exited cleanly", first.code === 0, `exit ${first.code}`);
check("the stub model was asked about every record", modelCalls === 3, `${modelCalls} calls`);

let log = JSON.parse(readFileSync(changesPath, "utf-8"));
check("the detected change was written to the log", log.changes.length === 1, `${log.changes.length} entries`);

const written = log.changes[0] ?? {};
check("the entry names the vendor whose terms moved", written.vendor === "Examplebase", written.vendor);
check("the entry carries the change type the reading produced", written.change_type === "free_tier_removed", written.change_type);
check("the entry's current state came from the page, not from our record", written.current_state === "500 MB for 14 days, then $19 per month", written.current_state);
check("the entry's previous state is what we had published", written.previous_state === offers[0].description, written.previous_state);
check("the entry is marked as machine-written", written.detected_by === "reverify-ai", written.detected_by);
check("the entry says when it was recorded", /^\d{4}-\d{2}-\d{2}$/.test(written.recorded_date ?? ""), written.recorded_date);
check("the entry dates the change from the page", written.date === "2026-08-01", written.date);
check("the entry cites the page that was read", written.source_url === offers[0].url, written.source_url);

let index = JSON.parse(readFileSync(indexPath, "utf-8"));
const byVendor = Object.fromEntries(index.offers.map((o) => [o.vendor, o]));
check("the record whose terms moved keeps its stale verification date", byVendor.Examplebase.verifiedDate === "2026-01-01", byVendor.Examplebase.verifiedDate);
check("the record the reading confirmed was stamped fresh", byVendor.Steadybase.verifiedDate !== "2026-01-02", byVendor.Steadybase.verifiedDate);
check("the record we could not classify keeps its stale verification date", byVendor.Vaguebase.verifiedDate === "2026-01-03", byVendor.Vaguebase.verifiedDate);
check("no entry was written for the detection we could not classify", !log.changes.some((c) => c.vendor === "Vaguebase"));
check("the run said a detection was dropped rather than dropping it silently", /Vaguebase — change detected but not recordable/.test(first.out));
check("the run reported what it recorded", /Recorded to data\/deal_changes.json: 1/.test(first.out));

console.log("");
console.log("── Run 2: the same records come round again ──");
const second = await run("reverify-rolling.js", ["--ai", "--limit", "3"], env);
console.log(second.out.split("\n").map((l) => `    ${l}`).join("\n"));

log = JSON.parse(readFileSync(changesPath, "utf-8"));
check("the second run exited cleanly", second.code === 0, `exit ${second.code}`);
check("the change was not written a second time", log.changes.length === 1, `${log.changes.length} entries`);
check("the second run said why it wrote nothing", /not recorded: /.test(second.out));

console.log("");
console.log("── URL mode over the same records ──");
const urlRun = await run("reverify-rolling.js", ["--limit", "3"], env);
log = JSON.parse(readFileSync(changesPath, "utf-8"));
check("URL mode exited cleanly", urlRun.code === 0, `exit ${urlRun.code}`);
check("URL mode wrote nothing to the change log", log.changes.length === 1, `${log.changes.length} entries`);
check("URL mode states that it cannot detect a change", /URL mode compares nothing and cannot report a change/.test(urlRun.out));
index = JSON.parse(readFileSync(indexPath, "utf-8"));
const afterUrl = Object.fromEntries(index.offers.map((o) => [o.vendor, o]));
check("URL mode re-stamps the record whose terms moved, undoing the date AI mode withheld", afterUrl.Examplebase.verifiedDate !== "2026-01-01", afterUrl.Examplebase.verifiedDate);
console.log("    ^ this check passing is the collision, not the fix: the daily URL job restores a fresh");
console.log("      verifiedDate on a record a reading found to be wrong. Withholding the stamp only holds");
console.log("      if the record carries a flag the URL job also respects.");

console.log("");
console.log("── The staleness alarm ──");
const fresh = await run("check-change-log-staleness.js", [], { AGENTDEALS_CHANGES_PATH: changesPath });
check("a log written today passes", fresh.code === 0, `exit ${fresh.code}`);
check("the alarm reports the machine-written total", /Machine-detected entries: 1/.test(fresh.out), fresh.out.trim());

const stalePath = join(work, "stale_changes.json");
writeFileSync(stalePath, JSON.stringify({
  changes: [{ vendor: "Old", change_type: "restriction", date: "2026-04-21", recorded_date: "2026-04-21" }],
}, null, 2) + "\n");
const stale = await run("check-change-log-staleness.js", [], { AGENTDEALS_CHANGES_PATH: stalePath });
check("a log that stopped growing fails the job", stale.code === 1, `exit ${stale.code}`);
check("the failure names the number that was invisible", /Days since last change recorded: \d+/.test(stale.out));
check("the failure says the daily job cannot clear it", /URL mode, which cannot detect a change/.test(stale.out));

const unmeasurablePath = join(work, "unmeasurable_changes.json");
writeFileSync(unmeasurablePath, JSON.stringify({
  changes: [{ vendor: "Old", change_type: "restriction", date: "2026-04-21" }],
}, null, 2) + "\n");
const unmeasurable = await run("check-change-log-staleness.js", [], { AGENTDEALS_CHANGES_PATH: unmeasurablePath });
check("a log whose age cannot be measured fails the job", unmeasurable.code === 1, `exit ${unmeasurable.code}`);

pages.close();
anthropic.close();
rmSync(work, { recursive: true, force: true });

console.log("");
console.log(`── ${checks - failures}/${checks} checks passed ──`);
process.exit(failures === 0 ? 0 : 1);
