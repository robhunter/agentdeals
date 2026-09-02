import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const { gateFor, utcDate, GATE_TABLE } = await import("../dist/ranking.js");
const { gateClauseList, gateDisclosureSentence, matchingSubject } = await import("../dist/gate-disclosure.js");

type Offer = import("../src/types.ts").Offer;
type Gate = { code: string; reason: string } | null;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(__dirname, "..");

const offers: Offer[] = JSON.parse(readFileSync(path.join(REPO, "data", "index.json"), "utf-8")).offers;
const TODAY = utcDate();

const CATALOG_SIZE = offers.length;
const MOST_OF_THE_CATALOG = 0.8;

const NOT_RATED_CLAUSE = "We do not rate an offer we do not list.";
const ENDED_VERDICT = "This offer has ended — we keep the page for the record and no longer rate it.";
const STABLE_HISTORY = "has a stable pricing history.";

const UNREAD_CITATION_FORMS = [
  /^.+'s pricing page has not resolved for us( since \d{4}-\d{2}-\d{2})?\.$/,
  /^The page we cite for .+ does not name it\.$/,
  /^The page we cite for .+ states no terms we can read\.$/,
  /^We could not read the page we cite for .+\.$/,
];

function gateSummaryShape(summary: string, gate: { code: string; reason: string }): string | null {
  const opening = gate.code === "offer_retired" ? ENDED_VERDICT : `${gate.reason} ${NOT_RATED_CLAUSE}`;
  if (summary === opening) return null;
  if (!summary.startsWith(`${opening} `)) return `does not open with the gate's own verdict: ${summary}`;
  const rest = summary.slice(opening.length + 1);
  if (UNREAD_CITATION_FORMS.some(form => form.test(rest))) return null;
  return `carries prose that is neither the gate's verdict nor a citation we could not read: ${rest}`;
}

let port = 0;
let proc: ChildProcess | null = null;

function startServer(): Promise<ChildProcess> {
  return new Promise((resolve, reject) => {
    const child = spawn("node", [path.join(REPO, "dist", "serve.js")], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, PORT: "0", BASE_URL: "http://localhost", TZ: "UTC" },
    });
    const timeout = setTimeout(() => { child.kill(); reject(new Error("Server startup timeout")); }, 60000);
    child.stderr!.on("data", (data: Buffer) => {
      const m = data.toString().match(/running on http:\/\/localhost:(\d+)/);
      if (m) { port = parseInt(m[1], 10); clearTimeout(timeout); resolve(child); }
    });
    child.on("error", (e) => { clearTimeout(timeout); reject(e); });
  });
}

async function getJson(pathname: string): Promise<any> {
  const res = await fetch(`http://localhost:${port}${pathname}`);
  return res.json();
}

function parseSSE(text: string): any[] {
  const out: any[] = [];
  for (const line of text.split("\n")) {
    if (line.startsWith("data: ")) { try { out.push(JSON.parse(line.slice(6))); } catch { continue; } }
  }
  return out;
}

async function mcpPost(sessionId: string | null, msg: object): Promise<{ responses: any[]; sessionId: string | null }> {
  const headers: Record<string, string> = { "Content-Type": "application/json", "Accept": "application/json, text/event-stream" };
  if (sessionId) headers["mcp-session-id"] = sessionId;
  const res = await fetch(`http://localhost:${port}/mcp`, { method: "POST", headers, body: JSON.stringify(msg) });
  const text = await res.text();
  return { responses: parseSSE(text), sessionId: res.headers.get("mcp-session-id") || sessionId };
}

let mcpSession: string | null = null;
let mcpCallId = 100;

async function searchDeals(args: Record<string, unknown>): Promise<any> {
  if (!mcpSession) {
    const init = await mcpPost(null, {
      jsonrpc: "2.0", id: 1, method: "initialize",
      params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "gate-field-test", version: "1.0" } },
    });
    mcpSession = init.sessionId;
    await mcpPost(mcpSession, { jsonrpc: "2.0", method: "notifications/initialized" });
  }
  const id = mcpCallId++;
  const { responses } = await mcpPost(mcpSession, {
    jsonrpc: "2.0", id, method: "tools/call",
    params: { name: "search_deals", arguments: args },
  });
  return JSON.parse(responses.find(r => r.id === id).result.content[0].text);
}

function recordKey(o: { vendor: string; tier: string; url: string }): string {
  return `${o.vendor}|${o.tier}|${o.url}`;
}

const expectedGates = new Map<string, Gate>(
  offers.map(o => [recordKey(o), (gateFor(o, TODAY) as Gate) ?? null]),
);

