import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRATCH = mkdtempSync(path.join(tmpdir(), "change-proposals-"));
const NO_CONFIRMATIONS = path.join(SCRATCH, "verification_state.json");
writeFileSync(NO_CONFIRMATIONS, JSON.stringify({ records: [] }, null, 2) + "\n");
process.env.AGENTDEALS_VERIFICATION_STATE_PATH = NO_CONFIRMATIONS;

const {
  DROPPED_KEPT_DAYS,
  READING_DROPS_A_FIGURE_OUR_SOURCE_CHECK_FOUND,
  confirmProposals,
  dropProposals,
  droppedStillKept,
  proposalId,
  proposalLine,
  proposalsBeside,
  proposeChangeEntries,
  readProposals,
  recordAsWritten,
} = await import("../scripts/change-proposals.js");
const { runAiMode, summaryLines } = await import("../scripts/reverify-rolling.js");
const { changeLogFreshness, SUPPRESSED_WITHIN_REPICK_WINDOW } = await import("../scripts/change-log.js");
const { report, DEFAULT_THRESHOLD_DAYS, proposalsAtRef, recordsTheDetectorProposed } = await import(
  "../scripts/check-change-log-staleness.js"
);

type Listing = Record<string, any> & { vendor: string; url: string; description: string };
type Record_ = Record<string, any> & { vendor: string; change_type: string; recorded_date: string };

const THE_RUN: { records: Record_[]; listings: Listing[] } = JSON.parse(
  readFileSync(path.join(REPO, "test", "reread-of-2026-10-07.json"), "utf-8"),
);
const RUN_DAY = new Date("2026-10-07T06:30:00Z");
const WINDOW = 22;

const recordOf = (vendor: string) => THE_RUN.records.find((r) => r.vendor === vendor)!;

function writeJson(file: string, doc: unknown): string {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(doc, null, 2) + "\n");
  return file;
}

function readJson(file: string): any {
  return JSON.parse(readFileSync(file, "utf-8"));
}

function isOneOfTheRun(change: Record_): boolean {
  return THE_RUN.records.some(
    (r) => r.vendor === change.vendor && r.change_type === change.change_type && change.recorded_date === r.recorded_date && change.detected_by === r.detected_by,
  );
}

function logBeforeTheRun(): { changes: Record_[] } {
  const shipped = readJson(path.join(REPO, "data", "deal_changes.json"));
  return { ...shipped, changes: shipped.changes.filter((c: Record_) => !isOneOfTheRun(c)) };
}

function indexBeforeTheRun(): { offers: Listing[] } {
  const shipped = readJson(path.join(REPO, "data", "index.json"));
  const offers: Listing[] = shipped.offers.filter((o: Listing) => !THE_RUN.listings.some((l) => l.vendor === o.vendor));
  for (const listing of THE_RUN.listings) {
    const live = (shipped.offers as Listing[]).find((o) => o.vendor === listing.vendor) ?? {};
    const { restated_from: _restated, restatement_reverted: _reverted, ...rest } = live as Listing;
    offers.push({ ...rest, ...listing });
  }
  return { ...shipped, offers };
}

function stores(name: string, changes: Record_[]) {
  const dir = path.join(SCRATCH, name);
  const paths = {
    dir,
    changesPath: writeJson(path.join(dir, "deal_changes.json"), { ...logBeforeTheRun(), changes }),
    indexPath: writeJson(path.join(dir, "index.json"), indexBeforeTheRun()),
    restatedPath: path.join(dir, "restated_terms.json"),
    corroborationPath: writeJson(path.join(dir, "change_corroboration.json"), { held: [], resolved: [] }),
    proposalsPath: path.join(dir, "change_proposals.json"),
  };
  cpSync(path.join(REPO, "data", "restated_terms.json"), paths.restatedPath);
  return paths;
}

type Stores = ReturnType<typeof stores>;

function envFor(paths: Stores): Record<string, string> {
  return {
    AGENTDEALS_CHANGES_PATH: paths.changesPath,
    AGENTDEALS_INDEX_PATH: paths.indexPath,
    AGENTDEALS_RESTATED_PATH: paths.restatedPath,
    AGENTDEALS_CORROBORATION_PATH: paths.corroborationPath,
    AGENTDEALS_PROPOSALS_PATH: paths.proposalsPath,
    AGENTDEALS_VERIFICATION_STATE_PATH: NO_CONFIRMATIONS,
  };
}

function runScript(script: string, args: string[], paths: Stores) {
  return spawnSync("node", [path.join(REPO, "scripts", script), ...args], {
    cwd: REPO,
    encoding: "utf-8",
    env: { ...process.env, TZ: "UTC", ...envFor(paths) },
  });
}

