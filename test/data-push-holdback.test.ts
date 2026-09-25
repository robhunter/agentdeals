import { describe, it } from "node:test";
import assert from "node:assert";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  DERIVED_FROM_THE_VENDOR_DATA,
  VENDOR_KEYED_DATA,
  failingSection,
  holdbackVerdict,
  namesTheVendor,
  serializeVendorData,
  vendorKey,
  vendorsMoved,
  vendorsMovedIn,
  vendorsNamedInFailure,
  withVendorsAsTheyWereBefore,
  withVendorsAsTheyWereBeforeIn,
} from "../src/data-push-holdback.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = join(__dirname, "..");

function row(vendor: string, extra: Record<string, unknown> = {}) {
  return { vendor, ...extra };
}

function doc(rows: unknown[], arrayKey = "changes", rest: Record<string, unknown> = {}) {
  return { ...rest, [arrayKey]: rows };
}

const FAILURE = `ℹ tests 5015
ℹ pass 5013
ℹ fail 2
✖ failing tests:
test at test/superseded-terms-listings.test.ts:181:5
✖ publishes no superseded stored terms in a visible listing slot
  AssertionError: [ '/category/monitoring Hyperping', '/best/free-monitoring Hyperping' ]
`;

describe("#1337 which vendors a red suite blames", () => {
  it("reads only the failure report, so a vendor named in a passing test's title is not blamed", () => {
    const log = `✔ Databases: Firebase is demoted on a recorded withdrawal\n${FAILURE}`;
    assert.deepStrictEqual(vendorsNamedInFailure(log, ["Firebase", "Hyperping"]), ["Hyperping"]);
  });

  it("names nobody when the suite failed without printing a failure report", () => {
    assert.strictEqual(failingSection("ℹ fail 1\nthe suite died\n"), "");
    assert.deepStrictEqual(vendorsNamedInFailure("ℹ fail 1\nthe suite died\n", ["Hyperping"]), []);
  });

  it("matches a vendor name on its own boundaries, not as a fragment of a longer word", () => {
    assert.ok(namesTheVendor("✖ /vendor/modal is wrong", "Modal"));
    assert.ok(namesTheVendor("✖ Modal's page is wrong", "Modal"));
    assert.ok(!namesTheVendor("✖ the Modality report is wrong", "Modal"));
    assert.ok(!namesTheVendor("✖ premodal is wrong", "Modal"));
  });

  it("matches a vendor name whose own characters mean something to a regular expression", () => {
    assert.ok(namesTheVendor("✖ C++ Builder is wrong", "C++ Builder"));
    assert.ok(namesTheVendor("✖ Fly.io is wrong", "Fly.io"));
    assert.ok(!namesTheVendor("✖ FlyXio is wrong", "Fly.io"));
  });

  it("returns each blamed vendor once, whatever case the failure printed it in", () => {
    const log = "✖ failing tests:\nhyperping HYPERPING Hyperping\n";
    assert.deepStrictEqual(vendorsNamedInFailure(log, ["Hyperping", "hyperping"]), ["Hyperping"]);
  });
});

describe("#1337 whether a batch stands or falls as one", () => {
  it("holds back the named vendors when they are a proper part of what the run moved", () => {
    const verdict = holdbackVerdict(["Hyperping"], ["Authress", "Hyperping", "RepoForge", "Thunder Client"]);
    assert.strictEqual(verdict.decision, "hold-back");
    assert.deepStrictEqual(verdict.vendors, ["Hyperping"]);
    assert.match(verdict.reason, /1 of the 4/);
  });

  it("refuses the batch when the failure names no vendor the run moved", () => {
    const verdict = holdbackVerdict([], ["Authress", "Hyperping"]);
    assert.strictEqual(verdict.decision, "refuse-the-batch");
    assert.deepStrictEqual(verdict.vendors, []);
    assert.match(verdict.reason, /nothing to attribute the refusal to/);
  });

  it("refuses the batch when every vendor it moved is named, so nothing would be left", () => {
    const verdict = holdbackVerdict(["Authress", "Hyperping"], ["Authress", "Hyperping"]);
    assert.strictEqual(verdict.decision, "refuse-the-batch");
    assert.match(verdict.reason, /nothing to push/);
  });

  it("refuses the batch when the run moved no vendor at all", () => {
    assert.strictEqual(holdbackVerdict([], []).decision, "refuse-the-batch");
  });

  it("blames only vendors this run moved, so a name the failure carries from elsewhere decides nothing", () => {
    const verdict = holdbackVerdict(["Firebase"], ["Authress", "Hyperping"]);
    assert.strictEqual(verdict.decision, "refuse-the-batch");
    assert.deepStrictEqual(verdict.vendors, []);
  });
});