const gatedRecords = offers.filter(o => gateFor(o, TODAY) !== null);
const gatedByCode = (code: string) => gatedRecords.filter(o => gateFor(o, TODAY)!.code === code);

const CLAUSE_TEXT: Record<string, [string, (n: number) => string]> = {
  eligibility_restricted: ["1 requires an application or qualification", n => `${n} require an application or qualification`],
  not_a_free_offer: ["1 is not a free offer", n => `${n} are not free offers`],
  offer_expired: ["1 has expired", n => `${n} have expired`],
  offer_retired: ["1 has ended", n => `${n} have ended`],
};
const CLAUSE_ORDER = ["eligibility_restricted", "not_a_free_offer", "offer_expired", "offer_retired"];

function expectedSummary(noun: string, records: Offer[]): string {
  const codes = records.map(o => gateFor(o, TODAY)).filter(Boolean).map(g => g!.code);
  if (codes.length === 0) return "";
  const clauses = CLAUSE_ORDER
    .map(code => ({ code, n: codes.filter(c => c === code).length }))
    .filter(({ n }) => n > 0)
    .map(({ code, n }) => (n === 1 ? CLAUSE_TEXT[code][0] : CLAUSE_TEXT[code][1](n)))
    .join(", ");
  const total = records.length;
  const subject = `the ${total} ${noun}${total === 1 ? "" : "s"} matching this query`;
  if (codes.length >= total && total > 1) return `None of ${subject} are on our ranked list — ${clauses}.`;
  if (codes.length === 1) return `One of ${subject} is not on our ranked list — ${clauses}.`;
  return `${codes.length} of ${subject} are not on our ranked list — ${clauses}.`;
}

function inCategory(category: string): Offer[] {
  return offers.filter(o => o.category === category);
}

function categoryWhere(predicate: (gated: number, total: number) => boolean): string {
  const categories = [...new Set(offers.map(o => o.category))].sort();
  const found = categories.find(c => {
    const rows = inCategory(c);
    return rows.length > 3 && predicate(rows.filter(o => gateFor(o, TODAY) !== null).length, rows.length);
  });
  assert.ok(found, "no category matched the shape this test needs");
  return found!;
}

function firstVendorGatedAs(code: string): string {
  const record = gatedByCode(code)[0];
  assert.ok(record, `no record is currently gated ${code}`);
  return record.vendor;
}

function firstRecordForItsVendor(offer: Offer): boolean {
  return offers.find(o => o.vendor.toLowerCase() === offer.vendor.toLowerCase()) === offer;
}

function vendorWhoseOwnRecordIsGatedAs(code: string): string {
  const record = gatedByCode(code).find(firstRecordForItsVendor);
  assert.ok(record, `every record gated ${code} belongs to a vendor whose first record is a different one`);
  return record!.vendor;
}