function serve(env: Record<string, string>): Promise<{ child: ChildProcess; port: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn("node", [path.join(REPO, "dist", "serve.js")], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, PORT: "0", BASE_URL: "http://localhost", TZ: "UTC", ...env },
    });
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error("Server startup timeout"));
    }, 60000);
    child.stderr!.on("data", (data: Buffer) => {
      const m = data.toString().match(/running on http:\/\/localhost:(\d+)/);
      if (m) {
        clearTimeout(timeout);
        resolve({ child, port: parseInt(m[1], 10) });
      }
    });
    child.on("error", (e) => {
      clearTimeout(timeout);
      reject(e);
    });
  });
}

after(() => rmSync(SCRATCH, { recursive: true, force: true }));

const A_WIDENING = {
  vendor: "Widebase",
  change_type: "limits_increased",
  date: "2026-10-07",
  date_source: "discovered",
  summary: "The free plan rises from 1 GB to 5 GB of storage.",
  previous_state: "Free plan: 1 GB of storage",
  current_state: "Free plan: 5 GB of storage",
  impact: "medium",
  source_url: "https://widebase.example/pricing",
  category: "Storage",
  alternatives: [],
  detected_by: "reverify-ai",
  recorded_date: "2026-10-07",
};

function emptyStores(name: string) {
  const dir = path.join(SCRATCH, name);
  return {
    dir,
    changesPath: writeJson(path.join(dir, "deal_changes.json"), { changes: [] }),
    refusalsPath: writeJson(path.join(dir, "change_refusals.json"), { refusals: [] }),
    corroborationPath: writeJson(path.join(dir, "change_corroboration.json"), { held: [], resolved: [] }),
  };
}

describe("#2497 AC-1: the re-read writes each new record to the proposals store", () => {
  const WIDEBASE = {
    vendor: "Widebase",
    category: "Storage",
    tier: "Free",
    description: A_WIDENING.previous_state,
    url: A_WIDENING.source_url,
    verifiedDate: "2026-08-01",
  };

  async function readWidebase(name: string, day = "2026-10-07") {
    const paths = emptyStores(name);
    const before = readFileSync(paths.changesPath, "utf-8");
    const result = await runAiMode([{ index: 0, offer: WIDEBASE }], { offers: [{ ...WIDEBASE }] }, false, new Date(`${day}T06:30:00Z`), {
      fetchFn: async () => ({ ok: true, text: "Widebase pricing. Free plan: 5 GB of storage for $0." }),
      verifyFn: async () => ({
        status: "changed",
        summary: A_WIDENING.summary,
        change_type: A_WIDENING.change_type,
        current_state: A_WIDENING.current_state,
        impact: "medium",
      }),
      confirmFn: async () => ({ verdict: "yes" }),
      rateLimitMs: 0,
      windowDays: WINDOW,
      ...paths,
    });
    return { paths, before, result };
  }

  it("proposes the record and leaves the change log byte for byte as it was", async () => {
    const { paths, before, result } = await readWidebase("ac1-run");
    assert.strictEqual(result.proposed.length, 1);
    assert.strictEqual(readFileSync(paths.changesPath, "utf-8"), before);
    const { proposals, dropped } = readProposals(proposalsBeside(paths.changesPath));
    assert.deepStrictEqual(dropped, []);
    assert.deepStrictEqual(
      proposals.map((p: Record_) => [p.proposal_id, p.proposed_on, p.vendor, p.change_type, p.recorded_date]),
      [["2026-10-07/widebase/limits_increased", "2026-10-07", "Widebase", "limits_increased", "2026-10-07"]],
    );
  });

  it("writes the record into the proposal exactly as the change log would have taken it", async () => {
    const { paths } = await readWidebase("ac1-shape");
    const [proposal] = readProposals(proposalsBeside(paths.changesPath)).proposals;
    assert.deepStrictEqual(Object.keys(recordAsWritten(proposal)), Object.keys(A_WIDENING));
    assert.strictEqual(proposal.previous_state, A_WIDENING.previous_state);
    assert.strictEqual(proposal.source_url, A_WIDENING.source_url);
  });

  it("is read by nothing the site serves: under src/ only the gate's hold-back registry names it, and no site module imports that", () => {
    const naming = (pattern: RegExp) => {
      const named: string[] = [];
      const walk = (dir: string) => {
        for (const entry of readdirSync(dir)) {
          const full = path.join(dir, entry);
          if (statSync(full).isDirectory()) walk(full);
          else if (pattern.test(readFileSync(full, "utf-8"))) named.push(path.relative(REPO, full));
        }
      };
      walk(path.join(REPO, "src"));
      return named;
    };
    assert.deepStrictEqual(naming(/change_proposals|change-proposals/), ["src/data-push-holdback.ts"]);
    assert.deepStrictEqual(naming(/data-push-holdback/), []);
  });

  it("ships an empty store, written the way a run writes it", () => {
    const shipped = readFileSync(path.join(REPO, "data", "change_proposals.json"), "utf-8");
    const parsed = JSON.parse(shipped);
    assert.ok(Array.isArray(parsed.proposals) && Array.isArray(parsed.dropped));
    assert.strictEqual(JSON.stringify(parsed, null, 2) + "\n", shipped);
  });

  it("is committed by the daily job, so a run's proposals reach main beside its other data", () => {
    const workflow = readFileSync(path.join(REPO, ".github", "workflows", "reverify.yml"), "utf-8");
    const gate = workflow.slice(workflow.indexOf("bash scripts/gate-data-push.sh"));
    assert.match(gate.slice(0, gate.indexOf("\n      - ")), /data\/change_proposals\.json/);
  });

  it("writes no proposal on a dry run", () => {
    const paths = emptyStores("ac1-dry");
    const { proposed } = proposeChangeEntries([A_WIDENING], { changesPath: paths.changesPath, windowDays: WINDOW, now: RUN_DAY, offers: [], dryRun: true });
    assert.strictEqual(proposed.length, 1);
    assert.ok(!existsSync(proposalsBeside(paths.changesPath)));
  });

  it("proposes into a store beside a scratch change log, never into the shipped one", async () => {
    const shipped = readFileSync(path.join(REPO, "data", "change_proposals.json"), "utf-8");
    const { paths } = await readWidebase("ac1-beside");
    assert.ok(existsSync(path.join(paths.dir, "change_proposals.json")));
    assert.strictEqual(readFileSync(path.join(REPO, "data", "change_proposals.json"), "utf-8"), shipped);
  });
});

