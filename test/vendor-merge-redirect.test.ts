import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  comparisonSlugTargets,
  declaredMergeSlugs,
  retiredSlugTargets,
  selfComparisonSlug,
  survivingVendorName,
  vendorMerges,
} from "../dist/vendor-merges.js";
import { toSlug } from "../dist/slug.js";

type Offer = import("../src/types.ts").Offer;
type DealChange = import("../src/types.ts").DealChange;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(__dirname, "..");

const offers: Offer[] = JSON.parse(fs.readFileSync(path.join(REPO, "data", "index.json"), "utf-8")).offers;
const changes: DealChange[] = JSON.parse(fs.readFileSync(path.join(REPO, "data", "deal_changes.json"), "utf-8")).changes;
const merges = vendorMerges();

const retiringNames = new Set(merges.map((m) => m.retired.trim().toLowerCase()));
const liveNames = new Set(offers.map((o) => o.vendor.trim().toLowerCase()));
const stillListed = merges.filter((m) => liveNames.has(m.retired.trim().toLowerCase()));

function startServer(env: NodeJS.ProcessEnv = {}): Promise<{ child: ChildProcess; port: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn("node", [path.join(REPO, "dist", "serve.js")], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, PORT: "0", BASE_URL: "http://localhost", TZ: "UTC", ...env },
    });
    const timeout = setTimeout(() => { child.kill(); reject(new Error("Server startup timeout")); }, 60000);
    child.stderr!.on("data", (data: Buffer) => {
      const m = data.toString().match(/running on http:\/\/localhost:(\d+)/);
      if (m) { clearTimeout(timeout); resolve({ child, port: parseInt(m[1], 10) }); }
    });
    child.on("error", (e) => { clearTimeout(timeout); reject(e); });
  });
}

const textOf = (html: string) => html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ");

describe("the registry a merge is declared in", () => {
  it("declares a slug for every merge", () => {
    const declared = declaredMergeSlugs(merges);
    assert.strictEqual(declared.size, merges.length);
    for (const merge of merges) {
      assert.strictEqual(declared.get(toSlug(merge.retired)), toSlug(merge.survivor));
    }
  });

  it("redirects no slug while the record it names is still listed", () => {
    const targets = retiredSlugTargets(new Set(offers.map((o) => toSlug(o.vendor))), merges);
    for (const merge of stillListed) {
      assert.ok(!targets.has(toSlug(merge.retired)), `/vendor/${toSlug(merge.retired)} redirects while its record is still listed`);
    }
  });

  it("redirects a slug the moment its record leaves the catalogue", () => {
    const kept = offers.filter((o) => !retiringNames.has(o.vendor.trim().toLowerCase()));
    const targets = retiredSlugTargets(new Set(kept.map((o) => toSlug(o.vendor))), merges);
    for (const merge of merges) {
      assert.strictEqual(targets.get(toSlug(merge.retired)), toSlug(merge.survivor), `${merge.retired} does not redirect once it leaves the catalogue`);
    }
  });

  it("redirects nothing into a slug the catalogue does not answer", () => {
    const targets = retiredSlugTargets(new Set<string>(), merges);
    assert.strictEqual(targets.size, 0);
  });

  it("moves a change record to the survivor only once the name it holds is unlisted", () => {
    for (const merge of merges) {
      assert.strictEqual(survivingVendorName(merge.retired, liveNames, merges), null);
      const without = new Set([...liveNames].filter((n) => n !== merge.retired.trim().toLowerCase()));
      assert.strictEqual(survivingVendorName(merge.retired, without, merges), merge.survivor);
    }
  });

  it("leaves a name no merge names alone", () => {
    assert.strictEqual(survivingVendorName("Vercel", new Set(["vercel"]), merges), null);
    assert.strictEqual(survivingVendorName("Vercel", new Set<string>(), merges), null);
  });

  it("moves a change record to no name when the catalogue carries neither side", () => {
    for (const merge of merges) {
      assert.strictEqual(
        survivingVendorName(merge.retired, new Set<string>(), merges),
        null,
        `${merge.retired} moves its history to ${merge.survivor}, which the catalogue does not carry`,
      );
    }
  });

  it("sends a comparison to a record the catalogue answers for, and to nothing else", () => {
    const live = new Set(offers.map((o) => toSlug(o.vendor)));
    const targets = comparisonSlugTargets(live, merges);
    for (const merge of merges) {
      assert.strictEqual(targets.get(toSlug(merge.retired)), toSlug(merge.survivor));
    }
    for (const [from, to] of targets) {
      assert.ok(live.has(to), `/compare sends ${from} to a page the catalogue does not answer`);
    }
  });

  it("sends a comparison nowhere when the record that survives a merge is gone too", () => {
    for (const merge of merges) {
      const onlyRetired = new Set([toSlug(merge.retired)]);
      assert.strictEqual(
        comparisonSlugTargets(onlyRetired, merges).get(toSlug(merge.retired)),
        toSlug(merge.retired),
        `${merge.retired} is sent to ${merge.survivor}, which the catalogue does not answer for`,
      );
    }
  });
});