describe("every JSON surface carries the ranker's gate (issue #1241 Part 1)", () => {
  before(async () => { mcpSession = null; proc = await startServer(); });
  after(() => { if (proc) { proc.kill(); proc = null; } });

  it("/api/offers returns the same gate the ranker applies, for every record in the catalog", async () => {
    const seen = new Map<string, Gate>();
    for (let offset = 0; offset < CATALOG_SIZE; offset += 200) {
      const body = await getJson(`/api/offers?limit=200&offset=${offset}`);
      for (const offer of body.offers) {
        assert.ok("gate" in offer, `${offer.vendor} (${offer.tier}) came back with no gate field`);
        seen.set(recordKey(offer), offer.gate ?? null);
      }
    }
    assert.strictEqual(seen.size, CATALOG_SIZE, "not every record was paged through");
    const disagreeing: string[] = [];
    for (const [key, gate] of seen) {
      const expected = expectedGates.get(key) ?? null;
      if (JSON.stringify(gate) !== JSON.stringify(expected)) disagreeing.push(key);
    }
    assert.deepStrictEqual(disagreeing, [], "records whose published gate is not gateFor's verdict");
  });

  it("the ungated majority publishes gate null, and the gate has not swallowed the catalog", async () => {
    const nulls: string[] = [];
    for (let offset = 0; offset < CATALOG_SIZE; offset += 200) {
      const body = await getJson(`/api/offers?limit=200&offset=${offset}`);
      for (const offer of body.offers) if (offer.gate === null) nulls.push(recordKey(offer));
    }
    assert.strictEqual(nulls.length, CATALOG_SIZE - gatedRecords.length);
    assert.ok(nulls.length > CATALOG_SIZE * MOST_OF_THE_CATALOG, `only ${nulls.length} of ${CATALOG_SIZE} records are ungated`);
  });

  it("nothing is filtered out — a caller asking about a gated vendor by name still gets the record", async () => {
    const sample = GATE_TABLE.flatMap((entry: { code: string }) => gatedByCode(entry.code).slice(0, 5));
    assert.ok(sample.length > 5, "no gated records to ask about");
    const absent: string[] = [];
    for (const record of sample) {
      const body = await getJson(`/api/offers?q=${encodeURIComponent(record.vendor)}&limit=50`);
      const row = body.offers.find((o: any) => recordKey(o) === recordKey(record));
      if (!row) { absent.push(record.vendor); continue; }
      assert.strictEqual(row.gate.code, gateFor(record, TODAY)!.code, record.vendor);
    }
    assert.deepStrictEqual(absent, [], "gated records a search by vendor name no longer returns");
  });

  it("/api/details carries the gate on the subject and on every alternative", async () => {
    const gatedVendor = firstVendorGatedAs("offer_retired");
    const gated = await getJson(`/api/details/${encodeURIComponent(gatedVendor)}`);
    assert.strictEqual(gated.offer.gate.code, "offer_retired");

    const body = await getJson("/api/details/Supabase?alternatives=true");
    assert.strictEqual(body.offer.gate, null);
    assert.ok(body.alternatives.length > 0);
    for (const alt of body.alternatives) assert.ok("gate" in alt, `${alt.vendor} alternative carries no gate`);
  });

  it("an alternative that is itself gated says so — rankForListing demotes, it does not drop", async () => {
    const vendors = [...new Set(offers.map(o => o.vendor))];
    const disagreeing: string[] = [];
    let gatedAlternativesSeen = 0;
    let riskAlternativesRated = 0;
    for (const vendor of vendors) {
      const detail = await getJson(`/api/details/${encodeURIComponent(vendor)}?alternatives=true`);
      for (const alt of detail.alternatives ?? []) {
        const expected = expectedGates.get(recordKey(alt)) ?? null;
        if (JSON.stringify(alt.gate ?? null) !== JSON.stringify(expected)) disagreeing.push(`${vendor} -> ${alt.vendor}`);
        if (expected) gatedAlternativesSeen++;
      }
      if (!detail.alternatives?.some((a: any) => a.gate)) continue;
      const risk = await getJson(`/api/vendor-risk/${encodeURIComponent(vendor)}`);
      for (const alt of risk.alternatives ?? []) {
        if (alt.gate && alt.risk_level !== null) riskAlternativesRated++;
      }
    }
    assert.ok(gatedAlternativesSeen > 0, "no gated record surfaced as an alternative — this test proved nothing");
    assert.deepStrictEqual(disagreeing, [], "alternatives whose published gate is not gateFor's verdict");
    assert.strictEqual(riskAlternativesRated, 0, "a gated record was offered as a more-stable alternative with a rating");
  });

  it("search_deals returns the ranker's verdict on every row of a category holding gated records", async () => {
    const category = categoryWhere((gated, total) => gated > 0 && gated < total);
    const body = await searchDeals({ category, limit: 200 });
    const disagreeing: string[] = [];
    for (const row of body.results) {
      assert.ok("gate" in row, `${row.vendor} came back from MCP with no gate`);
      const expected = expectedGates.get(recordKey(row)) ?? null;
      if (JSON.stringify(row.gate ?? null) !== JSON.stringify(expected)) disagreeing.push(row.vendor);
    }
    assert.deepStrictEqual(disagreeing, []);
    assert.ok(body.results.some((r: any) => r.gate !== null), `${category} returned no gated row`);
  });

  it("search_deals carries the gate in concise mode and on the vendor branch", async () => {
    const category = categoryWhere((gated, total) => gated === total);
    const concise = await searchDeals({ category, limit: 3, response_format: "concise" });
    for (const row of concise.results) assert.ok(row.gate, `${row.vendor} lost its gate in concise mode`);

    const retired = firstVendorGatedAs("offer_retired");
    const vendor = await searchDeals({ vendor: retired });
    assert.strictEqual(vendor.gate.code, "offer_retired");
  });
});