describe("#1337 which vendors a run moved", () => {
  it("names a vendor whose row changed, added or went, and no vendor whose row stood still", () => {
    const before = doc([row("Steady", { note: "same" }), row("Edited", { note: "was" }), row("Gone", {})]);
    const after = doc([row("Steady", { note: "same" }), row("Edited", { note: "now" }), row("Arrived", {})]);
    assert.deepStrictEqual(vendorsMoved(before, after, "changes"), ["Arrived", "Edited", "Gone"]);
  });

  it("names a vendor whose second row is new, so a per-name join does not hide a duplicate", () => {
    const before = doc([row("Kong", { date: "2026-08-28" })]);
    const after = doc([row("Kong", { date: "2026-08-28" }), row("Kong", { date: "2026-09-09" })]);
    assert.deepStrictEqual(vendorsMoved(before, after, "changes"), ["Kong"]);
  });

  it("reads an absent or misshapen array as no vendors rather than throwing", () => {
    assert.deepStrictEqual(vendorsMoved(null, null, "changes"), []);
    assert.deepStrictEqual(vendorsMoved({}, { changes: "not an array" }, "changes"), []);
  });
});

describe("#1337 putting a held vendor back the way main had it", () => {
  it("restores every row of a held vendor and leaves every other row exactly as the run wrote it", () => {
    const before = doc([row("Kept", { note: "was" }), row("Held", { note: "was" })]);
    const after = doc([row("Kept", { note: "now" }), row("Held", { note: "now" })]);
    assert.deepStrictEqual(withVendorsAsTheyWereBefore(before, after, "changes", ["Held"]), {
      changes: [row("Kept", { note: "now" }), row("Held", { note: "was" })],
    });
  });

  it("drops a row the run added for a held vendor the baseline did not carry", () => {
    const before = doc([row("Kept", {})]);
    const after = doc([row("Kept", {}), row("Held", { note: "new" })]);
    assert.deepStrictEqual(withVendorsAsTheyWereBefore(before, after, "changes", ["Held"]), {
      changes: [row("Kept", {})],
    });
  });

  it("puts back a row the run removed for a held vendor", () => {
    const before = doc([row("Kept", {}), row("Held", { note: "was" })]);
    const after = doc([row("Kept", {})]);
    assert.deepStrictEqual(withVendorsAsTheyWereBefore(before, after, "changes", ["Held"]), {
      changes: [row("Kept", {}), row("Held", { note: "was" })],
    });
  });

  it("restores both of a held vendor's rows at the place the first of them stood", () => {
    const before = doc([row("Held", { n: 1 }), row("Kept", {}), row("Held", { n: 2 })]);
    const after = doc([row("Held", { n: 9 }), row("Kept", {}), row("Held", { n: 8 })]);
    assert.deepStrictEqual(withVendorsAsTheyWereBefore(before, after, "changes", ["Held"]), {
      changes: [row("Held", { n: 1 }), row("Held", { n: 2 }), row("Kept", {})],
    });
  });

  it("matches the held vendor whatever case the failure named it in", () => {
    const before = doc([row("Hyperping", { note: "was" })]);
    const after = doc([row("Hyperping", { note: "now" })]);
    assert.deepStrictEqual(withVendorsAsTheyWereBefore(before, after, "changes", ["hYpErPiNg"]), {
      changes: [row("Hyperping", { note: "was" })],
    });
  });

  it("keeps the run's own value for a field that is not a vendor's row", () => {
    const before = doc([row("Held", { note: "was" })], "records", { generated_at: "2026-09-09" });
    const after = doc([row("Held", { note: "now" })], "records", { generated_at: "2026-09-10" });
    const reduced = withVendorsAsTheyWereBefore(before, after, "records", ["Held"]) as Record<string, unknown>;
    assert.strictEqual(reduced.generated_at, "2026-09-10");
    assert.deepStrictEqual(reduced.records, [row("Held", { note: "was" })]);
  });

  it("returns the run's own data untouched when nothing is held back", () => {
    const after = doc([row("Kept", {})]);
    assert.strictEqual(withVendorsAsTheyWereBefore(doc([]), after, "changes", []), after);
  });

  it("writes the shape the shipped files are written in, so a holdback is not a reformatting", () => {
    for (const { path, arrayKeys } of VENDOR_KEYED_DATA) {
      const shipped = readFileSync(join(REPO, path), "utf8");
      const parsed = JSON.parse(shipped) as Record<string, unknown>;
      for (const arrayKey of arrayKeys) {
        assert.ok(Array.isArray(parsed[arrayKey]), `${path} has no ${arrayKey} array for a vendor's rows to live in`);
      }
      assert.strictEqual(serializeVendorData(parsed), shipped, `${path} is not written the way a holdback would rewrite it`);
    }
  });

  it("holding nobody back rewrites none of the shipped files", () => {
    for (const { path, arrayKeys } of VENDOR_KEYED_DATA) {
      const shipped = readFileSync(join(REPO, path), "utf8");
      const parsed = JSON.parse(shipped);
      assert.strictEqual(serializeVendorData(withVendorsAsTheyWereBeforeIn(parsed, parsed, arrayKeys, [])), shipped, path);
    }
  });

  it("every file a vendor's rows live in carries a vendor on every row", () => {
    for (const { path, arrayKeys } of VENDOR_KEYED_DATA) {
      const parsed = JSON.parse(readFileSync(join(REPO, path), "utf8"));
      const rows = arrayKeys.flatMap((arrayKey) => parsed[arrayKey] as { vendor?: unknown }[]);
      assert.ok(rows.length > 0, `${path} is empty, so this rule has no subject`);
      const nameless = rows.filter((r) => vendorKey(r.vendor) === "").length;
      assert.strictEqual(nameless, 0, `${path} has ${nameless} row(s) no holdback could attribute to a vendor`);
    }
  });

  it("names files that exist, so a rename cannot quietly stop a holdback reaching one", () => {
    for (const path of [...VENDOR_KEYED_DATA.map((f) => f.path), ...DERIVED_FROM_THE_VENDOR_DATA]) {
      assert.doesNotThrow(() => readFileSync(join(REPO, path), "utf8"), `${path} is named by the holdback and does not exist`);
    }
  });
});

