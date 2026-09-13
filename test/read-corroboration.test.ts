import { describe, it } from "node:test";
import assert from "node:assert";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const { runAiMode, pickOldestEntries, summaryLines } = await import("../scripts/reverify-rolling.js");
const {
  CORROBORATED,
  CONTRADICTED,
  BASELINE_MOVED,
  NEVER_CORROBORATED,
  CORROBORATION_EXPIRY_DAYS,
  RESOLUTION_HISTORY_DAYS,
  demandsCorroboration,
  pruneResolutions,
  weakerImpact,
  writeHeldReadings,
} = await import("../scripts/change-corroboration.js");
const { RISK_DEMOTION, SEVERE_TYPES_WITHOUT_FLAT_DEMOTION, changeTypeCanDemote } = await import(
  "../src/change-demotion.ts"
);
const { CHANGE_TYPES } = await import("../scripts/change-log.js");

type Store = { held: any[]; resolved: any[] };

function scratch() {
  const dir = mkdtempSync(path.join(tmpdir(), "corroboration-"));
  const paths = {
    changesPath: path.join(dir, "deal_changes.json"),
    refusalsPath: path.join(dir, "change_refusals.json"),
    corroborationPath: path.join(dir, "change_corroboration.json"),
  };
  writeFileSync(paths.changesPath, JSON.stringify({ changes: [] }, null, 2));
  writeFileSync(paths.refusalsPath, JSON.stringify({ refusals: [] }, null, 2));
  writeFileSync(paths.corroborationPath, JSON.stringify({ held: [], resolved: [] }, null, 2) + "\n");
  return paths;
}

const published = (paths: { changesPath: string }) =>
  JSON.parse(readFileSync(paths.changesPath, "utf-8")).changes as any[];
const store = (paths: { corroborationPath: string }) =>
  JSON.parse(readFileSync(paths.corroborationPath, "utf-8")) as Store;

function runSummary() {
  return summaryLines(
    {
      verified: 3,
      flagged: 1,
      changed: 4,
      recorded: [],
      suppressed: [],
      unclassified: [],
      rejected: [],
      unchecked: [],
      reclassified: [],
      overruled: [],
      sourceChecks: new Map(),
      held: [],
      corroborated: [],
      resolutions: [],
      awaitingCorroboration: [],
    },
    {
      useAi: true,
      checked: 75,
      oldestRemaining: "2026-07-05",
      total: 1580,
      pickedAfterAFailedRead: 3,
      pickedForASecondReading: 22,
      repicked: 4,
      quarantine: { retried: 1, entered: 0, left: 0, total: 57, byCategory: new Map() },
      failedReadings: { failed: 1, total: 1580, readAgainWouldFail: 2, quarantined: 57 },
    },
  );
}

function pageSaying(text: string) {
  return async () => ({ ok: true, text, truncated: false });
}

function reads(verdict: any) {
  return async () => verdict;
}

const SNAPPIFY = {
  vendor: "snappify",
  url: "https://snappify.example/pricing",
  description: "Free plan: 10 projects per month",
  category: "Design",
  verifiedDate: "2026-08-01",
};

const A_REDUCTION = {
  status: "changed",
  summary: "the free plan drops from 10 projects per month to 3 projects per month",
  change_type: "limits_reduced",
  current_state: "Free plan: 3 projects per month",
  impact: "high",
};

async function runOver(offer: any, verdict: any, day: string, paths: any, options: any = {}) {
  return runAiMode([{ index: 0, offer }], { offers: [{ ...offer }] }, false, new Date(`${day}T06:00:00Z`), {
    fetchFn: options.fetchFn ?? pageSaying(`${offer.vendor} pricing. Free plan: 3 projects per month for $0.`),
    verifyFn: reads(verdict),
    confirmFn: options.confirmFn ?? (async () => ({ verdict: "yes" })),
    rateLimitMs: 0,
    ...paths,
  });
}