describe("the response states how many of its offers are gated (issue #1241 Part 1)", () => {
  before(async () => { mcpSession = null; proc = await startServer(); });
  after(() => { if (proc) { proc.kill(); proc = null; } });

  it("a fully gated category says so at the response level on both surfaces", async () => {
    const category = categoryWhere((gated, total) => gated === total);
    const records = inCategory(category);

    const api = await getJson(`/api/offers?category=${encodeURIComponent(category)}&limit=5`);
    assert.strictEqual(api.total, records.length);
    assert.strictEqual(api.gated, records.length);
    assert.strictEqual(api.gate_summary, expectedSummary("offer", records));
    assert.match(api.gate_summary, /^None of the \d+ offers matching this query are on our ranked list — /);

    const mcp = await searchDeals({ category, limit: 5 });
    assert.strictEqual(mcp.gated, records.length);
    assert.strictEqual(mcp.gate_summary, expectedSummary("result", records));
  });

  it("the count covers the whole match, not the returned page", async () => {
    const category = categoryWhere((gated, total) => gated === total && total > 5);
    const body = await getJson(`/api/offers?category=${encodeURIComponent(category)}&limit=5`);
    assert.strictEqual(body.offers.length, 5);
    assert.ok(body.total > 5);
    assert.strictEqual(body.gated, body.total);
  });

  it("a partly gated category names each kind and counts only the gated", async () => {
    const category = categoryWhere((gated, total) => gated > 1 && gated < total);
    const records = inCategory(category);
    const body = await getJson(`/api/offers?category=${encodeURIComponent(category)}&limit=5`);
    assert.strictEqual(body.gated, records.filter(o => gateFor(o, TODAY) !== null).length);
    assert.ok(body.gated < body.total);
    assert.strictEqual(body.gate_summary, expectedSummary("offer", records));
  });

  it("an ungated category counts zero and says nothing", async () => {
    const category = categoryWhere(gated => gated === 0);
    const body = await getJson(`/api/offers?category=${encodeURIComponent(category)}&limit=5`);
    assert.ok(body.total > 0);
    assert.strictEqual(body.gated, 0);
    assert.ok(!("gate_summary" in body), "a summary was published for a response with nothing to disclose");
    for (const offer of body.offers) assert.strictEqual(offer.gate, null);
  });

  it("the count equals the number of gated offers a caller can see when the page holds them all", async () => {
    const category = categoryWhere((gated, total) => gated > 0 && gated < total);
    const body = await getJson(`/api/offers?category=${encodeURIComponent(category)}&limit=500`);
    const visible = body.offers.filter((o: any) => o.gate !== null).length;
    assert.strictEqual(body.offers.length, body.total);
    assert.strictEqual(body.gated, visible);
  });
});

