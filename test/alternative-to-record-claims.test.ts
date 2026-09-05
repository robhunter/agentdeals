import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CHANGE_DIRECTION, loadDealChanges } from "../dist/data.js";
import { CHANGE_KIND_NOUN, narrowingSentence } from "../dist/vendor-verdict.js";
import { isNoLongerInForce } from "../dist/change-resolution.js";
import { vendorSlugMap } from "../dist/vendor-slug.js";
import type { DealChange } from "../src/types.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(__dirname, "..");

const AVAILABILITY_QUESTION = /free tier still available\?$/;
const NEGATION = /\b(?:none|no|not|zero|never|neither|nor)\b/i;
const SENTENCE_BREAK = /(?<=[.!?])\s+/;

function heldBy(vendor: string, changes: DealChange[]): DealChange[] {
  return changes.filter(c => c.vendor.toLowerCase() === vendor.toLowerCase());
}

function negativeKinds(records: DealChange[]): string[] {
  return [...new Set(records.filter(c => CHANGE_DIRECTION[c.change_type] === "negative").map(c => c.change_type))];
}

function stillNarrowing(records: DealChange[]): DealChange[] {
  return records.filter(c => CHANGE_DIRECTION[c.change_type] === "negative" && !isNoLongerInForce(c));
}

function kindsCalledAbsent(answer: string, kinds: string[]): string[] {
  const called: string[] = [];
  for (const sentence of answer.split(SENTENCE_BREAK)) {
    if (!NEGATION.test(sentence)) continue;
    for (const kind of kinds) {
      const noun = CHANGE_KIND_NOUN[kind as DealChange["change_type"]];
      if (noun && sentence.toLowerCase().includes(noun)) called.push(kind);
    }
  }
  return [...new Set(called)].sort();
}

function availabilityAnswer(body: string): string | null {
  for (const [, json] of body.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)) {
    let parsed: { "@type"?: string; mainEntity?: Array<{ name: string; acceptedAnswer?: { text?: string } }> };
    try {
      parsed = JSON.parse(json);
    } catch {
      continue;
    }
    if (parsed["@type"] !== "FAQPage") continue;
    for (const entry of parsed.mainEntity ?? []) {
      if (AVAILABILITY_QUESTION.test(entry.name)) return entry.acceptedAnswer?.text ?? "";
    }
  }
  return null;
}

