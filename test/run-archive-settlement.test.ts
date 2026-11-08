import { describe, it } from "node:test";
import assert from "node:assert";
import { execFile, execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const { archiveSettlementSummary, originalCorrections, runArchiveSettlement } = await import("../scripts/run-archive-settlement.js");
const { writeSettledRecords } = await import("../scripts/write-settled-records.js");

type Change = Record<string, any>;
const record = (fields: Change = {}): Change => ({ vendor: "Example", date: "2026-09-25", recorded_date: "2026-09-25", change_type: "limits_reduced", date_source: "discovered", previous_state: "Free plan: 3 projects", current_state: "Free plan: 1 project", summary: "The free plan now allows 1 project.", source_url: "https://archive-cli.example/pricing", category: "Databases", ...fields });
const correction = (original: Change): Change => ({ ...original, change_type: "record_corrected", summary: "Our earlier description differed from the page.", archive_check: { outcome: "ours", checked: "2026-10-02", recorded_as: original.change_type } });

describe("the archive settlement and correction audit", () => {
  it("restores each correction's original record, refusing missing or ambiguous history before reading any page", async () => {
    const original = record();
    const current = correction(original);
    assert.deepStrictEqual(originalCorrections([current], [original]), [{ current, original }]);
    assert.throws(() => originalCorrections([current], []), /found 0/);
    assert.throws(() => originalCorrections([current], [original, { ...original, summary: "Another summary" }]), /found 2/);
    await assert.rejects(runArchiveSettlement({ changes: [current], originals: [], fetchToday: () => assert.fail("read before matching history") }), /found 0/);
  });

  it("settles the entire retry backlog serially, then audits corrections without sending them to the writer", async () => {
    const originals = [record({ vendor: "Correction" })];
    const current = correction(originals[0]);
    const changes = [record({ vendor: "Missing" }), record({ vendor: "Unsettled", archive_check: { outcome: "no_usable_capture", checked: "2026-10-02" } }), current, record({ vendor: "Settled", archive_check: { outcome: "vendor_changed" } })];
    const calls: string[] = [];
    let active = 0;
    const report = await runArchiveSettlement({
      changes, originals, offers: [], today: "2026-11-08", archive: {},
      fetchToday: async () => { assert.strictEqual(active++, 0); await Promise.resolve(); active--; return { ok: false, error: "HTTP 403" }; },
      onSettled: (result: Change) => calls.push(`${result.pass} ${result.vendor}`),
    });
    assert.deepStrictEqual(calls, ["unsettled Missing", "unsettled Unsettled", "audit Correction"]);
    assert.deepStrictEqual(report.results.map((result: Change) => result.vendor), ["Missing", "Unsettled"]);
    assert.strictEqual(report.audit.results[0].change_type, "limits_reduced");
    assert.strictEqual(report.audit.results[0].previous_archive_check, current.archive_check);
    assert.strictEqual(report.audit.results[0].verdict_changed, true);
    const written = writeSettledRecords(changes, [report]);
    assert.strictEqual(written.changes[2], current);
    assert.strictEqual(written.changes[1], changes[1]);
    const summary = archiveSettlementSummary(report);
    for (const vendor of ["Missing", "Unsettled", "Correction"]) assert.ok(summary.includes(`| ${vendor} |`));
    assert.match(summary, /1 verdicts differ/);
    assert.match(summary, /Audit results are not written/);
  });

  it("keeps every record's outcome readable in Markdown even when its words contain table separators", () => {
    const summary = archiveSettlementSummary({ results: [{ vendor: "A|B\nC", date: "2026-09-25", change_type: "limits_reduced", outcome: "no_usable_capture", why: "one|two" }], audit: null });
    assert.ok(summary.includes("| A\\|B C |"));
    assert.ok(summary.includes("one\\|two"));
    assert.doesNotMatch(summary, /Existing corrections/);
  });
});

describe("the serial archive settlement command", () => {
  it("uses actual HTTP archive and model responses, reports the earlier value, and leaves catalogue bytes unchanged", { timeout: 60000 }, async () => {
    const scratch = mkdtempSync(path.join(tmpdir(), "archive-settlement-cli-"));
    const script = fileURLToPath(new URL("../scripts/run-archive-settlement.js", import.meta.url));
    const filler = "Pricing, plan limits and other features. ".repeat(30);
    const original = record();
    const stored = { ...original, archive_check: { outcome: "no_usable_capture", checked: "2026-10-02" } };
    const requests: string[] = [];
    const server = createServer(async (request, response) => {
      const url = new URL(request.url!, "http://localhost");
      requests.push(`${request.method} ${url.pathname}`);
      if (url.pathname === "/chat/completions") {
        let body = "";
        for await (const part of request) body += part;
        const prompt = JSON.parse(body).messages[0].content;
        const answer = prompt.includes('"previous_values"')
          ? { previous_values: [{ previous: original.previous_state, current: original.current_state, old_page: original.previous_state }] }
          : prompt.includes('"changes"')
            ? { changes: [{ record: "now allows 1 project", old_page: original.current_state }] }
            : { old_terms: [original.current_state], new_terms: [original.current_state], same: true, differences: [] };
        response.setHeader("Content-Type", "application/json");
        response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(answer) } }] }));
      } else if (url.pathname === "/cdx/search/cdx") {
        response.end(JSON.stringify([["timestamp", "original", "statuscode", "mimetype"], ...["20260101120000", "20260917120000"].map((timestamp) => [timestamp, original.source_url, "200", "text/html"])]));
      } else {
        response.setHeader("Content-Type", "text/html");
        const terms = url.pathname.includes("20260101") ? original.previous_state : original.current_state;
        response.end(`<html><body><p>${terms} ${filler}</p></body></html>`);
      }
    });
    try {
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address() as { port: number };
      const base = `http://127.0.0.1:${address.port}`;
      mkdirSync(path.join(scratch, "data"));
      writeFileSync(path.join(scratch, "data/index.json"), JSON.stringify({ offers: [{ vendor: original.vendor, tier: "Free", category: original.category, description: original.previous_state }] }));
      writeFileSync(path.join(scratch, "data/deal_changes.json"), JSON.stringify({ changes: [original] }));
      const git = (...args: string[]) => execFileSync("git", ["-C", scratch, ...args], { encoding: "utf-8", env: { ...process.env, GIT_AUTHOR_DATE: "2026-09-20T00:00:00Z", GIT_COMMITTER_DATE: "2026-09-20T00:00:00Z" }, stdio: ["ignore", "pipe", "pipe"] });
      git("init", "-q"); git("config", "user.name", "Fixture"); git("config", "user.email", "fixture@example.com");
      git("add", "data"); git("commit", "-qm", "Initial data");
      const originalRef = git("rev-parse", "HEAD").trim();
      writeFileSync(path.join(scratch, "data/deal_changes.json"), JSON.stringify({ changes: [stored] }));
      git("add", "data"); git("commit", "-qm", "Archive check");
      const adapter = path.join(scratch, "local-fetch.mjs");
      writeFileSync(adapter, `const nativeFetch = globalThis.fetch; globalThis.fetch = (input, options) => { const url = new URL(input); return nativeFetch(new URL(url.pathname + url.search, ${JSON.stringify(base)}), options); };`);
      const out = path.join(scratch, "report.json");
      const before = readFileSync(path.join(scratch, "data/deal_changes.json"));
      const result = await promisify(execFile)(process.execPath, ["--import", adapter, script, "--out", out, "--audit-ours-from", originalRef], { cwd: scratch, env: { ...process.env, OPENROUTER_API_KEY: "local-fixture", OPENROUTER_BASE_URL: base }, timeout: 50000 });
      const report = JSON.parse(readFileSync(out, "utf-8"));
      assert.strictEqual(report.results[0].outcome, "no_usable_capture");
      assert.strictEqual(report.results[0].prior_capture.day, "2026-01-01");
      assert.deepStrictEqual(report.results[0].previous_values, [{ previous: original.previous_state, current: original.current_state, old: original.previous_state }]);
      assert.strictEqual(report.audit.results.length, 0);
      assert.strictEqual(readFileSync(`${out}.jsonl`, "utf-8").trim().split("\n").length, 1);
      assert.match(readFileSync(`${out}.md`, "utf-8"), /Example.*no_usable_capture/);
      assert.match(result.stdout, /unsettled: Example 2026-09-25 no_usable_capture/);
      assert.deepStrictEqual(readFileSync(path.join(scratch, "data/deal_changes.json")), before);
      assert.strictEqual(requests.filter((request) => request === "POST /chat/completions").length, 3);
      assert.ok(requests.some((request) => request.includes("/web/20260101120000id_/")));
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      rmSync(scratch, { recursive: true, force: true });
    }
  });
});
