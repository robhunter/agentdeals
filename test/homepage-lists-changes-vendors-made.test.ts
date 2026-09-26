import { describe, it } from "node:test";
import assert from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(__dirname, "..");
const LOG: Record<string, unknown>[] = JSON.parse(readFileSync(path.join(REPO, "data", "deal_changes.json"), "utf8")).changes;
const CATALOGUE: { vendor: string; category: string }[] = JSON.parse(
  readFileSync(path.join(REPO, "data", "index.json"), "utf8"),
).offers;

function startServer(changesPath: string | null): Promise<{ proc: ChildProcess; base: string }> {
  return new Promise((resolve, reject) => {
    const proc = spawn("node", [path.join(REPO, "dist", "serve.js")], {
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        PORT: "0",
        BASE_URL: "http://localhost:3000",
        ...(changesPath ? { AGENTDEALS_CHANGES_PATH: changesPath } : {}),
      },
    });
    const timeout = setTimeout(() => {
      proc.kill();
      reject(new Error("Server startup timeout"));
    }, 40000);
    proc.stderr!.on("data", (data: Buffer) => {
      const m = data.toString().match(/running on http:\/\/localhost:(\d+)/);
      if (m) {
        clearTimeout(timeout);
        resolve({ proc, base: `http://localhost:${m[1]}` });
      }
    });
    proc.on("error", (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });
}

function dayOffset(days: number): string {
  return new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
}

function section(home: string, id: string, { required = true } = {}): string {
  const start = home.indexOf(`id="${id}"`);
  if (start < 0 && !required) return "";
  assert.ok(start >= 0, `the home page has no #${id} section`);
  const end = home.indexOf('class="see-all-link"', start);
  assert.ok(end > start, `the #${id} section has no closing link`);
  return home
    .slice(start, end)
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function badgesIn(html: string): string[] {
  return [...html.matchAll(/<span class="change-badge"[^>]*>([^<]*)<\/span>/g)].map(([, label]) => label);
}

function summariesOf(records: Record<string, unknown>[]): string[] {
  return records.map((record) => String(record.summary));
}

describe("the home page lists changes the vendors made", () => {
  it("puts a vendor's change on the home page and leaves out our own corrections and retractions", async () => {
    const [corrected, retracted, changed, retractedAhead, changingAhead] = CATALOGUE.slice(0, 5);
    const today = dayOffset(0);
    const tomorrow = dayOffset(1);
    const record = (offer: { vendor: string; category: string }, fields: Record<string, unknown>) => ({
      vendor: offer.vendor,
      category: offer.category,
      previous_state: "Before the change",
      current_state: "After the change",
      impact: "medium",
      source_url: "https://example.com/pricing",
      alternatives: [],
      recorded_date: today,
      date_source: "hand_written",
      ...fields,
    });
    const retraction = { state: "retracted", date: today, detail: `Retracted ${today}: the change did not happen.` };
    const ours = [
      record(corrected, { change_type: "record_corrected", date: today, summary: "Data correction - a record of ours had the wrong figure." }),
      record(retracted, { change_type: "limits_reduced", date: today, summary: "A reduction we recorded and later retracted.", resolution: retraction }),
      record(retractedAhead, { change_type: "free_tier_removed", date: tomorrow, summary: "A removal we dated ahead and later retracted.", resolution: retraction }),
    ];
    const theirs = [
      record(changed, { change_type: "limits_reduced", date: today, summary: "The vendor halved its free allowance." }),
      record(changingAhead, { change_type: "free_tier_removed", date: tomorrow, summary: "The vendor ends its free plan tomorrow." }),
    ];

    const dir = mkdtempSync(path.join(tmpdir(), "homepage-vendor-changes-"));
    const changesPath = path.join(dir, "deal_changes.json");
    writeFileSync(changesPath, JSON.stringify({ changes: [...ours, ...theirs, ...LOG] }));
    const { proc, base } = await startServer(changesPath);
    try {
      const home = await (await fetch(`${base}/`)).text();
      const recent = section(home, "recent-changes");
      const soon = section(home, "changing-soon");
      assert.ok(recent.includes(summariesOf(theirs)[0]), "the vendor's change today is missing from Recent pricing changes");
      assert.ok(soon.includes(summariesOf(theirs)[1]), "the vendor's change tomorrow is missing from Changing Soon");
      for (const summary of summariesOf(ours)) {
        assert.ok(!recent.includes(summary), `Recent pricing changes lists a record of our own: ${summary}`);
        assert.ok(!soon.includes(summary), `Changing Soon lists a record of our own: ${summary}`);
      }
      assert.deepStrictEqual(badgesIn(recent).filter((label) => label === "corrected"), []);
    } finally {
      proc.kill();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("shows none of our corrections or retracted records among the home page's changes today", async () => {
    const ours = LOG.filter(
      (c) => c.change_type === "record_corrected" || (c.resolution as { state?: string } | undefined)?.state === "retracted",
    );
    const { proc, base } = await startServer(null);
    try {
      const home = await (await fetch(`${base}/`)).text();
      const listed = section(home, "recent-changes") + section(home, "changing-soon", { required: false });
      assert.deepStrictEqual(badgesIn(listed).filter((label) => label === "corrected"), []);
      assert.deepStrictEqual(
        summariesOf(ours).filter((summary) => listed.includes(summary)),
        [],
        "the home page lists a correction or a retracted record as a vendor's change",
      );
    } finally {
      proc.kill();
    }
  });
});