const WORKFLOWS = join(REPO, ".github", "workflows");

function pathsAGatedWorkflowCommits(): string[] {
  const paths = new Set<string>();
  for (const file of readdirSync(WORKFLOWS).filter((f) => /\.ya?ml$/.test(f))) {
    const text = readFileSync(join(WORKFLOWS, file), "utf8");
    const at = text.indexOf("bash scripts/gate-data-push.sh");
    if (at === -1) continue;
    const end = text.indexOf("\n      - ", at);
    const step = text.slice(at, end === -1 ? undefined : end);
    for (const match of step.matchAll(/\bdata\/[A-Za-z0-9_.-]+\.json\b/g)) paths.add(match[0]);
  }
  return [...paths].sort();
}

function arraysOfVendorRows(path: string): string[] {
  const parsed = JSON.parse(readFileSync(join(REPO, path), "utf8")) as Record<string, unknown>;
  return Object.entries(parsed)
    .filter(([, value]) => Array.isArray(value) && value.some((r) => typeof (r as { vendor?: unknown })?.vendor === "string"))
    .map(([key]) => key);
}

function vendorRowsNoHoldbackRestores(paths: string[], keyed: readonly { path: string; arrayKeys: readonly string[] }[]): string[] {
  const restored = new Set(keyed.flatMap((f) => f.arrayKeys.map((k) => `${f.path}:${k}`)));
  return paths.flatMap((path) => arraysOfVendorRows(path).map((k) => `${path}:${k}`)).filter((at) => !restored.has(at));
}

describe("#1898 a held-back vendor loses every row its run wrote", () => {
  const before = {
    held: [row("Held", { first_read_date: "2026-09-21" })],
    resolved: [row("Kept", { outcome: "corroborated" })],
  };
  const after = {
    held: [],
    resolved: [row("Kept", { outcome: "corroborated" }), row("Held", { outcome: "baseline_moved" })],
  };

  it("puts a held vendor back in each array of a file that keeps its rows in two", () => {
    assert.deepStrictEqual(withVendorsAsTheyWereBeforeIn(before, after, ["held", "resolved"], ["Held"]), before);
  });

  it("counts a vendor as moved when one of those arrays moved, and names it once", () => {
    assert.deepStrictEqual(vendorsMovedIn(before, after, ["held", "resolved"]), ["Held"]);
    const both = { held: [row("Held", { first_read_date: "2026-09-22" })], resolved: [] };
    assert.deepStrictEqual(vendorsMovedIn(before, both, ["held", "resolved"]), ["Held", "Kept"]);
  });

  it("takes back the ledger entry a held vendor's restatement wrote", () => {
    const ledger = { restatements: [row("Buildkite", { restated_on: "2026-09-19" })] };
    const run = { restatements: [...ledger.restatements, row("Buildkite", { restated_on: "2026-09-20" })] };
    assert.deepStrictEqual(withVendorsAsTheyWereBeforeIn(ledger, run, ["restatements"], ["Buildkite"]), ledger);
  });

  it("restores every array of vendor rows in a file a gated workflow commits", () => {
    const paths = pathsAGatedWorkflowCommits();
    assert.ok(paths.includes("data/index.json"), paths.join(", "));
    assert.deepStrictEqual(vendorRowsNoHoldbackRestores(paths, VENDOR_KEYED_DATA), []);
  });

  it("finds the ledger and the corroboration file missing from a list that leaves them out", () => {
    const withoutThem = VENDOR_KEYED_DATA.filter(
      (f) => f.path !== "data/restated_terms.json" && f.path !== "data/change_corroboration.json",
    );
    assert.deepStrictEqual(vendorRowsNoHoldbackRestores(pathsAGatedWorkflowCommits(), withoutThem), [
      "data/change_corroboration.json:held",
      "data/change_corroboration.json:resolved",
      "data/restated_terms.json:restatements",
    ]);
  });
});
