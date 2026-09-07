import { describe, it } from "node:test";
import assert from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertPopulationFloor } from "./population-floor.ts";
import {
  REMOVALS_PAGES_NAME_AS_LASTING,
  lastingRemovalExamplesFor,
  prosePutsRemovalBeyondReturn,
  removalDurability,
  removalDurabilityPattern,
  removalNamedOn,
  removalReturnRateSentence,
  removalStillLasting,
  theFreeTierCameBackAfter,
} from "../dist/removal-durability.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(__dirname, "..");

type LogRecord = {
  vendor: string;
  change_type: string;
  date: string;
  summary?: string;
  resolution?: { state: string; date: string; detail?: string } | null;
};

const LOG: LogRecord[] = JSON.parse(
  readFileSync(path.join(REPO, "data", "deal_changes.json"), "utf8"),
).changes;

const removal = (vendor: string, date: string, resolution?: LogRecord["resolution"]): LogRecord => ({
  vendor,
  change_type: "free_tier_removed",
  date,
  summary: `${vendor} withdrew its free plan`,
  ...(resolution ? { resolution } : {}),
});

const reversedOn = (date: string) => ({ state: "reversed", date, detail: "The plan ladder opens at $0 again." });
const retractedOn = (date: string) => ({ state: "retracted", date, detail: "This row was our error." });

const later = (vendor: string, date: string, changeType: string): LogRecord => ({
  vendor,
  change_type: changeType,
  date,
  summary: `${vendor} record dated ${date}`,
});

describe("what makes a recorded removal one that came back", () => {
  it("reads the log's own reversal as a return", () => {
    const subject = removal("Acme", "2025-01-15", reversedOn("2026-09-06"));
    const evidence = theFreeTierCameBackAfter(subject, [subject]);
    assert.strictEqual(evidence?.basis, "resolution");
    assert.strictEqual(evidence?.date, "2026-09-06");
  });

  it("reads a later positive record on the same vendor as a return the resolution field never recorded", () => {
    const subject = removal("Acme", "2026-03-23");
    const log = [subject, later("Acme", "2026-04-12", "limits_increased")];
    const evidence = theFreeTierCameBackAfter(subject, log);
    assert.strictEqual(evidence?.basis, "later_record");
    assert.strictEqual(evidence?.date, "2026-04-12");
  });

  it("does not read a later negative record as a return", () => {
    const subject = removal("Acme", "2026-03-23");
    const log = [subject, later("Acme", "2026-04-12", "limits_reduced")];
    assert.strictEqual(theFreeTierCameBackAfter(subject, log), null);
  });

  it("does not read a positive record dated before the removal as a return", () => {
    const subject = removal("Acme", "2026-03-23");
    const log = [subject, later("Acme", "2026-01-02", "limits_increased")];
    assert.strictEqual(theFreeTierCameBackAfter(subject, log), null);
  });

  it("does not read another vendor's expansion as a return", () => {
    const subject = removal("Acme", "2026-03-23");
    const log = [subject, later("Globex", "2026-04-12", "limits_increased")];
    assert.strictEqual(theFreeTierCameBackAfter(subject, log), null);
  });

  it("counts a retracted record as neither a removal nor a return", () => {
    const subject = removal("Acme", "2026-04-13", retractedOn("2026-09-05"));
    const log = [subject, later("Acme", "2026-09-07", "limits_increased")];
    assert.strictEqual(theFreeTierCameBackAfter(subject, log), null);
    const durability = removalDurability(log);
    assert.strictEqual(durability.recorded.length, 1);
    assert.strictEqual(durability.retracted.length, 1);
    assert.strictEqual(durability.weStandBehind.length, 0);
    assert.strictEqual(durability.cameBack.length, 0);
    assert.strictEqual(durability.stillInForce.length, 0);
  });

  it("partitions every recorded removal into exactly one of retracted, came back, still in force", () => {
    const durability = removalDurability(LOG);
    assert.strictEqual(
      durability.retracted.length + durability.cameBack.length + durability.stillInForce.length,
      durability.recorded.length,
    );
    assert.strictEqual(durability.weStandBehind.length, durability.cameBack.length + durability.stillInForce.length);
  });
});