describe("#1640 — a demoting verdict is not published on one reading", () => {
  it("writes no change record for a reduction only one reading has seen", async () => {
    const paths = scratch();
    const run = await runOver(SNAPPIFY, A_REDUCTION, "2026-09-14", paths);

    assert.strictEqual(run.changed, 1, "the reading did not produce a change to hold");
    assert.deepStrictEqual(published(paths), [], "a single reading demoted the vendor on main");
    assert.strictEqual(run.recorded.length, 0);
  });

  it("keeps the reading it held, so the run is not silent about what it read", async () => {
    const paths = scratch();
    await runOver(SNAPPIFY, A_REDUCTION, "2026-09-14", paths);

    const held = store(paths).held;
    assert.strictEqual(held.length, 1);
    assert.strictEqual(held[0].vendor, "snappify");
    assert.strictEqual(held[0].change_type, "limits_reduced");
    assert.strictEqual(held[0].summary, A_REDUCTION.summary);
    assert.strictEqual(held[0].previous_state, SNAPPIFY.description);
    assert.strictEqual(held[0].first_read_date, "2026-09-14");
  });

  it("publishes once a second reading of the same page reaches the same verdict", async () => {
    const paths = scratch();
    await runOver(SNAPPIFY, A_REDUCTION, "2026-09-14", paths);
    const second = await runOver(SNAPPIFY, A_REDUCTION, "2026-09-15", paths);

    assert.strictEqual(second.corroborated.length, 1);
    assert.deepStrictEqual(
      published(paths).map((c) => c.change_type),
      ["limits_reduced"],
    );
    assert.deepStrictEqual(store(paths).held, [], "the reading stayed held after it was corroborated");
    const resolved = store(paths).resolved;
    assert.strictEqual(resolved.length, 1);
    assert.strictEqual(resolved[0].outcome, CORROBORATED);
    assert.match(resolved[0].detail, /2026-09-15/);
  });

  it("publishes the impact both readings support, not the louder one", async () => {
    const paths = scratch();
    await runOver(SNAPPIFY, A_REDUCTION, "2026-09-14", paths);
    await runOver(SNAPPIFY, { ...A_REDUCTION, impact: "low" }, "2026-09-15", paths);

    assert.deepStrictEqual(
      published(paths).map((c) => c.impact),
      ["low"],
      "two readings that disagreed on severity published the higher one",
    );
  });

  it("leaves a change that demotes nobody to publish on the reading that found it", async () => {
    const paths = scratch();
    const widened = {
      status: "changed",
      summary: "the free plan rises from 10 projects per month to 30 projects per month",
      change_type: "limits_increased",
      current_state: "Free plan: 30 projects per month",
      impact: "medium",
    };
    const run = await runOver(SNAPPIFY, widened, "2026-09-14", paths);

    assert.strictEqual(run.recorded.length, 1, "an improvement was held for a second reading it does not need");
    assert.deepStrictEqual(store(paths).held, []);
  });
});

describe("#1640 AC-3 — a page whose readings disagree publishes nothing", () => {
  const AMAZON_Q = {
    vendor: "Amazon Q Developer",
    url: "https://aws.example/q/developer/pricing",
    description: "Free tier: 50 chat interactions per month",
    category: "AI",
    verifiedDate: "2026-08-01",
  };
  const READ_AS_REDUCED = {
    status: "changed",
    summary: "the free tier drops from 50 chat interactions per month to 25",
    change_type: "limits_reduced",
    current_state: "Free tier: 25 chat interactions per month",
    impact: "medium",
  };

  it("publishes no reduction when the next reading finds the page unchanged", async () => {
    const paths = scratch();
    await runOver(AMAZON_Q, READ_AS_REDUCED, "2026-09-12", paths);
    const second = await runOver(AMAZON_Q, { status: "confirmed" }, "2026-09-13", paths);

    assert.deepStrictEqual(published(paths), [], "one reading in four demoted the vendor");
    assert.strictEqual(second.verified, 1, "the confirming reading did not confirm the terms");
    const resolved = store(paths).resolved;
    assert.strictEqual(resolved.length, 1);
    assert.strictEqual(resolved[0].outcome, CONTRADICTED);
    assert.match(resolved[0].detail, /unchanged/);
    assert.deepStrictEqual(store(paths).held, [], "a contradicted reading stayed in the queue");
  });

  it("publishes no reduction when the next reading is one the gate refuses", async () => {
    const paths = scratch();
    await runOver(AMAZON_Q, READ_AS_REDUCED, "2026-09-12", paths);
    const second = await runOver(
      AMAZON_Q,
      {
        status: "changed",
        summary: "the free tier now includes limited usage of chat interactions",
        change_type: "limits_reduced",
        current_state: "Free tier: limited usage of chat interactions",
        impact: "medium",
      },
      "2026-09-13",
      paths,
      {
        fetchFn: pageSaying(
          "Amazon Q Developer pricing. The free tier includes 50 chat interactions per month for $0.",
        ),
      },
    );

    assert.ok(second.rejected.length > 0, "the gate accepted the reading this control needs it to refuse");
    assert.deepStrictEqual(published(paths), []);
    const resolved = store(paths).resolved;
    assert.strictEqual(resolved[0].outcome, CONTRADICTED);
    assert.match(resolved[0].detail, /the gate refused/);
  });

  it("publishes no reduction when the next reading grades the same page a different way", async () => {
    const paths = scratch();
    await runOver(AMAZON_Q, READ_AS_REDUCED, "2026-09-12", paths);
    await runOver(
      AMAZON_Q,
      {
        status: "changed",
        summary: "the vendor moved from a chat-interaction allowance to a monthly seat price",
        change_type: "pricing_restructured",
        current_state: "Free tier: 25 chat interactions per month",
        impact: "medium",
      },
      "2026-09-13",
      paths,
    );

    assert.deepStrictEqual(published(paths), [], "two readings that named different changes published one of them");
    assert.strictEqual(store(paths).resolved[0].outcome, CONTRADICTED);
    assert.deepStrictEqual(store(paths).held, [], "the contradicting reading was itself held, so the page never settles");
  });
});

