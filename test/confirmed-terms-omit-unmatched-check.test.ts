import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Offer } from "../src/types.ts";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const { toSlug } = await import("../dist/slug.js");
const { CHECK_FINDING_CLASS } = await import("../dist/source-citation.js");
const catalogue = JSON.parse(readFileSync(path.join(ROOT, "data/index.json"), "utf8"));
const offers: Offer[] = catalogue.offers;
const state = JSON.parse(readFileSync(path.join(ROOT, "data/verification_state.json"), "utf8"));
const UNMATCHED = " and states amounts, none of which we matched to the terms we publish";
const escape = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

interface Server { child: ChildProcess; base: string }

async function start(env: Record<string, string> = {}): Promise<Server> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(ROOT, "dist/serve.js")], {
      env: { ...process.env, PORT: "0", BASE_URL: "http://localhost", ...env },
      stdio: ["ignore", "ignore", "pipe"],
    });
    let log = "";
    const timer = setTimeout(() => { child.kill(); reject(new Error(`Server startup timeout: ${log}`)); }, 60000);
    child.stderr!.on("data", data => {
      log += data.toString();
      const port = /running on http:\/\/localhost:(\d+)/.exec(log)?.[1];
      if (port) { clearTimeout(timer); resolve({ child, base: `http://localhost:${port}` }); }
    });
    child.once("error", error => { clearTimeout(timer); reject(error); });
    child.once("exit", code => { clearTimeout(timer); reject(new Error(`Server exited ${code}: ${log}`)); });
  });
}

async function get(server: Server, route: string): Promise<string> {
  const response = await fetch(server.base + route);
  const body = await response.text();
  assert.equal(response.status, 200, `${route}: ${body.slice(0, 200)}`);
  return body;
}

function sourceLine(html: string): string {
  return /<p class="free-tier-source-line"[^>]*>[\s\S]*?<\/p>/.exec(html)?.[0] ?? "";
}

describe("vendor source findings after a confirming re-read", () => {
  let server: Server;
  before(async () => { server = await start(); });
  after(() => { server?.child.kill(); });

  for (const slug of ["cloudflare-pages", "groq"]) {
    it(`omits the unmatched amounts warning on /vendor/${slug}`, async () => {
      const offer = offers.find(offer => toSlug(offer.vendor) === slug)!;
      const record = state.records.find((record: any) => record.vendor === offer.vendor && record.url === offer.url);
      assert.equal(record.last_outcome, "confirmed");
      const html = await get(server, `/vendor/${slug}`);
      assert.doesNotMatch(html, /none of which we matched|could not compare/);
      const line = sourceLine(html);
      assert.ok(line.includes(escape(offer.url)), line);
      assert.ok(line.includes(offer.source_check!.checked), line);
    });
  }

  for (const [slug, outcome] of [["hetzner", "changed"], ["mergify", "unclear"]]) {
    it(`retains the finding after the ${outcome} read on /vendor/${slug}`, async () => {
      const offer = offers.find(offer => toSlug(offer.vendor) === slug)!;
      const record = state.records.find((record: any) => record.vendor === offer.vendor && record.url === offer.url);
      assert.equal(record.last_outcome, outcome);
      const line = sourceLine(await get(server, `/vendor/${slug}`));
      if (line) assert.ok(line.includes(escape(offer.source_check!.detail!)), line);
      else {
        const { unconfirmedTermsForOffer } = await import("../dist/vendor-verdict-input.js");
        assert.ok(unconfirmedTermsForOffer(offer), `${slug} must retain its separate withholding reason`);
      }
    });
  }

  it("keeps every stored check detail in the details API", async () => {
    for (const slug of ["cloudflare-pages", "groq", "hetzner", "mergify"]) {
      const offer = offers.find(offer => toSlug(offer.vendor) === slug)!;
      const body = JSON.parse(await get(server, `/api/details/${slug}`));
      assert.deepEqual(body.offer.source_check, offer.source_check, slug);
    }
  });
});

describe("the latest outcome belongs to the exact listing", () => {
  let server: Server;
  let scratch: string;
  const fixtures: Array<{ vendor: string; url: string; outcome: string | null; finding: string; omit: boolean }> = [];
  before(async () => {
    scratch = mkdtempSync(path.join(tmpdir(), "confirmed-source-finding-"));
    const index = structuredClone(catalogue);
    const records = structuredClone(state.records);
    for (const [at, outcome] of ["confirmed", "changed", "unclear", "fetch_failed", "link_ok", "states_no_price", null, "missing"].entries()) {
      for (const matched of [false, true]) {
        const vendor = `Source Finding ${at} ${matched ? "Matched" : "Unmatched"}`;
        const url = `https://source-finding-${at}-${matched}.example/pricing`;
        const finding = `the page names ${vendor} as "source finding"${matched ? ' and states "500 builds per month"' : UNMATCHED}`;
        const offer = { ...structuredClone(offers.find(offer => offer.vendor === "Cloudflare Pages")!), vendor, url,
          source_check: { checked: "2026-10-30", outcome: "ok", detail: finding } };
        index.offers.push(offer);
        if (outcome !== "missing") records.push({ vendor, url, last_attempt_at: "2026-11-15", last_outcome: outcome,
          last_success: "2026-10-30", last_read_at: "2026-11-15", consecutive_failures: 0, failure_category: null, last_error: null, quarantined_since: null });
        records.push({ vendor, url: `${url}/other`, last_attempt_at: "2026-11-15", last_outcome: "confirmed",
          last_success: "2026-11-15", last_read_at: "2026-11-15", consecutive_failures: 0, failure_category: null, last_error: null, quarantined_since: null });
        fixtures.push({ vendor, url, outcome, finding, omit: outcome === "confirmed" && !matched });
      }
    }
    writeFileSync(path.join(scratch, "index.json"), JSON.stringify(index));
    writeFileSync(path.join(scratch, "state.json"), JSON.stringify({ ...state, records }));
    server = await start({ AGENTDEALS_INDEX_PATH: path.join(scratch, "index.json"), AGENTDEALS_VERIFICATION_STATE_PATH: path.join(scratch, "state.json") });
  });
  after(() => { server?.child.kill(); if (scratch) rmSync(scratch, { recursive: true, force: true }); });

  it("omits only unmatched findings with a latest confirmed outcome, including when older confirmations and sibling listings exist", async () => {
    for (const fixture of fixtures) {
      const route = `/vendor/${toSlug(fixture.vendor)}`;
      const html = await get(server, route);
      const line = sourceLine(html);
      assert.ok(line.includes(escape(fixture.url)), route);
      assert.equal(line.includes(`class="${CHECK_FINDING_CLASS}"`), !fixture.omit, route);
      assert.equal(line.includes(escape(fixture.finding)), !fixture.omit, route);
      const api = JSON.parse(await get(server, `/api/details/${toSlug(fixture.vendor)}`));
      assert.equal(api.offer.source_check.detail, fixture.finding, route);
    }
  });
});