describe("#2497 AC-4: a pending or dropped proposal holds its vendor and type off for one repick window", () => {
  const candidate = (recorded: string) => ({ ...A_WIDENING, date: recorded, recorded_date: recorded });

  function proposeOn(paths: { changesPath: string }, day: string) {
    return proposeChangeEntries([candidate(day)], { changesPath: paths.changesPath, windowDays: WINDOW, now: new Date(`${day}T06:30:00Z`), offers: [] });
  }

  it("holds the next day's reading of a pending proposal as within the window", () => {
    const paths = emptyStores("ac4-pending");
    assert.strictEqual(proposeOn(paths, "2026-10-07").proposed.length, 1);
    const next = proposeOn(paths, "2026-10-08");
    assert.deepStrictEqual(next.proposed, []);
    assert.deepStrictEqual(next.suppressed.map((s: { reason: string }) => s.reason), [SUPPRESSED_WITHIN_REPICK_WINDOW]);
  });

  it("holds a dropped claim off just as long, and proposes it again once the window has passed", () => {
    const paths = emptyStores("ac4-dropped");
    proposeOn(paths, "2026-10-07");
    const file = proposalsBeside(paths.changesPath);
    const store = readProposals(file);
    dropProposals(["2026-10-07/widebase/limits_increased"], store, "2026-10-07", "misread");
    writeJson(file, store);

    const lastDayHeld = new Date(Date.parse("2026-10-07") + (WINDOW - 1) * 86_400_000).toISOString().slice(0, 10);
    const firstDayFree = new Date(Date.parse("2026-10-07") + WINDOW * 86_400_000).toISOString().slice(0, 10);
    assert.deepStrictEqual(proposeOn(paths, lastDayHeld).proposed, []);
    assert.deepStrictEqual(proposeOn(paths, firstDayFree).proposed.map((p: Record_) => p.recorded_date), [firstDayFree]);
  });

  it("never turns a dropped claim into a refusal when the next run reads it again", async () => {
    const paths = emptyStores("ac4-no-refusal");
    const offer = { vendor: "Widebase", category: "Storage", tier: "Free", description: A_WIDENING.previous_state, url: A_WIDENING.source_url, verifiedDate: "2026-08-01" };
    const readOn = (day: string, changeType: string) =>
      runAiMode([{ index: 0, offer }], { offers: [{ ...offer }] }, false, new Date(`${day}T06:30:00Z`), {
        fetchFn: async () => ({ ok: true, text: "Widebase pricing. Free plan: 5 GB of storage for $0." }),
        verifyFn: async () => ({ status: "changed", summary: A_WIDENING.summary, change_type: changeType, current_state: A_WIDENING.current_state, impact: "medium" }),
        confirmFn: async () => ({ verdict: "yes" }),
        rateLimitMs: 0,
        windowDays: WINDOW,
        ...paths,
      });
    await readOn("2026-10-07", "limits_increased");
    const file = proposalsBeside(paths.changesPath);
    const store = readProposals(file);
    dropProposals(["2026-10-07/widebase/limits_increased"], store, "2026-10-07", "misread");
    writeJson(file, store);

    const regraded = await readOn("2026-10-08", "new_tier");
    assert.deepStrictEqual(readJson(paths.refusalsPath).refusals, [], "a dropped proposal was written down as a refusal");
    assert.deepStrictEqual(regraded.proposed.map((p: Record_) => p.change_type), ["new_tier"]);
  });
});