describe("#1640 AC-4 — a reduction both readings see still reaches a reader", () => {
  const SYNADIA = {
    vendor: "Synadia",
    url: "https://synadia.example/pricing",
    description: "Free tier: 50 active connections, 5GB of data per month",
    category: "Messaging",
    verifiedDate: "2026-08-01",
  };
  const REAL_REDUCTION = {
    status: "changed",
    summary:
      "the free tier moves from 50 active connections and 5GB of data per month to 10 Connections and 1 MiB Message Size",
    change_type: "limits_reduced",
    current_state: "Free tier: 2 Accounts, 10 Connections, 2 Leaf Nodes, 1 MiB Message Size, 10 GiB Network Data",
    impact: "high",
  };
  const page = pageSaying(
    "Synadia pricing. Free tier: 2 Accounts, 10 Connections, 2 Leaf Nodes, 1 MiB Message Size, 10 GiB Network Data for $0.",
  );

  it("publishes on the second reading, one run later than it would have", async () => {
    const paths = scratch();
    const first = await runOver(SYNADIA, REAL_REDUCTION, "2026-09-13", paths, { fetchFn: page });
    assert.strictEqual(first.held.length, 1, "a real reduction was not even held");
    assert.deepStrictEqual(published(paths), []);

    await runOver(SYNADIA, REAL_REDUCTION, "2026-09-14", paths, { fetchFn: page });
    assert.deepStrictEqual(
      published(paths).map((c) => `${c.change_type}/${c.impact}`),
      ["limits_reduced/high"],
      "a reduction with new quantities on both sides, read twice, still did not publish",
    );
  });
});