describe("the sentences the report builds from that partition", () => {
  it("names every vendor whose removal came back", () => {
    const durability = removalDurability(LOG);
    assertPopulationFloor(durability.cameBack.length, 1, "recorded removals the log says came back");
    const sentence = removalReturnRateSentence(durability);
    for (const returned of durability.cameBack) {
      assert.ok(sentence.includes(returned.removal.vendor), `${returned.removal.vendor} missing from: ${sentence}`);
    }
  });

  it("states the count against the population it was counted in", () => {
    const durability = removalDurability(LOG);
    const sentence = removalReturnRateSentence(durability);
    assert.ok(sentence.includes(String(durability.cameBack.length)), sentence);
    assert.ok(sentence.includes(String(durability.weStandBehind.length)), sentence);
  });

  it("asserts no permanence, on today's log and on a log where nothing has come back", () => {
    const durability = removalDurability(LOG);
    const examples = lastingRemovalExamplesFor("/state-of-free-tiers", LOG);
    assert.strictEqual(prosePutsRemovalBeyondReturn(removalReturnRateSentence(durability)), false);
    assert.strictEqual(prosePutsRemovalBeyondReturn(removalDurabilityPattern(durability, examples)), false);

    const nothingCameBack = removalDurability([removal("Acme", "2025-01-15")]);
    assert.strictEqual(nothingCameBack.cameBack.length, 0);
    assert.strictEqual(prosePutsRemovalBeyondReturn(removalReturnRateSentence(nothingCameBack)), false);
    assert.strictEqual(prosePutsRemovalBeyondReturn(removalDurabilityPattern(nothingCameBack, [])), false);
  });

  it("reads the sentences this page published before as claims of permanence", () => {
    assert.strictEqual(
      prosePutsRemovalBeyondReturn(
        "87 free tiers completely removed — Heroku, PlanetScale, SendGrid, Brave Search API, X API, and more. Once removed, none have returned.",
      ),
      true,
    );
    assert.strictEqual(
      prosePutsRemovalBeyondReturn(
        "Key pattern: Once a free tier is removed, it never comes back. Heroku (2022), PlanetScale (2024) — all permanent.",
      ),
      true,
    );
  });

  it("does not read a vendor's own trial-versus-free wording as a claim of permanence", () => {
    for (const stored of [
      "No permanent free tier, 45-day trial only",
      "Permanent free tier removed, only 7-day trial. Basic $15/month",
      "Oracle Cloud's Always Free tier is permanently free (not time-limited)",
      "SendGrid permanently removed its free tier on May 27, 2025",
    ]) {
      assert.strictEqual(prosePutsRemovalBeyondReturn(stored), false, stored);
    }
  });
});