describe("#2497 unique ids", () => {
  it("names a proposal by its day, its vendor's page slug and its type", () => {
    assert.strictEqual(proposalId(recordOf("LLM7.io")), "2026-10-07/llm7-io/limits_reduced");
  });

  it("gives a second record with the same day, slug and type its own id", () => {
    const paths = emptyStores("ids");
    const twin = (vendor: string) => ({ ...A_WIDENING, vendor, source_url: `https://${vendor.replace(/\W/g, "")}.example/` });
    const { proposed } = proposeChangeEntries([twin("Wide Base"), twin("Wide-Base")], {
      changesPath: paths.changesPath,
      windowDays: WINDOW,
      now: RUN_DAY,
      offers: [],
    });
    assert.deepStrictEqual(proposed.map((p: Record_) => p.proposal_id), [
      "2026-10-07/wide-base/limits_increased",
      "2026-10-07/wide-base/limits_increased-2",
    ]);
  });

  it("proposes one record per vendor and type in a run, so two listings of one vendor cannot share an id", () => {
    const paths = emptyStores("ids-one-vendor");
    const { proposed, suppressed } = proposeChangeEntries(
      [A_WIDENING, { ...A_WIDENING, source_url: "https://widebase.example/teams", previous_state: "Teams: 10 GB" }],
      { changesPath: paths.changesPath, windowDays: WINDOW, now: RUN_DAY, offers: [] },
    );
    assert.strictEqual(proposed.length, 1);
    assert.deepStrictEqual(suppressed.map((s: { reason: string }) => s.reason), [SUPPRESSED_WITHIN_REPICK_WINDOW]);
  });
});

describe("#2497 AC-3: confirm and drop", () => {
  function proposedRun(name: string) {
    const paths = stores(name, logBeforeTheRun().changes);
    const index = readJson(paths.indexPath);
    proposeChangeEntries(THE_RUN.records, {
      changesPath: paths.changesPath,
      path: paths.proposalsPath,
      windowDays: WINDOW,
      now: RUN_DAY,
      offers: index.offers,
    });
    return paths;
  }

  it("moves a proposal into the change log as it stands in the file, edits and recorded_date included", () => {
    const paths = proposedRun("confirm-edited");
    const store = readProposals(paths.proposalsPath);
    const llm7 = store.proposals.find((p: Record_) => p.vendor === "LLM7.io");
    llm7.summary = "LLM7.io cut its free token to 100,000 tokens per 24 hours.";
    const log = readJson(paths.changesPath);
    const index = readJson(paths.indexPath);
    const { confirmed, unknown } = confirmProposals([llm7.proposal_id], { store, log, index }, "2026-10-09");
    assert.deepStrictEqual(unknown, []);
    assert.deepStrictEqual(log.changes.at(-1), { ...recordOf("LLM7.io"), summary: llm7.summary });
    assert.strictEqual(log.changes.at(-1).recorded_date, "2026-10-07");
    assert.strictEqual(confirmed.length, 1);
    assert.ok(!store.proposals.some((p: Record_) => p.vendor === "LLM7.io"));
  });

  it("applies the restatement the record makes, through the restate step's own code", () => {
    const paths = proposedRun("confirm-restates");
    const store = readProposals(paths.proposalsPath);
    const log = readJson(paths.changesPath);
    const index = readJson(paths.indexPath);
    const id = store.proposals.find((p: Record_) => p.vendor === "testingbot.com").proposal_id;
    const { confirmed } = confirmProposals([id], { store, log, index }, "2026-10-09");
    const listing = index.offers.find((o: Listing) => o.vendor === "testingbot.com");
    assert.strictEqual(listing.description, recordOf("testingbot.com").current_state);
    assert.strictEqual(listing.restated_from.record_date, "2026-10-07");
    assert.strictEqual(listing.restated_from.restated_on, "2026-10-09");
    assert.deepStrictEqual(confirmed[0].restated.map((e: Listing) => e.vendor), ["testingbot.com"]);
  });

  it("writes the restated listing and its ledger entry when the script confirms a record that restates one", () => {
    const paths = proposedRun("confirm-cli-restates");
    const ledger = readJson(paths.restatedPath).restatements.length;
    const run = runScript("change-proposals.js", ["confirm", "2026-10-07/testingbot-com/limits_reduced"], paths);
    assert.strictEqual(run.status, 0, run.stderr);
    assert.match(run.stdout, /Confirmed 2026-10-07\/testingbot-com\/limits_reduced: testingbot\.com \(limits_reduced\) is in data\/deal_changes\.json, recorded 2026-10-07\./);
    const listing = readJson(paths.indexPath).offers.find((o: Listing) => o.vendor === "testingbot.com");
    assert.strictEqual(listing.description, recordOf("testingbot.com").current_state);
    const added = readJson(paths.restatedPath).restatements.slice(ledger);
    assert.deepStrictEqual(added.map((e: Listing) => [e.vendor, e.record_date, e.description]), [
      ["testingbot.com", "2026-10-07", recordOf("testingbot.com").current_state],
    ]);
  });

  it("keeps a dropped proposal whole, with the day and the reason, and writes nothing to the change log", () => {
    const paths = proposedRun("drop-cli");
    const log = readFileSync(paths.changesPath, "utf-8");
    const run = runScript("change-proposals.js", ["drop", "2026-10-07/grafana-cloud/limits_reduced", "--reason", "the page still states 10k series"], paths);
    assert.strictEqual(run.status, 0, run.stderr);
    const { proposals, dropped } = readProposals(paths.proposalsPath);
    assert.ok(!proposals.some((p: Record_) => p.vendor === "Grafana Cloud"));
    assert.strictEqual(dropped.length, 1);
    assert.strictEqual(dropped[0].drop_reason, "the page still states 10k series");
    assert.match(dropped[0].dropped_on, /^\d{4}-\d{2}-\d{2}$/);
    assert.deepStrictEqual(recordAsWritten(dropped[0]), recordOf("Grafana Cloud"));
    assert.ok(Array.isArray(dropped[0].restatement), "the drop threw away the restatement the proposal carried");
    assert.strictEqual(readFileSync(paths.changesPath, "utf-8"), log);
  });

  it("refuses an id that is not pending and writes nothing", () => {
    const paths = proposedRun("unknown-id");
    const proposals = readFileSync(paths.proposalsPath, "utf-8");
    const log = readFileSync(paths.changesPath, "utf-8");
    for (const command of ["confirm", "drop"]) {
      const run = runScript("change-proposals.js", [command, "2026-10-07/llm7-io/limits_reduced", "2026-10-07/nobody/limits_reduced"], paths);
      assert.strictEqual(run.status, 2, `${command} accepted an id that is not pending`);
      assert.match(run.stderr, /2026-10-07\/nobody\/limits_reduced is not a pending proposal/);
      assert.strictEqual(readFileSync(paths.proposalsPath, "utf-8"), proposals);
      assert.strictEqual(readFileSync(paths.changesPath, "utf-8"), log);
    }
  });

  it("does not add a record the change log already holds", () => {
    const paths = proposedRun("duplicate");
    const store = readProposals(paths.proposalsPath);
    const log = readJson(paths.changesPath);
    log.changes.push(recordOf("LLM7.io"));
    const id = store.proposals.find((p: Record_) => p.vendor === "LLM7.io").proposal_id;
    const { confirmed, duplicates } = confirmProposals([id], { store, log, index: readJson(paths.indexPath) }, "2026-10-09");
    assert.deepStrictEqual([confirmed.length, duplicates], [0, [id]]);
    assert.strictEqual(log.changes.filter((c: Record_) => c.vendor === "LLM7.io" && c.recorded_date === "2026-10-07").length, 1);
  });

  it(`prunes a dropped proposal ${DROPPED_KEPT_DAYS} days after it was dropped`, () => {
    const day = (offset: number) => new Date(Date.parse("2026-10-07") + offset * 86_400_000).toISOString().slice(0, 10);
    const dropped = [{ proposal_id: "a", dropped_on: day(0) }];
    assert.strictEqual(droppedStillKept(dropped, day(DROPPED_KEPT_DAYS)).length, 1);
    assert.strictEqual(droppedStillKept(dropped, day(DROPPED_KEPT_DAYS + 1)).length, 0);
  });
});