describe("#1640 — a held reading does not outlive what it was read against", () => {
  it("drops a held reading once the terms it was read against are not the terms we publish", async () => {
    const paths = scratch();
    await runOver(SNAPPIFY, A_REDUCTION, "2026-09-14", paths);

    const rewritten = { ...SNAPPIFY, description: "Free plan: 4 projects per month" };
    await runOver(rewritten, A_REDUCTION, "2026-09-15", paths);

    const resolved = store(paths).resolved;
    assert.ok(
      resolved.some((r) => r.outcome === BASELINE_MOVED),
      `no held reading was dropped when its baseline moved: ${JSON.stringify(resolved)}`,
    );
    assert.deepStrictEqual(
      published(paths),
      [],
      "a reading taken against terms we no longer publish was published anyway",
    );
    assert.strictEqual(
      store(paths).held.length,
      1,
      "the reading taken against the terms we publish now was thrown away with the one it replaced",
    );
    assert.strictEqual(store(paths).held[0].previous_state, rewritten.description);
  });

  it("gives up on a reading nothing has corroborated, rather than holding it for ever", async () => {
    const paths = scratch();
    await runOver(SNAPPIFY, A_REDUCTION, "2026-09-14", paths);

    const other = {
      vendor: "Elsewhere",
      url: "https://elsewhere.example/pricing",
      description: "Free plan: 1 seat",
      category: "Design",
      verifiedDate: "2026-08-01",
    };
    const day = new Date(Date.parse("2026-09-14") + (CORROBORATION_EXPIRY_DAYS + 1) * 86_400_000)
      .toISOString()
      .slice(0, 10);
    await runOver(other, { status: "confirmed" }, day, paths);

    assert.deepStrictEqual(store(paths).held, []);
    assert.strictEqual(store(paths).resolved[0].outcome, NEVER_CORROBORATED);
    assert.deepStrictEqual(published(paths), []);
  });

  it("keeps holding while the page cannot be read, because a failed read agrees with nothing", async () => {
    const paths = scratch();
    await runOver(SNAPPIFY, A_REDUCTION, "2026-09-14", paths);
    await runAiMode([{ index: 0, offer: SNAPPIFY }], { offers: [{ ...SNAPPIFY }] }, false, new Date("2026-09-15T06:00:00Z"), {
      fetchFn: async () => ({ ok: false, error: "HTTP 403" }),
      verifyFn: reads(A_REDUCTION),
      confirmFn: async () => ({ verdict: "yes" }),
      rateLimitMs: 0,
      ...paths,
    });

    assert.strictEqual(store(paths).held.length, 1, "a reading was discarded on a read that never happened");
    assert.deepStrictEqual(store(paths).resolved, []);
  });
});

describe("#1640 — the second reading is scheduled, not hoped for", () => {
  it("draws a page with a held reading first, though it was read more recently than anything else", () => {
    const offers = [
      { vendor: "Older", url: "https://older.example/p", verifiedDate: "2026-01-01" },
      { vendor: "Oldest", url: "https://oldest.example/p", verifiedDate: "2025-12-01" },
      { vendor: "snappify", url: SNAPPIFY.url, verifiedDate: "2026-09-14" },
    ];
    const { picked, pickedForASecondReading } = pickOldestEntries(offers, 2, new Date("2026-09-15T06:00:00Z"), {
      awaitingCorroboration: new Set([`snappify|${SNAPPIFY.url}`]),
    });

    assert.strictEqual(picked[0].offer.vendor, "snappify", "the held reading waits behind the whole queue");
    assert.strictEqual(pickedForASecondReading, 1);
  });

  it("leaves the queue alone when nothing is held", () => {
    const offers = [
      { vendor: "Older", url: "https://older.example/p", verifiedDate: "2026-01-01" },
      { vendor: "Oldest", url: "https://oldest.example/p", verifiedDate: "2025-12-01" },
    ];
    const { picked, pickedForASecondReading } = pickOldestEntries(offers, 2, new Date("2026-09-15T06:00:00Z"), {});
    assert.deepStrictEqual(
      picked.map((p: any) => p.offer.vendor),
      ["Oldest", "Older"],
    );
    assert.strictEqual(pickedForASecondReading, 0);
  });
});

describe("#1640 — the rule names the same records the risk scale demotes on", () => {
  it("demands a second reading for every change type that can demote a vendor", () => {
    const shouldHold = CHANGE_TYPES.filter((type: string) => changeTypeCanDemote(type)).sort();
    const doesHold = CHANGE_TYPES.filter((type: string) => demandsCorroboration({ change_type: type })).sort();
    assert.deepStrictEqual(doesHold, shouldHold);
    assert.ok(shouldHold.length > 0, "no change type can demote a vendor, so this rule has no subject");
  });

  it("reads that set from the risk scale rather than listing it again", () => {
    const flat = Object.entries(RISK_DEMOTION)
      .filter(([, level]) => level !== null)
      .map(([type]) => type);
    const perRecord = Object.keys(SEVERE_TYPES_WITHOUT_FLAT_DEMOTION);
    assert.deepStrictEqual(
      CHANGE_TYPES.filter((type: string) => changeTypeCanDemote(type)).sort(),
      [...new Set([...flat, ...perRecord])].sort(),
    );
  });

  it("holds no change type the risk scale never demotes on", () => {
    for (const [type, level] of Object.entries(RISK_DEMOTION)) {
      if (level !== null) continue;
      if (type in SEVERE_TYPES_WITHOUT_FLAT_DEMOTION) continue;
      assert.strictEqual(
        demandsCorroboration({ change_type: type }),
        false,
        `${type} demotes nobody and is still held back a run`,
      );
    }
  });
});

