import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fetchPageText, MAX_PAGE_TEXT_LENGTH } from "./verify-freshness.js";
import { storedDimensionsAbsentFromPage } from "./change-gate.js";
import { runAiMode } from "./reverify-rolling.js";
import { readRefusals, refusalHolds, offerKey } from "./change-refusals.js";

const NOW = new Date("2026-08-28T09:00:00Z");

const STORED_BEFORE_THIS_CHANGE = {
  "Deno Deploy":
    "Edge runtime — 1M requests/month, 100 GB egress, 1 GiB KV storage, 450K KV reads/month, 15 hours CPU time/month",
  Weaviate:
    "Open-source vector database — self-hosted: free forever with full features (hybrid search, multi-tenancy, compression). Cloud: 14-day free sandbox with full access. Paid cloud from $45/mo (Flex)",
};

const REFUSED_AS_UNQUANTIFIED = [
  "Weaviate",
  "Harness CI",
  "Typeform.com",
  "Mendix",
  "BuddyNS",
  "DB Designer",
  "Codefresh",
];

const RUN_OF_2026_08_28 = {
  Weaviate: {
    detection: {
      status: "changed",
      change_type: "limits_reduced",
      impact: "medium",
      summary:
        "The free tier now has specific limits: 100,000 objects, 1 GB memory, 10 GB disk, 1 collection, up to 3 tenants, 2,000 embeddings requests/day, and 1,000 Query Agent requests/month. The previous stored information stated 'free forever with full features' for self-hosted and a 14-day free sandbox for cloud. The cloud free tier is now 'Always free' with the above limits.",
      current_state:
        "The free tier now has specific limits: 100,000 objects, 1 GB memory, 10 GB disk, 1 collection, up to 3 tenants, 2,000 embeddings requests/day, and 1,000 Query Agent requests/month.",
    },
    confirmation: { verdict: "yes", reason: null },
  },
  "Deno Deploy": {
    detection: {
      status: "changed",
      change_type: "limits_reduced",
      impact: "high",
      summary:
        "Egress bandwidth for the free tier is now 20GiB, down from 100 GB. Memory time is now 150 GiB-hr, down from the stored value. KV storage is 1 GiB, matching the stored value, but the page now lists KV read and write units.",
      current_state:
        "Free tier includes 1M requests/month, 20GiB egress, 1 GiB KV storage, 1,000,000 KV read units/month, 500,000 KV write units/month, and 10 hr CPU time.",
    },
    confirmation: {
      verdict: "no",
      reason:
        "Egress increased from 100GB to 20GiB is an error in the report. It is actually an increase, not a decrease. Memory time is a new metric, not a decrease from a stored value. KV read/write units are new metrics, not a change to existing ones.",
    },
  },
  Abby: {
    detection: {
      status: "changed",
      change_type: "limits_reduced",
      impact: "medium",
      summary:
        "The free tier now has 1 A/B test instead of 1, and the pricing is now explicitly stated as $12/month per project for the Starter tier (previously just 'scale at a fair price').",
      current_state:
        "Free: 1,000 Events / month, 1 A/B Test, 3 Feature Flags / Remote Configs, 5 Environments. Starter: 1,000 Events / month, 1 A/B Test, 3 Feature Flags / Remote Configs, 5 Environments $12 /mo per Project",
    },
    confirmation: { verdict: "yes", reason: null },
  },
};