describe("#2497 AC-5: the run says what it proposed", () => {
  const proposal = { proposal_id: "2026-10-07/llm7-io/limits_reduced", ...recordOf("LLM7.io") };
  const workflow = readFileSync(path.join(REPO, ".github", "workflows", "reverify.yml"), "utf-8");

  function runBlockOf(stepId: string): string {
    const at = workflow.indexOf(`id: ${stepId}`);
    const run = workflow.indexOf("run: |", at);
    const lines = workflow.slice(run).split("\n").slice(1);
    const body: string[] = [];
    for (const line of lines) {
      if (line.trim() !== "" && !line.startsWith("          ")) break;
      body.push(line.slice(10));
    }
    return body.join("\n");
  }

  function summaryWith(proposed: unknown[]) {
    return summaryLines(
      { verified: 1, flagged: 0, changed: 1, changes: [], proposed, suppressed: [], unclassified: [], rejected: [] },
      { useAi: true, checked: 2, oldestRemaining: "2026-08-01", total: 1580 },
    ).join("\n");
  }

  it("prints each proposal with its vendor, type, impact and source URL", () => {
    assert.strictEqual(
      proposalLine(proposal),
      "  proposed 2026-10-07/llm7-io/limits_reduced: LLM7.io, limits_reduced, high impact, https://docs.llm7.io/limits",
    );
    assert.match(summaryWith([proposal]), /^Proposed to data\/change_proposals\.json: 1\n {2}proposed 2026-10-07\/llm7-io\/limits_reduced: /m);
  });

  it("puts the same lines in the job summary and the commit message", () => {
    const dir = mkdtempSync(path.join(SCRATCH, "workflow-"));
    const log = path.join(dir, "reverify.log");
    writeFileSync(log, summaryWith([proposal]) + "\n");
    const stub = path.join(dir, "gate.sh");
    writeFileSync(stub, 'printf "%s" "$2" > "$MESSAGE_TO"\n');
    const shell = (block: string, env: Record<string, string>) =>
      spawnSync("bash", ["-c", block.replaceAll("/tmp/reverify.log", log).replace(/\$\{\{[^}]*\}\}/g, "75")], {
        encoding: "utf-8",
        env: { ...process.env, ...env },
      });

    const reread = runBlockOf("reverify").replace(/node scripts\/reverify-rolling\.js[^|]*\| tee [^\n]+/, `cat ${log}`);
    const summary = path.join(dir, "summary.md");
    const outputs = path.join(dir, "outputs");
    const first = shell(reread, { GITHUB_OUTPUT: outputs, GITHUB_STEP_SUMMARY: summary });
    assert.strictEqual(first.status, 0, first.stderr);
    assert.match(readFileSync(outputs, "utf-8"), /^proposed=1$/m);
    assert.match(readFileSync(summary, "utf-8"), /^- 2026-10-07\/llm7-io\/limits_reduced: LLM7\.io, limits_reduced, high impact, https:\/\/docs\.llm7\.io\/limits$/m);

    const message = path.join(dir, "message.txt");
    const gate = runBlockOf("gate").replace("bash scripts/gate-data-push.sh", `bash ${stub}`);
    const second = shell(gate, { MESSAGE_TO: message, PROPOSED: "1" });
    assert.strictEqual(second.status, 0, second.stderr);
    const [subject, blank, ...body] = readFileSync(message, "utf-8").split("\n");
    assert.match(subject, /^data\(auto\): rolling re-verification — .*1 changes proposed for review/);
    assert.strictEqual(blank, "");
    assert.ok(body.includes("- 2026-10-07/llm7-io/limits_reduced: LLM7.io, limits_reduced, high impact, https://docs.llm7.io/limits"), body.join("\n"));
  });

  it("leaves the commit message one line long when it proposed nothing", () => {
    const dir = mkdtempSync(path.join(SCRATCH, "workflow-none-"));
    const log = path.join(dir, "reverify.log");
    writeFileSync(log, summaryWith([]) + "\n");
    const stub = path.join(dir, "gate.sh");
    writeFileSync(stub, 'printf "%s" "$2" > "$MESSAGE_TO"\n');
    const message = path.join(dir, "message.txt");
    const gate = runBlockOf("gate").replace("bash scripts/gate-data-push.sh", `bash ${stub}`).replaceAll("/tmp/reverify.log", log);
    const run = spawnSync("bash", ["-c", gate], { encoding: "utf-8", env: { ...process.env, MESSAGE_TO: message, PROPOSED: "0" } });
    assert.strictEqual(run.status, 0, run.stderr);
    assert.ok(!readFileSync(message, "utf-8").includes("\n"));
  });
});