describe("#1640 — the held readings survive the run that took them", () => {
  it("is committed by the workflow that writes it, or the second reading never sees the first", () => {
    const workflow = readFileSync(path.join(REPO, ".github", "workflows", "reverify.yml"), "utf-8");
    const gate = workflow.slice(workflow.indexOf("gate-data-push.sh"));
    assert.ok(
      /data\/change_corroboration\.json/.test(gate),
      "the run writes held readings to a file the gate does not commit, so every reading is a first reading",
    );
  });

  it("counts the held readings from a line the run actually prints", () => {
    const workflow = readFileSync(path.join(REPO, ".github", "workflows", "reverify.yml"), "utf-8");
    const patterns = [...workflow.matchAll(/grep -oE '(\^[^']+)'/g)].map((m) => m[1]!);
    assert.ok(patterns.length >= 6, `the workflow reads ${patterns.length} counts out of the run summary`);

    const printed = runSummary().join("\n");
    const silent = patterns.filter((pattern) => !new RegExp(pattern, "m").test(printed));
    assert.deepStrictEqual(
      silent,
      [],
      `the workflow greps for a line the run no longer prints, so the count reaches the commit message as 0:\n${silent.join("\n")}`,
    );
    assert.ok(
      patterns.some((p) => /Awaiting a second reading/.test(p)),
      "the commit message does not say how many readings the run is holding",
    );
  });

  it("ships the file the store defaults to", () => {
    const shipped = JSON.parse(readFileSync(path.join(REPO, "data", "change_corroboration.json"), "utf-8"));
    assert.ok(Array.isArray(shipped.held));
    assert.ok(Array.isArray(shipped.resolved));
  });

  it("holds no reading against an offer we do not list, on the terms we publish for it", () => {
    const shipped = JSON.parse(readFileSync(path.join(REPO, "data", "change_corroboration.json"), "utf-8"));
    const offers = JSON.parse(readFileSync(path.join(REPO, "data", "index.json"), "utf-8")).offers as any[];
    const terms = new Map(offers.map((o) => [`${o.vendor}|${o.url}`, o.description]));
    const stray = shipped.held.filter(
      (held: any) => terms.get(`${held.vendor}|${held.source_url}`) !== held.previous_state,
    );
    assert.deepStrictEqual(
      stray.map((h: any) => h.vendor),
      [],
      "a held reading names terms we do not publish, so nothing will ever corroborate it",
    );
  });

  it("leaves the shipped store alone when a run holds and resolves nothing", () => {
    const paths = scratch();
    const before = readFileSync(paths.corroborationPath, "utf-8");
    const { written } = writeHeldReadings([], [], { path: paths.corroborationPath, now: new Date() });
    assert.strictEqual(written, false, "a run with nothing to say rewrote the store");
    assert.strictEqual(readFileSync(paths.corroborationPath, "utf-8"), before);
  });

  it("keeps the resolutions a rate could be measured from, and prunes the rest", () => {
    const now = new Date("2026-09-14T00:00:00Z");
    const inside = { resolved_date: "2026-08-20", outcome: CORROBORATED };
    const outside = {
      resolved_date: new Date(Date.parse("2026-09-14") - (RESOLUTION_HISTORY_DAYS + 1) * 86_400_000)
        .toISOString()
        .slice(0, 10),
      outcome: CONTRADICTED,
    };
    assert.deepStrictEqual(pruneResolutions([inside, outside], now), [inside]);
  });
});

describe("#1640 — the weaker impact is the one two readings both support", () => {
  it("ranks the impact words the change log writes", () => {
    assert.strictEqual(weakerImpact("high", "low"), "low");
    assert.strictEqual(weakerImpact("low", "high"), "low");
    assert.strictEqual(weakerImpact("medium", "high"), "medium");
    assert.strictEqual(weakerImpact("high", "high"), "high");
  });
});