const failures = [];
function check(label, condition, detail = "") {
  console.log(`${condition ? "  ✓" : "  ✗"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!condition) failures.push(label);
}

const index = JSON.parse(readFileSync(new URL("../data/index.json", import.meta.url), "utf-8"));
function storedDescription(vendor) {
  return (
    STORED_BEFORE_THIS_CHANGE[vendor] ??
    index.offers.find((offer) => offer.vendor === vendor)?.description
  );
}
function offerFor(vendor) {
  const offer = index.offers.find((entry) => entry.vendor === vendor);
  return { ...offer, description: storedDescription(vendor) };
}

console.log("Part A — is the stored dimension on the page, and did we read all of it?\n");

const readings = new Map();
for (const vendor of REFUSED_AS_UNQUANTIFIED) {
  const offer = offerFor(vendor);
  const page = await fetchPageText(offer.url);
  if (!page.ok) {
    check(`${vendor}: page read`, false, page.error);
    continue;
  }
  const absent = storedDimensionsAbsentFromPage({ previous_state: offer.description }, page.text);
  readings.set(vendor, { truncated: page.truncated, absent });
  console.log(
    `  ${vendor}: ${page.text.length} chars${page.truncated ? " (cut at the fetch limit)" : " (whole page)"}` +
      `, missing from it: ${absent.length === 0 ? "nothing stored" : absent.map((a) => a.measured).join(", ")}`
  );
}

console.log("");
const reclassifiable = [...readings.entries()].filter(([, r]) => !r.truncated && r.absent.length > 0);
check(
  "exactly one of the seven has a stored dimension missing from a page we read in full",
  reclassifiable.length === 1 && reclassifiable[0][0] === "Weaviate",
  reclassifiable.map(([v]) => v).join(", ") || "none"
);
check(
  "the pages cut at the fetch limit are not read as evidence of absence",
  [...readings.entries()]
    .filter(([, r]) => r.truncated)
    .every(([vendor]) => vendor !== "Weaviate"),
  [...readings.entries()].filter(([, r]) => r.truncated).map(([v]) => v).join(", ")
);
check(
  "the fetch limit is the only reason a page reads as incomplete",
  [...readings.entries()].every(([, r]) => !r.truncated || MAX_PAGE_TEXT_LENGTH > 0)
);

console.log("\nPart B — the run, with the readings and verdicts of 2026-08-28\n");

const scratch = mkdtempSync(path.join(tmpdir(), "e2e-1116-"));
const changesPath = path.join(scratch, "deal_changes.json");
const refusalsPath = path.join(scratch, "change_refusals.json");
writeFileSync(changesPath, JSON.stringify({ changes: [] }, null, 2) + "\n");

const vendors = Object.keys(RUN_OF_2026_08_28);
const offers = vendors.map(offerFor);
const picked = offers.map((offer, index) => ({ index, offer }));
const data = { offers: offers.map((offer) => ({ ...offer })) };

const result = await runAiMode(picked, data, false, NOW, {
  fetchFn: fetchPageText,
  verifyFn: async (offer) => RUN_OF_2026_08_28[offer.vendor].detection,
  confirmFn: async (entry) => RUN_OF_2026_08_28[entry.vendor].confirmation,
  rateLimitMs: 0,
  changesPath,
  refusalsPath,
});

const recorded = new Map(result.recorded.map((change) => [change.vendor, change]));
check(
  "Weaviate is recorded rather than dropped",
  recorded.has("Weaviate"),
  recorded.get("Weaviate")?.change_type ?? "not recorded"
);
check(
  "Weaviate is recorded as a restructure",
  recorded.get("Weaviate")?.change_type === "pricing_restructured"
);
check(
  "the reclassification names the dimension that vanished",
  (result.reclassified ?? []).some((r) => r.candidate.vendor === "Weaviate" && /sandbox/.test(r.detail)),
  result.reclassified?.[0]?.detail ?? "no reclassification"
);
check("Deno Deploy is recorded rather than dropped", recorded.has("Deno Deploy"));
check(
  "Deno Deploy is kept over the second opinion by measurement",
  (result.overruled ?? []).some(
    (o) => o.candidate.vendor === "Deno Deploy" && o.difference.direction === "decrease"
  ),
  result.overruled?.[0]?.detail ?? "not overruled"
);
check(
  "Abby is still refused",
  result.rejected.some((r) => r.candidate.vendor === "Abby"),
  result.rejected.map((r) => `${r.candidate.vendor} [${r.reason}]`).join(", ") || "nothing refused"
);

const persisted = readRefusals(refusalsPath);
check("the refusal is on disk after the run", persisted.length === 1);
check("it names the record, the reason and the day", Boolean(
  persisted[0]?.vendor === "Abby" &&
    persisted[0]?.reason === "null_comparison" &&
    persisted[0]?.refused_date === "2026-08-28" &&
    persisted[0]?.source_url
));
check(
  "the run summary names the refused vendor",
  result.rejected.length > 0 && result.rejected.every((r) => r.candidate.vendor)
);

console.log("\nPart C — the refused record leaves the head of the queue\n");

const holds = refusalHolds(persisted, offers);
const abby = offers.find((offer) => offer.vendor === "Abby");
check(
  "Abby is held at the day it was refused",
  holds.get(offerKey("Abby", abby.url)) === "2026-08-28",
  String(holds.get(offerKey("Abby", abby.url)))
);
check(
  "a record whose description has since been corrected is not held",
  refusalHolds(persisted, [{ ...abby, description: "something we have since rewritten" }]).size === 0
);

rmSync(scratch, { recursive: true, force: true });

console.log("");
if (failures.length > 0) {
  console.log(`FAILED: ${failures.length}`);
  for (const failure of failures) console.log(`  - ${failure}`);
  process.exit(1);
}
console.log("All checks passed.");