describe("#2497: the staleness alarm counts what the detector proposed", () => {
  const SCHEDULED = { known: true, scheduled: true, reason: null };
  const NOW = new Date("2026-10-30T07:00:00Z");
  const published = [{ ...recordOf("LLM7.io") }];
  const proposedOn = (recorded_date: string) => ({ proposals: [{ ...A_WIDENING, recorded_date }], dropped: [] });

  it("stays quiet while the detector goes on proposing, though nothing has been confirmed for weeks", () => {
    const quiet = report(changeLogFreshness(published, NOW), DEFAULT_THRESHOLD_DAYS, SCHEDULED, changeLogFreshness(recordsTheDetectorProposed(proposedOn("2026-10-29")), NOW));
    assert.strictEqual(quiet.failJob, false);
    assert.match(quiet.text, /Proposed by the detector, pending review or dropped: 1 \(last 2026-10-29, 1 days ago\)/);
  });

  it("counts a dropped proposal as the detector working", () => {
    const store = { proposals: [], dropped: [{ ...A_WIDENING, recorded_date: "2026-10-29", dropped_on: "2026-10-29" }] };
    assert.strictEqual(report(changeLogFreshness(published, NOW), DEFAULT_THRESHOLD_DAYS, SCHEDULED, changeLogFreshness(recordsTheDetectorProposed(store), NOW)).failJob, false);
  });

  it("fires when neither the log nor the proposals have heard from the detector inside the threshold", () => {
    const stale = report(changeLogFreshness(published, NOW), DEFAULT_THRESHOLD_DAYS, SCHEDULED, changeLogFreshness(recordsTheDetectorProposed(proposedOn("2026-10-08")), NOW));
    assert.strictEqual(stale.failJob, true);
    assert.match(stale.text, /STALE: 22 days since the detector last recorded or proposed a change/);
  });

  it("is what the alarm script reads, so a fresh proposal clears it and a stale one does not", () => {
    const dir = mkdtempSync(path.join(SCRATCH, "alarm-"));
    const changesPath = writeJson(path.join(dir, "deal_changes.json"), { changes: [{ ...recordOf("LLM7.io"), recorded_date: "2026-01-01" }] });
    const alarm = (recorded: string) => {
      const proposalsPath = writeJson(path.join(dir, "change_proposals.json"), proposedOn(recorded));
      return spawnSync("node", [path.join(REPO, "scripts", "check-change-log-staleness.js")], {
        cwd: REPO,
        encoding: "utf-8",
        env: { ...process.env, AGENTDEALS_CHANGES_PATH: changesPath, AGENTDEALS_PROPOSALS_PATH: proposalsPath },
      });
    };
    const today = new Date().toISOString().slice(0, 10);
    const fresh = alarm(today);
    assert.strictEqual(fresh.status, 0, fresh.stdout);
    assert.match(fresh.stdout, new RegExp(`Proposed by the detector, pending review or dropped: 1 \\(last ${today}, 0 days ago\\)`));
    assert.strictEqual(alarm("2026-01-02").status, 1);
  });

  it("reads the committed store, not the one a run just wrote to disk", () => {
    const repo = mkdtempSync(path.join(SCRATCH, "ref-"));
    const git = (...args: string[]) => assert.strictEqual(spawnSync("git", args, { cwd: repo, encoding: "utf-8" }).status, 0, args.join(" "));
    git("init", "--initial-branch=main");
    git("config", "user.email", "fixture@example.com");
    git("config", "user.name", "fixture");
    const file = writeJson(path.join(repo, "data", "change_proposals.json"), proposedOn("2026-10-01"));
    git("add", "-A");
    git("commit", "-m", "what main holds");
    writeJson(file, proposedOn("2026-10-29"));
    assert.strictEqual(proposalsAtRef("main", file, repo).proposals[0].recorded_date, "2026-10-01");
    assert.throws(() => proposalsAtRef("no-such-ref", file, repo), /Cannot read data\/change_proposals\.json at no-such-ref/);
  });
});