describe("the vendors our pages name as removals that lasted", () => {
  it("names at least one on each page that names any", () => {
    const routes = [...new Set(REMOVALS_PAGES_NAME_AS_LASTING.map((named) => named.route))];
    assertPopulationFloor(routes.length, 1, "pages naming a removal as lasting");
    for (const route of routes) {
      assert.ok(lastingRemovalExamplesFor(route, LOG).length > 0, `${route} has no example left to name`);
    }
  });

  it("holds a removal record for every vendor it names", () => {
    for (const named of REMOVALS_PAGES_NAME_AS_LASTING) {
      assert.ok(removalNamedOn(named.vendor, LOG), `${named.route} names ${named.vendor}, which has no removal record`);
    }
  });

  it("names no vendor carrying a resolution or a later positive record", () => {
    const durability = removalDurability(LOG);
    const cameBack = new Set(durability.cameBack.map((r) => r.removal.vendor));
    const retracted = new Set(durability.retracted.map((r) => r.vendor));
    for (const named of REMOVALS_PAGES_NAME_AS_LASTING) {
      assert.ok(!cameBack.has(named.vendor), `${named.route} names ${named.vendor}, whose free tier came back`);
      assert.ok(!retracted.has(named.vendor), `${named.route} names ${named.vendor}, whose removal we retracted`);
    }
  });

  it("will not name a vendor whose second removal came back, however the first one ended", () => {
    const log = [
      removal("Acme", "2024-01-10"),
      removal("Acme", "2026-04-13", reversedOn("2026-09-06")),
    ];
    assert.strictEqual(removalStillLasting("Acme", log), null);
    assert.strictEqual(removalStillLasting("Acme", [log[0]!])?.year, "2024");
  });

  it("drops a named vendor from the report as soon as its removal is reversed", () => {
    const named = REMOVALS_PAGES_NAME_AS_LASTING.find((n) => n.route === "/state-of-free-tiers")!;
    const reversed = LOG.map((c) =>
      c.vendor === named.vendor && c.change_type === "free_tier_removed"
        ? { ...c, resolution: reversedOn("2026-09-08") }
        : c,
    );
    const examples = lastingRemovalExamplesFor("/state-of-free-tiers", reversed);
    assert.ok(!examples.some((e) => e.vendor === named.vendor), `${named.vendor} is still named as lasting`);
    assert.ok(
      removalReturnRateSentence(removalDurability(reversed)).includes(named.vendor),
      `${named.vendor} is not named among the returns`,
    );
  });
});