describe("reading a comparison slug as one record", () => {
  const canonical = (part: string) => (part === "arize-ai" ? "arize-ax" : part === "arize-ax" ? "arize-ax" : part === "vercel" ? "vercel" : null);

  it("names the record when both sides land on it", () => {
    assert.strictEqual(selfComparisonSlug("arize-ai-vs-arize-ax", canonical), "arize-ax");
    assert.strictEqual(selfComparisonSlug("arize-ax-vs-arize-ai", canonical), "arize-ax");
  });

  it("names nothing when the two sides are two records", () => {
    assert.strictEqual(selfComparisonSlug("arize-ax-vs-vercel", canonical), null);
  });

  it("names nothing when a side names no record", () => {
    assert.strictEqual(selfComparisonSlug("arize-ax-vs-nobody", canonical), null);
    assert.strictEqual(selfComparisonSlug("arize-ax", canonical), null);
  });

  it("reads past a split that resolves nothing", () => {
    const withHyphen = (part: string) => (part === "a-vs-b" || part === "c" ? "one" : null);
    assert.strictEqual(selfComparisonSlug("a-vs-b-vs-c", withHyphen), "one");
  });
});

describe("the catalogue as it stands", () => {
  let server: ChildProcess;
  let port = 0;

  before(async () => { ({ child: server, port } = await startServer()); });
  after(() => { server?.kill(); });

  it("has records under merge, so the redirects here are under test", () => {
    assert.ok(stillListed.length > 0, "every registered merge has already been made, so nothing here is under test");
  });

  it("keeps answering a page for a record it still lists", async () => {
    for (const merge of stillListed) {
      const res = await fetch(`http://localhost:${port}/vendor/${toSlug(merge.retired)}`, { redirect: "manual" });
      assert.strictEqual(res.status, 200, `/vendor/${toSlug(merge.retired)} answers ${res.status} while its record is still listed`);
    }
  });

  it("sends a comparison of a record with itself to that record", async () => {
    for (const merge of merges) {
      const slug = `${toSlug(merge.retired)}-vs-${toSlug(merge.survivor)}`;
      const res = await fetch(`http://localhost:${port}/compare/${slug}`, { redirect: "manual" });
      assert.strictEqual(res.status, 301, `/compare/${slug} answers ${res.status} rather than sending the reader to one record`);
      assert.strictEqual(res.headers.get("location"), `/vendor/${toSlug(merge.survivor)}`);
      const followed = await fetch(`http://localhost:${port}${res.headers.get("location")}`, { redirect: "manual" });
      assert.strictEqual(followed.status, 200, `/compare/${slug} redirects to a path that answers ${followed.status}`);
    }
  });

  it("leaves the history of a record it still lists on that record's own page", async () => {
    for (const merge of stillListed) {
      const carried = changes.filter((c) => c.vendor.trim().toLowerCase() === merge.retired.trim().toLowerCase());
      if (carried.length === 0) continue;
      const res = await fetch(`http://localhost:${port}/api/changes?vendor=${encodeURIComponent(merge.retired)}&since=2000-01-01&limit=1000`);
      const published: DealChange[] = (await res.json()).changes;
      for (const change of carried) {
        assert.ok(
          published.some((p) => p.vendor === merge.retired && p.date === change.date),
          `the ${change.change_type} recorded for ${merge.retired} on ${change.date} moved before its record did`,
        );
      }
    }
  });

  it("publishes no verdict comparing a record with itself", async () => {
    for (const merge of merges) {
      const slug = `${toSlug(merge.retired)}-vs-${toSlug(merge.survivor)}`;
      const html = await (await fetch(`http://localhost:${port}/compare/${slug}`)).text();
      assert.ok(
        !textOf(html).includes(`Both ${merge.retired} and ${merge.survivor} offer free tiers`),
        `/compare/${slug} still compares one record with itself`,
      );
    }
  });

  it("still compares two records", async () => {
    const res = await fetch(`http://localhost:${port}/compare/netlify-vs-vercel`, { redirect: "manual" });
    assert.strictEqual(res.status, 200);
    assert.match(textOf(await res.text()), /Netlify/);
  });
});