describe("/api/vendor-risk does not rate an offer we do not list (issue #1241 Part 1)", () => {
  before(async () => { proc = await startServer(); });
  after(() => { if (proc) { proc.kill(); proc = null; } });

  it("a retired record gets the sentence the vendor page already publishes", async () => {
    const body = await getJson(`/api/vendor-risk/${encodeURIComponent(vendorWhoseOwnRecordIsGatedAs("offer_retired"))}`);
    assert.strictEqual(body.risk_level, null);
    assert.strictEqual(body.gate.code, "offer_retired");
    assert.ok(body.summary.startsWith(ENDED_VERDICT), body.summary);
    assert.strictEqual(body.free_tier_longevity_days, null);
  });

  it("the other gate codes open with the gate's own reason and decline to rate", async () => {
    for (const code of ["not_a_free_offer", "offer_expired", "eligibility_restricted"]) {
      const vendor = vendorWhoseOwnRecordIsGatedAs(code);
      const body = await getJson(`/api/vendor-risk/${encodeURIComponent(vendor)}`);
      assert.strictEqual(body.risk_level, null, vendor);
      assert.strictEqual(body.gate.code, code, vendor);
      assert.ok(body.summary.startsWith(`${body.gate.reason} ${NOT_RATED_CLAUSE}`), `${vendor}: ${body.summary}`);
    }
  });

  it("a gated record whose cited page we could not read still says which page we could not read", async () => {
    const withheld = gatedRecords.filter(o => firstRecordForItsVendor(o) && o.source_check && o.source_check.outcome !== "ok");
    assert.ok(withheld.length > 0, "no gated record currently carries a source check we could not read");
    let cited = 0;
    for (const record of withheld.slice(0, 25)) {
      const body = await getJson(`/api/vendor-risk/${encodeURIComponent(record.vendor)}`);
      if (!body.gate) continue;
      assert.ok(body.summary.length > `${body.gate.reason} ${NOT_RATED_CLAUSE}`.length, `${record.vendor} dropped the citation it could not read`);
      cited++;
    }
    assert.ok(cited > 0, "no gated record with an unreadable citation resolved to its own record");
  });

  it("a count of days a free tier has held is withheld where our record says there is no free tier", async () => {
    for (const code of ["offer_retired", "not_a_free_offer"]) {
      const vendor = vendorWhoseOwnRecordIsGatedAs(code);
      const body = await getJson(`/api/vendor-risk/${encodeURIComponent(vendor)}`);
      assert.strictEqual(body.free_tier_longevity_days, null, vendor);
    }
  });

  it("a restricted or expired offer keeps its day count — the tier it names is real for whoever qualifies", async () => {
    for (const code of ["eligibility_restricted", "offer_expired"]) {
      const vendor = vendorWhoseOwnRecordIsGatedAs(code);
      const body = await getJson(`/api/vendor-risk/${encodeURIComponent(vendor)}`);
      assert.strictEqual(body.gate.code, code, vendor);
      assert.ok(typeof body.free_tier_longevity_days === "number", `${vendor} lost its day count`);
    }
  });

  it("no gated vendor is handed a level or a stability sentence, across every gated record", async () => {
    const rated: string[] = [];
    const reassured: string[] = [];
    const offShape: string[] = [];
    const seen = new Set<string>();
    let reported = 0;
    for (const offer of gatedRecords) {
      if (seen.has(offer.vendor.toLowerCase())) continue;
      seen.add(offer.vendor.toLowerCase());
      const body = await getJson(`/api/vendor-risk/${encodeURIComponent(offer.vendor)}`);
      if (body.error || !body.gate) continue;
      reported++;
      if (body.risk_level !== null) rated.push(offer.vendor);
      if (body.summary.includes(STABLE_HISTORY)) reassured.push(offer.vendor);
      const problem = gateSummaryShape(body.summary, body.gate);
      if (problem) offShape.push(`${offer.vendor} ${problem}`);
    }
    assert.deepStrictEqual(offShape, [], "gated summaries that are not the gate's verdict, alone or followed by an unread citation");
    assert.ok(reported > seen.size * 0.9, `only ${reported} of ${seen.size} gated vendors resolved to their gated record`);
    assert.deepStrictEqual(rated, [], "gated vendors still handed a risk_level");
    assert.deepStrictEqual(reassured, [], "gated vendors still told their pricing history is stable");
  });

  it("ungated vendors keep their rating, their longevity and their sentence", async () => {
    const ungated = offers.filter(o => gateFor(o, TODAY) === null).slice(0, 40);
    let stillRated = 0;
    for (const offer of ungated) {
      const body = await getJson(`/api/vendor-risk/${encodeURIComponent(offer.vendor)}`);
      if (body.error || body.gate) continue;
      assert.ok(typeof body.free_tier_longevity_days === "number", offer.vendor);
      assert.ok(!body.summary.includes(NOT_RATED_CLAUSE), offer.vendor);
      if (body.risk_level !== null) stillRated++;
    }
    assert.ok(stillRated > 10, `only ${stillRated} of 40 ungated vendors still carry a risk_level`);
  });
});

describe("the disclosure sentence has one form per count (issue #1241)", () => {
  it("says nothing when nothing is gated", () => {
    assert.strictEqual(gateDisclosureSentence("them", 12, []), "");
  });

  it("uses the four forms the criteria set out", () => {
    assert.strictEqual(
      gateDisclosureSentence("them", 3, ["eligibility_restricted", "eligibility_restricted", "eligibility_restricted"]),
      "None of them are on our ranked list — 3 require an application or qualification.",
    );
    assert.strictEqual(
      gateDisclosureSentence("them", 3, ["not_a_free_offer"]),
      "One of them is not on our ranked list — 1 is not a free offer.",
    );
    assert.strictEqual(
      gateDisclosureSentence("them", 5, ["offer_expired", "offer_retired"]),
      "2 of them are not on our ranked list — 1 has expired, 1 has ended.",
    );
  });

  it("orders the clauses by gate code and agrees in number", () => {
    assert.strictEqual(
      gateClauseList(["offer_retired", "not_a_free_offer", "eligibility_restricted", "not_a_free_offer", "offer_expired"]),
      "1 requires an application or qualification, 2 are not free offers, 1 has expired, 1 has ended",
    );
  });

  it("keeps the subject singular when the whole match is one offer", () => {
    assert.strictEqual(matchingSubject("offer", 1), "the 1 offer matching this query");
    assert.strictEqual(matchingSubject("offer", 2), "the 2 offers matching this query");
    assert.strictEqual(
      gateDisclosureSentence(matchingSubject("offer", 1), 1, ["offer_retired"]),
      "One of the 1 offer matching this query is not on our ranked list — 1 has ended.",
    );
  });

  it("has a clause for every gate code the ranker can return", () => {
    for (const entry of GATE_TABLE) {
      assert.notStrictEqual(gateClauseList([entry.code]), "", `no clause for gate code ${entry.code}`);
    }
  });
});