describe("#2497 AC-2 and AC-6: the 2026-10-07 run's five records, as proposals", () => {
  const MARKERS: Record<string, string> = {
    "Grafana Cloud": "platform fee is now required for exceeding those limits",
    "SimplePDF.eu": "own page now redirects to simplepdf.com",
    "testingbot.com": "The current page only mentions a",
    "LLM7.io": "The free tier limits have been significantly reduced",
    "Clever Bootstrap Program": "now names 7 January 2027",
  };
  const VENDOR_PAGES: Record<string, string> = {
    "Grafana Cloud": "/vendor/grafana-cloud",
    "SimplePDF.eu": "/vendor/simplepdf-eu",
    "testingbot.com": "/vendor/testingbot-com",
    "LLM7.io": "/vendor/llm7-io",
    "Clever Bootstrap Program": "/vendor/clever-bootstrap-program",
  };
  const SHARED_ROUTES = ["/pricing-changes", "/changes", "/free-tier-tracker", "/api/changes"];
  const ROUTES = [...SHARED_ROUTES, ...Object.values(VENDOR_PAGES)];
  const SHOWN_WHEN_PUBLISHED = ["/pricing-changes", "/changes", "/api/changes"];

  let publishedStores: Stores;
  let proposedStores: Stores;
  let confirmedStores: Stores;
  let confirmRun: ReturnType<typeof spawnSync>;
  const servers: Record<string, { child: ChildProcess; port: number }> = {};
  const pages: Record<string, Record<string, string>> = {};

  const recordsOn = (state: string, route: string) =>
    Object.entries(MARKERS)
      .filter(([, marker]) => pages[state][route].includes(marker))
      .map(([vendor]) => vendor);

  before(async () => {
    publishedStores = stores("published", [...logBeforeTheRun().changes, ...THE_RUN.records]);
    proposedStores = stores("proposed", logBeforeTheRun().changes);
    proposeChangeEntries(THE_RUN.records, {
      changesPath: proposedStores.changesPath,
      path: proposedStores.proposalsPath,
      windowDays: WINDOW,
      now: RUN_DAY,
      offers: readJson(proposedStores.indexPath).offers,
    });
    confirmedStores = stores("confirmed", logBeforeTheRun().changes);
    cpSync(proposedStores.proposalsPath, confirmedStores.proposalsPath);
    confirmRun = runScript("change-proposals.js", ["confirm", "2026-10-07/llm7-io/limits_reduced"], confirmedStores);

    for (const [state, paths] of [["published", publishedStores], ["proposed", proposedStores], ["confirmed", confirmedStores]] as const) {
      servers[state] = await serve({ AGENTDEALS_CHANGES_PATH: paths.changesPath, AGENTDEALS_INDEX_PATH: paths.indexPath });
      pages[state] = {};
      for (const route of ROUTES) {
        const res = await fetch(`http://localhost:${servers[state].port}${route}`);
        assert.strictEqual(res.status, 200, `${state} ${route}`);
        pages[state][route] = await res.text();
      }
    }
  });

  after(() => {
    for (const { child } of Object.values(servers)) child.kill();
  });

  it("proposes all five, each carrying the restatement it would make", () => {
    const { proposals } = readProposals(proposedStores.proposalsPath);
    const byVendor = new Map(proposals.map((p: Record_) => [p.vendor, p]));
    assert.deepStrictEqual([...byVendor.keys()].sort(), Object.keys(MARKERS).sort());
    assert.deepStrictEqual(byVendor.get("Grafana Cloud").restatement, [
      { url: "https://grafana.com/pricing/", description: recordOf("Grafana Cloud").current_state },
    ]);
    assert.deepStrictEqual(byVendor.get("testingbot.com").restatement, [
      { url: "https://testingbot.com/", description: recordOf("testingbot.com").current_state },
    ]);
    assert.deepStrictEqual(byVendor.get("LLM7.io").restatement, [
      { url: "https://docs.llm7.io/limits", refused: READING_DROPS_A_FIGURE_OUR_SOURCE_CHECK_FOUND, figures: ["$12"] },
    ]);
    assert.deepStrictEqual(byVendor.get("SimplePDF.eu").restatement, []);
    assert.deepStrictEqual(byVendor.get("Clever Bootstrap Program").restatement, []);
  });

  it("renders each record, once published, on the change logs, the API and its own vendor page", () => {
    for (const route of ROUTES) {
      const expected = Object.keys(MARKERS)
        .filter((vendor) => SHOWN_WHEN_PUBLISHED.includes(route) || VENDOR_PAGES[vendor] === route)
        .sort();
      assert.deepStrictEqual(recordsOn("published", route).sort(), expected, route);
    }
  });

  it("renders none of the five on any of those routes while they are proposals", () => {
    for (const route of ROUTES) assert.deepStrictEqual(recordsOn("proposed", route), [], route);
  });

  it("counts none of them in /free-tier-tracker's totals while they are proposals, and LLM7.io's once it is confirmed", () => {
    const tracking = (state: string) => Number(/Tracking (\d+) pricing changes/.exec(pages[state]["/free-tier-tracker"])?.[1]);
    const VENDOR_CHANGES_OF_THE_RUN = THE_RUN.records.filter((r) => r.change_type !== "record_corrected").length;
    assert.strictEqual(VENDOR_CHANGES_OF_THE_RUN, 4);
    assert.strictEqual(tracking("published") - tracking("proposed"), VENDOR_CHANGES_OF_THE_RUN);
    assert.strictEqual(tracking("confirmed") - tracking("proposed"), 1);
  });

  it("keeps every listing's text while they are proposals, where publishing them rewrites two", () => {
    const ledgerOf = (paths: Stores) => readJson(paths.restatedPath).restatements.filter((e: Listing) => e.vendor in MARKERS);
    const ledgerBefore = ledgerOf(proposedStores);
    for (const paths of [publishedStores, proposedStores]) {
      const run = runScript("restate-superseded-terms.js", ["--write"], paths);
      assert.strictEqual(run.status, 0, run.stderr);
    }
    const textOf = (paths: Stores) =>
      new Map(readJson(paths.indexPath).offers.filter((o: Listing) => o.vendor in MARKERS).map((o: Listing) => [o.vendor, o.description]));
    const before = new Map(THE_RUN.listings.map((l) => [l.vendor, l.description]));
    assert.deepStrictEqual(textOf(proposedStores), before);
    const rewritten = [...textOf(publishedStores)].filter(([vendor, text]) => before.get(vendor) !== text).map(([vendor]) => vendor);
    assert.deepStrictEqual(rewritten.sort(), ["Grafana Cloud", "testingbot.com"]);
    assert.deepStrictEqual(ledgerOf(proposedStores), ledgerBefore, "a proposal reached the restatement ledger");
  });

  it("moves LLM7.io's record into the change log as written once it is confirmed", () => {
    assert.strictEqual(confirmRun.status, 0, String(confirmRun.stderr));
    const confirmed = readJson(confirmedStores.changesPath).changes.filter(isOneOfTheRun);
    assert.deepStrictEqual(confirmed, [recordOf("LLM7.io")]);
    assert.match(String(confirmRun.stdout), /https:\/\/docs\.llm7\.io\/limits not restated: reading_drops_a_figure_our_source_check_found \(\$12\)/);
    assert.deepStrictEqual(
      readProposals(confirmedStores.proposalsPath).proposals.map((p: Record_) => p.vendor).sort(),
      ["Clever Bootstrap Program", "Grafana Cloud", "SimplePDF.eu", "testingbot.com"],
    );
  });

  it("then renders LLM7.io's record where a published record shows, and still none of the other four", () => {
    for (const route of ROUTES) {
      const expected = SHOWN_WHEN_PUBLISHED.includes(route) || route === VENDOR_PAGES["LLM7.io"] ? ["LLM7.io"] : [];
      assert.deepStrictEqual(recordsOn("confirmed", route), expected, route);
    }
  });
});
