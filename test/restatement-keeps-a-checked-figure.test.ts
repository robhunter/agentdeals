import { describe, it } from "node:test";
import assert from "node:assert";
import { execFile, execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { promisify } from "node:util";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const {
  NOT_RESTATED_FOR_A_CHECKED_FIGURE,
  applyRestatements,
  checksToReadAgain,
  figuresTheReadingDrops,
  keptLines,
  readTheChecksAgain,
  reportOnlyLines,
  restatementsKeptForTheCheck,
  revertRestatement,
  revertRun,
  summaryLines,
  termsTheWriteWouldPublish,
} = await import("../scripts/restate-superseded-terms.js");

const RUN_DAY = "2026-10-04";
const REVERTED_ON = "2026-10-05";

interface Restated {
  vendor: string;
  url: string;
  stored: string;
  restated: string;
  detail: string;
}

const SUPABASE: Restated = {
  vendor: "Supabase",
  url: "https://supabase.com/pricing",
  stored: "Postgres development platform: database, Auth, Storage, Realtime and Edge Functions. The Free plan is $0: unlimited API requests, 50,000 monthly active users, a 500 MB database on a shared CPU with 500 MB RAM, 5 GB egress plus 5 GB cached egress, 1 GB file storage, 500,000 Edge Function invocations, and Realtime with 200 concurrent connections and 2 million messages a month. Free projects are paused after 1 week of inactivity, with a limit of 2 active projects. Pro starts at $25 a month for the first project and includes $10 a month of compute credits, enough for one Micro instance.",
  restated: "Postgres development platform — The Free plan is $0/month and includes unlimited API requests, 50,000 monthly active users, a 500 MB database, 5 GB egress, 5 GB cached egress, 1 GB file storage, 500,000 Edge Function invocations, and Realtime with 200 concurrent connections and 2 million messages a month. Free projects are paused after 1 week of inactivity, with a limit of 2 active projects.",
  detail: 'the page names Supabase as "supabase" and states "$ 0" and "$ 25" and "$10" and "$ 10"',
};

const SURREALDB: Restated = {
  vendor: "SurrealDB Cloud",
  url: "https://surrealdb.com/pricing",
  stored: "Multi-model cloud database — 1 GB storage, 0.25 vCPU, 512 MB memory free. Supports SQL-like queries, graph relations, document storage, real-time subscriptions. Includes team collaboration and RBAC",
  restated: "Multi-model cloud database — The 'Start' plan offers 1GB of storage free, forever, and a free compute instance with 0.25 vCPU and 1 GB memory ($0.000/hr). Further instances are available from $0.021/hr.",
  detail: 'the page names SurrealDB Cloud as "surrealdb cloud" and states "1 GB/mo"',
};

const MAXIM: Restated = {
  vendor: "Maxim AI",
  url: "https://getmaxim.ai/pricing",
  stored: "Simulate, evaluate, and observe your AI agents. Maxim is an end-to-end evaluation and observability platform, helping teams ship their AI agents reliably and >5x faster. Free forever for indie developers and small teams (3 seats).",
  restated: "Simulate, evaluate, and observe your AI agents — The 'OSS' tier is free forever for developers, small teams, and self-managed deployments. It includes features like a drop-in replacement, OTel compatibility, metrics & traces, built-in observability, budget management, and more. A 14-day free trial of 'Bifrost Enterprise' is available.",
  detail: 'the page names Maxim AI, renders "Free Forever" and no amount, and its markup states 1 typed price (Bifrost OSS USD 0)',
};

const COMPUTE_ENGINE: Restated = {
  vendor: "Google Compute Engine",
  url: "https://docs.cloud.google.com/free/docs/free-cloud-features",
  stored: "Always Free: 1 non-preemptible e2-micro VM (us-west1, us-central1, or us-east1), 30 GB standard persistent disk, 1 GB North America egress. GPUs/TPUs excluded",
  restated: "Access to 20+ free products, including Compute Engine, is available, but with restrictions such as not being able to add GPUs to VM instances. The $300 credit can't be used for Gemini API in AI Studio costs.",
  detail: 'the page names Google Compute Engine as "compute" and states "1 non-preemptible e2-micro VM instance per month"',
};

const THE_RUN_OF_2026_10_04 = [SUPABASE, SURREALDB, MAXIM, COMPUTE_ENGINE];

function listingOf(restated: Restated, detail = restated.detail) {
  return {
    vendor: restated.vendor,
    category: "Databases",
    description: restated.stored,
    tier: "Free",
    url: restated.url,
    tags: [],
    verifiedDate: RUN_DAY,
    source_check: { checked: RUN_DAY, outcome: "ok", detail },
  };
}

function rulingOn(offer: ReturnType<typeof listingOf>, description: string) {
  return {
    offer,
    description,
    refusal: null,
    change: { vendor: offer.vendor, date: RUN_DAY, change_type: "pricing_restructured", summary: `${offer.vendor} changed its pricing page.` },
    reading: { date: RUN_DAY, terms: description, url: offer.url },
    restatement: { reading_date: RUN_DAY, source_url: offer.url, record_date: RUN_DAY, change_type: "pricing_restructured", restated_on: RUN_DAY },
  };
}

function theRun(cases: Restated[] = THE_RUN_OF_2026_10_04) {
  const data = { offers: cases.map((restated) => listingOf(restated)) };
  const rulings = data.offers.map((offer, at) => rulingOn(offer, cases[at]!.restated));
  return { data, rulings };
}

describe("a restatement that drops a figure the listing's own source check found is not written", () => {
  it("holds Google Compute Engine and Supabase and writes SurrealDB Cloud and Maxim AI, replaying the run of 2026-10-04", () => {
    const { data, rulings } = theRun();
    const before = structuredClone(data);
    const written = applyRestatements(data, rulings, RUN_DAY);
    assert.deepStrictEqual(written.map((entry: { vendor: string }) => entry.vendor), ["SurrealDB Cloud", "Maxim AI"]);
    assert.deepStrictEqual(restatementsKeptForTheCheck(rulings).map((ruling: { offer: { vendor: string } }) => ruling.offer.vendor), ["Supabase", "Google Compute Engine"]);
    for (const held of [0, 3]) {
      assert.deepStrictEqual(data.offers[held], before.offers[held], `${before.offers[held]!.vendor}'s listing or its check moved`);
    }
    assert.strictEqual(data.offers[1]!.description, SURREALDB.restated);
    assert.strictEqual(data.offers[2]!.description, MAXIM.restated);
  });

  it("names the figures each held reading drops", () => {
    const { rulings } = theRun();
    assert.deepStrictEqual(figuresTheReadingDrops(rulings[0]), ["$ 25", "$10", "$ 10"]);
    assert.deepStrictEqual(figuresTheReadingDrops(rulings[3]), ["1 non-preemptible e2-micro VM instance per month"]);
  });

  it("holds a reading that drops any one figure the check found, though it keeps the others", () => {
    const offer = listingOf(SURREALDB, 'the page names SurrealDB Cloud as "surrealdb cloud" and states "1 GB/mo" and "512 MB"');
    const keepsOneDropsOne = rulingOn(offer, "Multi-model cloud database — 1 GB storage free, forever, and 0.25 vCPU.");
    assert.deepStrictEqual(figuresTheReadingDrops(keepsOneDropsOne), ["512 MB"]);
  });

  it("does not hold for a check that found only a price of zero, or only figures our stored terms never stated", () => {
    const zero = rulingOn(listingOf(SUPABASE, 'the page names Supabase as "supabase" and states "$ 0"'), SUPABASE.restated.replace(" is $0/month and", ""));
    assert.ok(!zero.description.includes("$0"), "the reading still states the price of zero, so the test says nothing");
    const neither = rulingOn(listingOf(SUPABASE, 'the page names Supabase as "supabase" and states "$599"'), SUPABASE.restated);
    const nameOnly = rulingOn(listingOf(SUPABASE, 'the page names Supabase as "supabase"'), SUPABASE.restated);
    for (const ruling of [zero, neither, nameOnly]) assert.deepStrictEqual(figuresTheReadingDrops(ruling), [], ruling.offer.source_check.detail);
  });

  it("does not count a refused ruling as held for the check", () => {
    const { rulings } = theRun([SUPABASE]);
    assert.deepStrictEqual(restatementsKeptForTheCheck([{ ...rulings[0], refusal: "tier_is_not_one_we_record_as_free" }]), []);
  });

  it("leaves a held reading out of the terms the write would publish, so no held reading is released against it", () => {
    const { rulings } = theRun();
    assert.deepStrictEqual([...termsTheWriteWouldPublish(rulings).keys()].map((key: string) => key.split("|")[0]!.toLowerCase()), ["surrealdb cloud", "maxim ai"]);
  });

  it("does not let a held reading use up the run's limit", () => {
    const { data, rulings } = theRun();
    const written = applyRestatements(data, rulings, RUN_DAY, 1);
    assert.deepStrictEqual(written.map((entry: { vendor: string }) => entry.vendor), ["SurrealDB Cloud"]);
  });
});

const measure = {
  offers_we_may_restate_from_their_reading: 4,
  offers_we_refuse_to_restate: {},
  offers_re_read_since_the_record_and_still_withheld: 1,
};

describe("the run says how many restatements it did not write for the check, and whose", () => {
  it("prints the count on every run, and the vendors only when there are any", () => {
    assert.deepStrictEqual(keptLines([]), [`${NOT_RESTATED_FOR_A_CHECKED_FIGURE}: 0`]);
    const { rulings } = theRun();
    assert.deepStrictEqual(keptLines(restatementsKeptForTheCheck(rulings)), [
      `${NOT_RESTATED_FOR_A_CHECKED_FIGURE}: 2`,
      "Not restated, by vendor: Supabase, Google Compute Engine",
    ]);
  });

  it("prints them between the still-withheld count and the restated count, on a write and on a report", () => {
    const { rulings } = theRun();
    const kept = restatementsKeptForTheCheck(rulings);
    for (const lines of [summaryLines(measure, [], "data/restated_terms.json", kept), reportOnlyLines(measure, kept)]) {
      const still = lines.findIndex((line: string) => line.startsWith("Re-read since the record and still withheld:"));
      const restated = lines.findIndex((line: string) => line.startsWith("Restated this run:"));
      assert.deepStrictEqual(lines.slice(still + 1, restated), keptLines(kept));
    }
  });

  const workflow = readFileSync(path.join(REPO, ".github", "workflows", "reverify.yml"), "utf-8");

  it("puts the clause in the commit message after the still-withheld count and before the readings awaiting a second reading", () => {
    assert.ok(workflow.includes("with ${STILL_WITHHELD} re-read and still withheld, ${KEPT_CLAUSE}, ${HELD} awaiting a second reading,"));
  });

  it("words the clause as the count, the reason and the vendors in parentheses, and leaves the parentheses out when it holds none", () => {
    const lines = workflow.split("\n").map((line) => line.trim());
    const step = ["KEPT=", "KEPT_VENDORS=", "KEPT_CLAUSE="].map((start) => lines.find((line) => line.startsWith(start)));
    assert.ok(step.every(Boolean), "the restate step no longer builds the clause from the run's lines");
    const dir = mkdtempSync(path.join(tmpdir(), "kept-clause-"));
    try {
      const clauseFor = (printed: string[]) => {
        const log = path.join(dir, "restate.log");
        writeFileSync(log, printed.join("\n") + "\n");
        const script = ["set -o pipefail", ...step.map((line) => line!.replaceAll("/tmp/restate.log", log)), 'printf "%s" "$KEPT_CLAUSE"'].join("\n");
        return execFileSync("bash", ["-c", script], { encoding: "utf-8" });
      };
      const { rulings } = theRun();
      assert.strictEqual(clauseFor(reportOnlyLines(measure, [])),
        "0 not restated because the reading drops a figure our source check found on the page");
      assert.strictEqual(clauseFor(summaryLines(measure, [], "data/restated_terms.json", restatementsKeptForTheCheck(rulings))),
        "2 not restated because the reading drops a figure our source check found on the page (Supabase, Google Compute Engine)");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("a revert settles the source check against the terms it puts back", () => {
  function written(restated: Restated, checkAfterTheRun: string) {
    const offer = listingOf(restated);
    const data = { offers: [offer] };
    const entries = applyRestatements(data, [rulingOn(offer, restated.restated)], RUN_DAY);
    assert.strictEqual(entries.length, 1, "the fixture's restatement was not written, so the revert says nothing");
    data.offers[0]!.source_check = { checked: REVERTED_ON, outcome: "ok", detail: checkAfterTheRun };
    return { data, entries };
  }

  const SURREALDB_AFTER = 'the page names SurrealDB Cloud as "surrealdb cloud" and states "1 GB/mo" and "$0.021/hr"';

  it("narrows the check to the figures the restored terms state", () => {
    const { data, entries } = written(SURREALDB, SURREALDB_AFTER);
    const { reverted } = revertRestatement(data, entries, SURREALDB.vendor, REVERTED_ON);
    assert.strictEqual(reverted, true);
    assert.strictEqual(data.offers[0]!.description, SURREALDB.stored);
    assert.strictEqual(data.offers[0]!.source_check.detail, 'the page names SurrealDB Cloud as "surrealdb cloud" and states "1 GB/mo"');
    assert.deepStrictEqual(checksToReadAgain(data, entries), []);
  });

  it("settles it the same way when a whole run is reverted", () => {
    const { data, entries } = written(SURREALDB, SURREALDB_AFTER);
    const outcome = revertRun(data, entries, RUN_DAY, REVERTED_ON);
    assert.strictEqual(outcome.reverted.length, 1);
    assert.strictEqual(data.offers[0]!.source_check.detail, 'the page names SurrealDB Cloud as "surrealdb cloud" and states "1 GB/mo"');
  });

  it("leaves a check alone when the restored terms state every figure it found", () => {
    const { data, entries } = written(SURREALDB, SURREALDB.detail);
    revertRestatement(data, entries, SURREALDB.vendor, REVERTED_ON);
    assert.deepStrictEqual(data.offers[0]!.source_check, { checked: REVERTED_ON, outcome: "ok", detail: SURREALDB.detail });
  });

  it("reads the page again when the restored terms state none of the figures the check found", async () => {
    const { data, entries } = written(SURREALDB, 'the page names SurrealDB Cloud as "surrealdb cloud" and states "$0.021/hr"');
    data.offers[0]!.source_check.checked = RUN_DAY;
    const outcome = revertRun(data, entries, RUN_DAY, REVERTED_ON);
    const due = checksToReadAgain(data, outcome.reverted);
    assert.deepStrictEqual(due.map((offer: { vendor: string }) => offer.vendor), ["SurrealDB Cloud"]);
    const fetched: string[] = [];
    await readTheChecksAgain(due, REVERTED_ON, async (url: string) => {
      fetched.push(url);
      return { ok: true, text: "SurrealDB Cloud pricing. Start: free forever, 1 GB/mo of storage and 0.25 vCPU with 512 MB memory.", structured: null };
    });
    assert.deepStrictEqual(fetched, [SURREALDB.url]);
    const check = data.offers[0]!.source_check;
    assert.strictEqual(check.checked, REVERTED_ON);
    assert.strictEqual(check.outcome, "ok");
    assert.ok(!check.detail.includes("$0.021/hr"), check.detail);
  });
});

describe("reverting a run from the command line reads a check again when the restored terms state none of its figures", () => {
  it("writes the restored terms and a check read from the page today", async () => {
    const terms = "Start: free forever. 1 GB/mo of storage and a compute instance with 0.25 vCPU and 512 MB memory. ";
    const about = "Scale when you need to, with team collaboration and role-based access control on every plan. No credit card required to start building. ";
    const page = `<html><body><h1>SurrealDB Cloud pricing</h1><p>${terms}${about.repeat(5)}</p></body></html>`;
    const server = createServer((_request, response) => {
      response.writeHead(200, { "Content-Type": "text/html" });
      response.end(page);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const dir = mkdtempSync(path.join(tmpdir(), "revert-reads-again-"));
    try {
      const address = server.address() as { port: number };
      const restated = { ...SURREALDB, url: `http://127.0.0.1:${address.port}/pricing` };
      const offer = listingOf(restated);
      const data = { offers: [offer] };
      const entries = applyRestatements(data, [rulingOn(offer, restated.restated)], RUN_DAY);
      data.offers[0]!.source_check = { checked: "2026-09-01", outcome: "ok", detail: 'the page names SurrealDB Cloud as "surrealdb cloud" and states "$0.021/hr"' };
      const indexPath = path.join(dir, "index.json");
      const restatedPath = path.join(dir, "restated_terms.json");
      writeFileSync(indexPath, JSON.stringify(data));
      writeFileSync(restatedPath, JSON.stringify({ restatements: entries }));
      const { stdout } = await promisify(execFile)("node", [path.join(REPO, "scripts", "restate-superseded-terms.js"), "--revert-run", RUN_DAY], {
        env: { ...process.env, AGENTDEALS_INDEX_PATH: indexPath, AGENTDEALS_RESTATED_PATH: restatedPath, TZ: "UTC" },
      });
      const after = JSON.parse(readFileSync(indexPath, "utf-8")).offers[0];
      assert.strictEqual(after.description, SURREALDB.stored);
      assert.strictEqual(after.source_check.checked, new Date().toISOString().slice(0, 10));
      assert.strictEqual(after.source_check.outcome, "ok");
      assert.ok(!after.source_check.detail.includes("$0.021/hr"), after.source_check.detail);
      assert.match(stdout, /SurrealDB Cloud's source check read again against the restored terms/);
    } finally {
      server.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