describe("#1297 the answer about our records reads the records", () => {
  let port = 0;
  let proc: ChildProcess | null = null;
  const answers = new Map<string, string>();
  const changes = loadDealChanges();
  const holders = [...vendorSlugMap.entries()].filter(([, vendor]) => heldBy(vendor, changes).length > 0);

  before(async () => {
    const started = await new Promise<{ child: ChildProcess; port: number }>((resolve, reject) => {
      const child = spawn("node", [path.join(REPO, "dist", "serve.js")], {
        cwd: REPO,
        stdio: ["ignore", "ignore", "pipe"],
        env: { ...process.env, PORT: "0", BASE_URL: "http://localhost" },
      });
      const timeout = setTimeout(() => { child.kill(); reject(new Error("Server startup timeout")); }, 30000);
      child.stderr!.on("data", (data: Buffer) => {
        const m = data.toString().match(/running on http:\/\/localhost:(\d+)/);
        if (m) { clearTimeout(timeout); resolve({ child, port: parseInt(m[1], 10) }); }
      });
      child.on("error", (err) => { clearTimeout(timeout); reject(err); });
    });
    proc = started.child;
    port = started.port;

    let queue = 0;
    const worker = async () => {
      while (queue < holders.length) {
        const [slug] = holders[queue++];
        const res = await fetch(`http://localhost:${port}/alternative-to/${slug}`);
        if (res.status !== 200) continue;
        const answer = availabilityAnswer(await res.text());
        if (answer !== null) answers.set(slug, answer);
      }
    };
    await Promise.all(Array.from({ length: 12 }, worker));
  });

  after(() => { if (proc) proc.kill(); });

  it("calls no kind of change absent from a vendor that holds one", () => {
    const wrong: string[] = [];
    let checked = 0;
    for (const [slug, vendor] of holders) {
      const answer = answers.get(slug);
      if (answer === undefined) continue;
      const kinds = negativeKinds(heldBy(vendor, changes));
      if (kinds.length === 0) continue;
      checked++;
      const absent = kindsCalledAbsent(answer, kinds);
      if (absent.length > 0) wrong.push(`/alternative-to/${slug} calls ${absent.join(", ")} absent and holds it`);
    }
    assert.ok(checked > 0, "no published answer belongs to a vendor holding a negative record, so this asserts nothing");
    assert.deepStrictEqual(wrong.slice(0, 20), [], `answers denying a kind the vendor holds:\n${wrong.slice(0, 20).join("\n")}`);
  });

  it("still says something about the records where none of them narrowed the terms", () => {
    const silent: string[] = [];
    let checked = 0;
    for (const [slug, vendor] of holders) {
      const answer = answers.get(slug);
      if (answer === undefined || !answer.startsWith("Yes, ")) continue;
      if (negativeKinds(heldBy(vendor, changes)).length > 0) continue;
      checked++;
      const beyondTheTier = answer.split(SENTENCE_BREAK).slice(1).join(" ").trim();
      if (beyondTheTier === "") silent.push(`/alternative-to/${slug}`);
    }
    assert.ok(checked > 0, "no published answer belongs to a vendor whose records are all non-negative");
    assert.deepStrictEqual(silent, [], `answers that hold records and describe none of them:\n${silent.join("\n")}`);
  });

  it("accounts for every narrowing record the vendor holds, by kind or by count", () => {
    const unaccounted: string[] = [];
    let named = 0;
    let counted = 0;
    for (const [slug, vendor] of holders) {
      const answer = answers.get(slug);
      if (answer === undefined || !answer.startsWith("Yes, ")) continue;
      const narrowing = stillNarrowing(heldBy(vendor, changes));
      if (narrowing.length === 0) continue;
      if (narrowing.length === 1) {
        named++;
        const noun = CHANGE_KIND_NOUN[narrowing[0].change_type];
        if (!answer.toLowerCase().includes(noun)) unaccounted.push(`/alternative-to/${slug} holds a ${noun} and names no kind`);
        continue;
      }
      counted++;
      if (!new RegExp(`\\b${narrowing.length}\\b`).test(answer)) {
        unaccounted.push(`/alternative-to/${slug} holds ${narrowing.length} and states no such count`);
      }
    }
    assert.ok(named > 0, "no published answer belongs to a vendor holding exactly one narrowing record");
    assert.ok(counted > 0, "no published answer belongs to a vendor holding more than one narrowing record");
    assert.deepStrictEqual(unaccounted.slice(0, 20), [], `answers that account for no record they hold:\n${unaccounted.slice(0, 20).join("\n")}`);
  });

  it("tells no vendor that holds a record that we hold none", () => {
    const wrong: string[] = [];
    let checked = 0;
    for (const [slug, vendor] of holders) {
      const answer = answers.get(slug);
      if (answer === undefined) continue;
      checked++;
      if (/No pricing changes have been recorded|no recorded pricing changes|zero pricing changes/i.test(answer)) {
        wrong.push(`/alternative-to/${slug} holds ${heldBy(vendor, changes).length} and publishes an empty history`);
      }
    }
    assert.ok(checked > 0, "no published answer belongs to a vendor holding any record");
    assert.deepStrictEqual(wrong.slice(0, 20), [], `answers publishing an empty history over records:\n${wrong.slice(0, 20).join("\n")}`);
  });

  it("reads a denial of a held kind as a denial, and the record-derived sentence as none", () => {
    const denial =
      "Yes, Neon currently offers a free tier (Free). We hold 1 recorded change for this vendor, " +
      "none of them a free tier removal, limit reduction or pricing restructure.";
    assert.deepStrictEqual(
      kindsCalledAbsent(denial, ["pricing_restructured", "limits_reduced", "free_tier_removed"]),
      ["free_tier_removed", "limits_reduced", "pricing_restructured"],
      "the rule reports no denial in a sentence that denies three kinds by name",
    );
    assert.deepStrictEqual(
      kindsCalledAbsent(denial, ["product_deprecated"]),
      [],
      "the rule reports a denial of a kind the sentence does not name",
    );

    const derived = `Yes, Neon currently offers a free tier (Free). ${narrowingSentence([
      { vendor: "Neon", change_type: "pricing_restructured", date: "2026-01-15", date_source: "announced", source_url: "https://neon.tech/pricing" },
    ] as DealChange[])}`;
    assert.match(derived, /pricing restructure narrowed the terms/);
    assert.deepStrictEqual(
      kindsCalledAbsent(derived, ["pricing_restructured"]),
      [],
      "the rule reports a denial in a sentence that names the record as held",
    );
  });
});