function startServer(changesPath: string | null): Promise<{ proc: ChildProcess; port: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn("node", [path.join(REPO, "dist", "serve.js")], {
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        PORT: "0",
        BASE_URL: "http://localhost:3000",
        ...(changesPath ? { AGENTDEALS_CHANGES_PATH: changesPath } : {}),
      },
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

function visibleText(body: string): string {
  return body
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&mdash;/g, "—")
    .replace(/&ndash;/g, "–")
    .replace(/&nbsp;/g, " ")
    .replace(/&rsquo;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ");
}

async function routesInSitemap(base: string): Promise<string[]> {
  const index = await (await fetch(`${base}/sitemap.xml`)).text();
  const routes = new Set<string>();
  for (const entry of index.matchAll(/<loc>([^<]+)<\/loc>/g)) {
    const at = new URL(entry[1]).pathname;
    if (!/sitemap.*\.xml$/.test(at)) {
      routes.add(at);
      continue;
    }
    const nested = await (await fetch(`${base}${at}`)).text();
    for (const page of nested.matchAll(/<loc>([^<]+)<\/loc>/g)) routes.add(new URL(page[1]).pathname);
  }
  return [...routes].sort();
}

function sentences(text: string): string[] {
  return text.split(/(?<=[.!?])\s+/);
}

function claimsOfPermanence(text: string): string[] {
  return sentences(text).filter((sentence) => prosePutsRemovalBeyondReturn(sentence));
}

function sentenceStatingRemovalsHeld(text: string, held: number, standBehind: number): string {
  const found = sentences(text).find((sentence) => sentence.includes(`${held} of the ${standBehind} removals`));
  assert.ok(found, `no sentence states that ${held} of ${standBehind} removals are still in force`);
  return found;
}

describe("no page tells a reader a removed free tier cannot return", () => {
  it("finds none on any page in the sitemap, while the log holds removals that came back", async () => {
    assertPopulationFloor(
      removalDurability(LOG).cameBack.length,
      1,
      "removals in the published log that came back, without which this property is vacuous",
    );
    const { proc, port } = await startServer(null);
    try {
      const base = `http://localhost:${port}`;
      const routes = await routesInSitemap(base);
      assertPopulationFloor(routes.length, 400, "routes in the sitemap this scan reads");
      const offenders: string[] = [];
      for (const route of routes) {
        const response = await fetch(`${base}${route}`);
        if (!response.ok) continue;
        for (const claim of claimsOfPermanence(visibleText(await response.text()))) {
          offenders.push(`${route}: ${claim.slice(0, 200)}`);
        }
      }
      assert.deepStrictEqual(offenders, []);

      const durability = removalDurability(LOG);
      const report = visibleText(await (await fetch(`${base}/state-of-free-tiers`)).text());
      const held = sentenceStatingRemovalsHeld(report, durability.stillInForce.length, durability.weStandBehind.length);
      for (const example of lastingRemovalExamplesFor("/state-of-free-tiers", LOG)) {
        assert.ok(held.includes(example.vendor), `${example.vendor} lasted and the report does not name it: ${held}`);
      }
      for (const returned of durability.cameBack) {
        assert.ok(report.includes(returned.removal.vendor), `${returned.removal.vendor} came back and the report is silent`);
      }
    } finally {
      proc.kill();
    }
  });

  it("finds none when a fifth removal is reversed, and moves the published figures with it", async () => {
    const standing = removalDurability(LOG).stillInForce.find(
      (r) => !REMOVALS_PAGES_NAME_AS_LASTING.some((named) => named.vendor === r.vendor),
    )!;
    const before = removalDurability(LOG);
    const reversed = LOG.map((c) =>
      c.vendor === standing.vendor && c.change_type === "free_tier_removed" && c.date === standing.date
        ? { ...c, resolution: reversedOn("2026-09-08") }
        : c,
    );
    const after = removalDurability(reversed);
    assert.strictEqual(after.cameBack.length, before.cameBack.length + 1);

    const dir = mkdtempSync(path.join(tmpdir(), "removal-durability-"));
    const changesPath = path.join(dir, "deal_changes.json");
    writeFileSync(changesPath, JSON.stringify({ changes: reversed }));
    const { proc, port } = await startServer(changesPath);
    try {
      const body = await (await fetch(`http://localhost:${port}/state-of-free-tiers`)).text();
      const text = visibleText(body);
      assert.deepStrictEqual(claimsOfPermanence(text), []);
      assert.ok(
        text.includes(`${after.cameBack.length} of the ${after.weStandBehind.length} removals we stand behind`),
        `the page did not publish ${after.cameBack.length} of ${after.weStandBehind.length}`,
      );
      assert.ok(text.includes(standing.vendor), `${standing.vendor} came back and the page does not say so`);
      assert.ok(
        !text.includes(`${before.cameBack.length} of the ${before.weStandBehind.length} removals we stand behind`),
        "the page published the figure from before the reversal",
      );
    } finally {
      proc.kill();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("stops naming a vendor as a removal that lasted once the log says it came back", async () => {
    const named = REMOVALS_PAGES_NAME_AS_LASTING.find((n) => n.route === "/state-of-free-tiers")!;
    const reversed = LOG.map((c) =>
      c.vendor === named.vendor && c.change_type === "free_tier_removed"
        ? { ...c, resolution: reversedOn("2026-09-08") }
        : c,
    );
    const after = removalDurability(reversed);

    const dir = mkdtempSync(path.join(tmpdir(), "removal-durability-named-"));
    const changesPath = path.join(dir, "deal_changes.json");
    writeFileSync(changesPath, JSON.stringify({ changes: reversed }));
    const { proc, port } = await startServer(changesPath);
    try {
      const text = visibleText(await (await fetch(`http://localhost:${port}/state-of-free-tiers`)).text());
      assert.deepStrictEqual(claimsOfPermanence(text), []);
      const held = sentenceStatingRemovalsHeld(text, after.stillInForce.length, after.weStandBehind.length);
      assert.ok(!held.includes(named.vendor), `${named.vendor} came back and is still named as lasting: ${held}`);
      for (const example of lastingRemovalExamplesFor("/state-of-free-tiers", reversed)) {
        assert.ok(held.includes(example.vendor), `${example.vendor} lasted and the report does not name it: ${held}`);
      }
    } finally {
      proc.kill();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