describe("the catalogue once every merge is made", () => {
  const mergedIndex = path.join(os.tmpdir(), `catalogue-after-vendor-merges-${process.pid}.json`);
  let server: ChildProcess;
  let port = 0;

  before(async () => {
    const kept = offers.filter((o) => !retiringNames.has(o.vendor.trim().toLowerCase()));
    assert.strictEqual(kept.length, offers.length - stillListed.length, "the catalogue under test did not lose one record per merge");
    fs.writeFileSync(mergedIndex, JSON.stringify({ offers: kept }));
    ({ child: server, port } = await startServer({ AGENTDEALS_INDEX_PATH: mergedIndex }));
  });

  after(() => {
    server?.kill();
    fs.rmSync(mergedIndex, { force: true });
  });

  it("sends every retired path to the record that survives it", async () => {
    for (const merge of merges) {
      const res = await fetch(`http://localhost:${port}/vendor/${toSlug(merge.retired)}`, { redirect: "manual" });
      assert.strictEqual(res.status, 301, `/vendor/${toSlug(merge.retired)} answers ${res.status} once its record is gone`);
      assert.strictEqual(res.headers.get("location"), `/vendor/${toSlug(merge.survivor)}`);
      const followed = await fetch(`http://localhost:${port}${res.headers.get("location")}`, { redirect: "manual" });
      assert.strictEqual(followed.status, 200, `${merge.retired} redirects to a path that answers ${followed.status}`);
    }
  });

  it("drops every retired path from the vendor sitemap and keeps every survivor in it", async () => {
    const sitemap = await (await fetch(`http://localhost:${port}/sitemap-vendors.xml`)).text();
    for (const merge of merges) {
      assert.ok(!sitemap.includes(`/vendor/${toSlug(merge.retired)}<`), `${merge.retired} is still submitted for indexing`);
      assert.ok(sitemap.includes(`/vendor/${toSlug(merge.survivor)}<`), `${merge.survivor} left the sitemap with the record it absorbed`);
    }
  });

  it("still sends a comparison of a record with itself to that record", async () => {
    for (const merge of merges) {
      const slug = `${toSlug(merge.retired)}-vs-${toSlug(merge.survivor)}`;
      const res = await fetch(`http://localhost:${port}/compare/${slug}`, { redirect: "manual" });
      assert.strictEqual(res.status, 301, `/compare/${slug} answers ${res.status} once one of its two records is gone`);
      assert.strictEqual(res.headers.get("location"), `/vendor/${toSlug(merge.survivor)}`);
    }
  });

  it("sends a comparison naming a retired record to the same comparison naming the survivor", async () => {
    const others = ["supabase", "vercel"];
    for (const merge of merges) {
      for (const other of others) {
        if (toSlug(merge.survivor) === other) continue;
        const slug = [toSlug(merge.retired), other].sort().join("-vs-");
        const res = await fetch(`http://localhost:${port}/compare/${slug}`, { redirect: "manual" });
        assert.strictEqual(res.status, 301, `/compare/${slug} answers ${res.status} once ${merge.retired} leaves the catalogue`);
        const location = res.headers.get("location")!;
        assert.strictEqual(location, `/compare/${[toSlug(merge.survivor), other].sort().join("-vs-")}`);
        const followed = await fetch(`http://localhost:${port}${location}`, { redirect: "manual" });
        assert.strictEqual(followed.status, 200, `${slug} redirects to a path that answers ${followed.status}`);
      }
    }
  });

  it("has history recorded under a retiring name, so the carry-over here is under test", () => {
    const carried = merges.filter((m) => changes.some((c) => c.vendor.trim().toLowerCase() === m.retired.trim().toLowerCase()));
    assert.ok(carried.length > 0, "no change is recorded under a retiring name, so nothing here is under test");
  });

  it("publishes every change recorded under a retiring name on the record that survives it", async () => {
    for (const merge of merges) {
      const carried = changes.filter((c) => c.vendor.trim().toLowerCase() === merge.retired.trim().toLowerCase());
      if (carried.length === 0) continue;
      const res = await fetch(`http://localhost:${port}/api/changes?vendor=${encodeURIComponent(merge.survivor)}&since=2000-01-01&limit=1000`);
      const published: DealChange[] = (await res.json()).changes;
      for (const change of carried) {
        assert.ok(
          published.some((p) => p.date === change.date && p.change_type === change.change_type),
          `the ${change.change_type} recorded for ${merge.retired} on ${change.date} is published on no page`,
        );
      }
    }
  });

  it("answers no free-tier history question with an empty history the merge filled", async () => {
    for (const merge of merges) {
      if (!changes.some((c) => c.vendor.trim().toLowerCase() === merge.retired.trim().toLowerCase())) continue;
      const html = await (await fetch(`http://localhost:${port}/vendor/${toSlug(merge.survivor)}`)).text();
      assert.ok(
        !/no recorded pricing changes/i.test(textOf(html)),
        `/vendor/${toSlug(merge.survivor)} reads its history as empty after absorbing ${merge.retired}`,
      );
    }
  });
});
