import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertCoversPopulation, assertPopulationFloor, assertSharesPopulation, recordsInTheCatalogue } from "./population-floor.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(__dirname, "..");

const { confirmationDate, lastReadDate, lastReadNote, storedConfirmationClause, verificationDatesCell, CONFIRMED_DATE_LABEL, LAST_READ_LABEL, NO_CONFIRMATION_HELD, UNCONFIRMED_DATE_LABEL, VERIFICATION_DATES_HEADING } =
  await import("../dist/read-date.js");
const { publishedTermsEvidence, termsTheVerdictWithholds, unconfirmedTermsFrom } = await import("../dist/vendor-verdict.js");
const { ANSWERED_OUTCOMES } = await import("../scripts/verification-state.js");

interface CatalogueOffer {
  vendor: string;
  category: string;
  url: string;
  tier: string;
  verifiedDate: string;
}

const offers: CatalogueOffer[] = JSON.parse(readFileSync(path.join(REPO, "data", "index.json"), "utf-8")).offers;

const slugOf = (vendor: string) => vendor.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

const daysBetween = (from: string, to: string) =>
  Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);

const heldState: Array<{ vendor: string; url: string; last_attempt_at: string | null; last_outcome: string | null }> =
  JSON.parse(readFileSync(path.join(REPO, "data", "verification_state.json"), "utf-8")).records;
const stateByKey = new Map(heldState.map((r) => [`${r.vendor}|${r.url}`, r]));

const byGap = (from: CatalogueOffer[]) =>
  from
    .map((o) => ({ offer: o, read: lastReadDate(o), gap: daysBetween(o.verifiedDate, lastReadDate(o)) }))
    .sort((a, b) => b.gap - a.gap)[0]!;

const PUBLISHED_DATE_CARD = new RegExp(
  `>(${CONFIRMED_DATE_LABEL}|${UNCONFIRMED_DATE_LABEL})</div>\\s*<div class="detail-value"[^>]*>([^<]+)<`,
);

const publishedDateCardOn = (body: string): { label: string; date: string } | null => {
  const m = body.match(PUBLISHED_DATE_CARD);
  return m ? { label: m[1]!, date: m[2]! } : null;
};

const escaped = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const termsWithheldOn = (offer: CatalogueOffer) =>
  termsTheVerdictWithholds(unconfirmedTermsFrom(publishedTermsEvidence(offer)));

const holdsAConfirmation = (o: CatalogueOffer) => confirmationDate(o) !== null;

const metaDescriptionOf = (body: string): string =>
  body.match(/<meta name="description" content="([^"]*)"/)?.[1] ?? "";

const detailNoteOf = (body: string): string =>
  body.match(/<div class="detail-note">([^<]*)<\/div>/)?.[1] ?? "";

const THE_PAGE_WITHHOLDS = "Not verified — ";
const pageWithholdsTheTerms = (body: string) => metaDescriptionOf(body).includes(THE_PAGE_WITHHOLDS);

const widestGap = byGap(offers);
const widestUnconfirmedGap = byGap(offers.filter((o) => confirmationDate(o) === null));
const pagePrimaries = [...new Set(offers.map((o) => o.vendor))].map((vendor) => offers.find((o) => o.vendor === vendor)!);
const confirmationsHeld = pagePrimaries.filter(holdsAConfirmation);
const confirmationsOlderThanTheirRead = confirmationsHeld
  .filter((o) => confirmationDate(o)! < lastReadDate(o))
  .map((o) => ({ offer: o, read: lastReadDate(o), gap: daysBetween(o.verifiedDate, lastReadDate(o)) }))
  .sort((a, b) => b.gap - a.gap);

let serverPort = 0;
let proc: ChildProcess | null = null;

function startServer(): Promise<ChildProcess> {
  return new Promise((resolve, reject) => {
    const child = spawn("node", [path.join(REPO, "dist", "serve.js")], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, PORT: "0", BASE_URL: "http://localhost" },
    });
    const timeout = setTimeout(() => { child.kill(); reject(new Error("Server startup timeout")); }, 20000);
    child.stderr!.on("data", (data: Buffer) => {
      const m = data.toString().match(/running on http:\/\/localhost:(\d+)/);
      if (m) { serverPort = parseInt(m[1], 10); clearTimeout(timeout); resolve(child); }
    });
    child.on("error", (err) => { clearTimeout(timeout); reject(err); });
  });
}

const get = async (p: string) => {
  const res = await fetch(`http://localhost:${serverPort}${p}`);
  return { status: res.status, body: await res.text() };
};

function readResourceOverStdio(uri: string): Promise<string> {
  const child = spawn("node", [path.join(REPO, "dist", "index.js")], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, AGENTDEALS_API_URL: `http://localhost:${serverPort}` },
  });
  const messages = [
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test-client", version: "1.0.0" } } },
    { jsonrpc: "2.0", method: "notifications/initialized" },
    { jsonrpc: "2.0", id: 2, method: "resources/read", params: { uri } },
  ];
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { child.kill(); reject(new Error("stdio MCP timeout")); }, 20000);
    let buffer = "";
    child.stdout!.on("data", (chunk: Buffer) => {
      buffer += chunk.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        let payload: { id?: number; result?: { contents?: Array<{ text?: string }> } };
        try { payload = JSON.parse(line.trim()); } catch { continue; }
        if (payload.id !== 2) continue;
        clearTimeout(timeout);
        child.kill();
        resolve(payload.result?.contents?.[0]?.text ?? "");
      }
    });
    child.on("error", (err) => { clearTimeout(timeout); reject(err); });
    for (const message of messages) child.stdin!.write(`${JSON.stringify(message)}\n`);
  });
}

async function readResourceOverHttp(uri: string): Promise<string> {
  const base = `http://localhost:${serverPort}/mcp`;
  const accept = "application/json, text/event-stream";
  const init = await fetch(base, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: accept },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1.0.0" } } }),
  });
  const session = init.headers.get("mcp-session-id") ?? "";
  const headers = { "Content-Type": "application/json", Accept: accept, "Mcp-Session-Id": session };
  await fetch(base, { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) });
  const res = await fetch(base, {
    method: "POST",
    headers,
    body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "resources/read", params: { uri } }),
  });
  const text = await res.text();
  const line = text.split("\n").find((l) => l.startsWith("data: ")) ?? text;
  const payload = JSON.parse(line.replace(/^data: /, "")) as { result?: { contents?: Array<{ text?: string }> } };
  return payload.result?.contents?.[0]?.text ?? "";
}

describe("every record publishes the day we last read its page", () => {
  before(async () => { proc = await startServer(); });
  after(() => { proc?.kill(); });

  it("names a read date on every record the catalogue API returns", async () => {
    const { status, body } = await get("/api/offers?limit=5000");
    assert.equal(status, 200);
    const returned = JSON.parse(body).offers as Array<{ vendor: string; url: string; verifiedDate: string; last_read_date?: string; days_since_read?: number }>;
    const dated = returned.filter((o) => /^\d{4}-\d{2}-\d{2}$/.test(o.last_read_date ?? ""));
    assertCoversPopulation(dated.length, recordsInTheCatalogue(), "records the API answers with a day we read the page");
    const byRecord = new Map(returned.map((o) => [`${o.vendor}|${o.url}`, o]));
    let fromTheStore = 0;
    for (const o of returned) {
      assert.equal(typeof o.days_since_read, "number", `${o.vendor} publishes no age for its read date`);
    }
    for (const o of offers) {
      const held = stateByKey.get(`${o.vendor}|${o.url}`);
      if (!held?.last_outcome || !ANSWERED_OUTCOMES.has(held.last_outcome)) continue;
      const answered = byRecord.get(`${o.vendor}|${o.url}`);
      if (!answered) continue;
      fromTheStore++;
      assert.equal(
        answered.last_read_date,
        held.last_attempt_at,
        `${o.vendor} publishes a read date of ${answered.last_read_date} where the store's own attempt read the page on ${held.last_attempt_at}`,
      );
    }
    assertSharesPopulation(fromTheStore, recordsInTheCatalogue(), 0.5, "records the API dates from the store's own attempt");
  });

  it("answers with a read date later than the verification on the records a read has moved", async () => {
    const { body } = await get("/api/offers?limit=5000");
    const returned = JSON.parse(body).offers as Array<{ verifiedDate: string; last_read_date?: string }>;
    const moved = returned.filter((o) => (o.last_read_date ?? "") > o.verifiedDate);
    assertSharesPopulation(moved.length, recordsInTheCatalogue(), 0.25, "records the API answers with a read later than the verification");
  });

  it("publishes both dates, each labelled, on the widest confirmed gap its verdict stands behind", async () => {
    assert.ok(confirmationsOlderThanTheirRead.length > 0, "no record holds a confirmation older than its last read, so this control proves nothing");
    let subject: { offer: CatalogueOffer; read: string } | null = null;
    let body = "";
    for (const candidate of confirmationsOlderThanTheirRead) {
      const answer = await get(`/vendor/${slugOf(candidate.offer.vendor)}`);
      if (answer.status !== 200 || pageWithholdsTheTerms(answer.body)) continue;
      subject = candidate;
      body = answer.body;
      break;
    }
    assert.ok(subject, "every confirmation older than its last read sits on a page that withholds the terms, so this control proves nothing");
    const held = confirmationDate(subject.offer)!;
    assert.ok(body.includes(LAST_READ_LABEL), `the page for ${subject.offer.vendor} does not label a read date`);
    assert.ok(body.includes(subject.read), `the page for ${subject.offer.vendor} does not publish ${subject.read}`);
    assert.ok(
      body.includes(`last confirmed on ${held}`),
      `the page for ${subject.offer.vendor} publishes two dates without saying which is which`,
    );
    assert.deepStrictEqual(
      publishedDateCardOn(body),
      { label: CONFIRMED_DATE_LABEL, date: held },
      `the page for ${subject.offer.vendor} heads its verification with a date the store did not confirm on`,
    );
  });

  it("states no confirmation it cannot source on the record with the widest unconfirmed gap", async () => {
    assert.ok(widestUnconfirmedGap, "every record holds a confirmation, so this control proves nothing");
    const offer = widestUnconfirmedGap.offer;
    const { status, body } = await get(`/vendor/${slugOf(offer.vendor)}`);
    assert.equal(status, 200, `/vendor/${slugOf(offer.vendor)} must exist for this test to mean anything`);
    assert.ok(body.includes(widestUnconfirmedGap.read), `the page for ${offer.vendor} does not publish ${widestUnconfirmedGap.read}`);
    assert.ok(body.includes(offer.verifiedDate), `the page for ${offer.vendor} dropped the date it holds`);
    assert.deepStrictEqual(
      publishedDateCardOn(body),
      { label: UNCONFIRMED_DATE_LABEL, date: offer.verifiedDate },
      `the page for ${offer.vendor} either dropped the date it holds or calls it ${CONFIRMED_DATE_LABEL} with nothing in the store behind it`,
    );
    assert.ok(body.includes(NO_CONFIRMATION_HELD), `the page for ${offer.vendor} does not say the store holds no confirmation for it`);
    assert.ok(
      !body.includes(`last confirmed on ${offer.verifiedDate}`),
      `the page for ${offer.vendor} states its terms were last confirmed on a date no read in the store confirmed`,
    );
  });

  it("states no confirmation that stands on a page that says it cannot confirm the terms", async () => {
    assertPopulationFloor(confirmationsHeld.length, 200, "records the store holds a confirmation for");
    const contradicting: string[] = [];
    const denying: string[] = [];
    const silent: string[] = [];
    const standing: string[] = [];
    const withholding: string[] = [];
    for (const offer of confirmationsHeld) {
      const { status, body } = await get(`/vendor/${slugOf(offer.vendor)}`);
      if (status !== 200) continue;
      const note = detailNoteOf(body);
      if (!pageWithholdsTheTerms(body)) {
        standing.push(offer.vendor);
        if (!note.includes(escaped(lastReadNote(offer)))) silent.push(offer.vendor);
        continue;
      }
      withholding.push(offer.vendor);
      if (note.includes(escaped(lastReadNote(offer)))) contradicting.push(offer.vendor);
      if (note.includes(NO_CONFIRMATION_HELD)) denying.push(offer.vendor);
    }
    assert.ok(withholding.length > 0, "no page holding a confirmation withholds its terms, so this census proves nothing");
    assertPopulationFloor(standing.length, 200, "pages whose verdict stands behind the confirmation they publish");
    assert.deepEqual(contradicting, [], "a page states its terms were confirmed and states it cannot confirm them");
    assert.deepEqual(denying, [], "a page withholding the terms says we hold no confirmation, and the store holds one");
    assert.deepEqual(silent, [], "a page whose verdict stands dropped the confirmation it holds");
  });

  it("dates its last update no earlier than its last read", async () => {
    const { body } = await get(`/vendor/${slugOf(widestGap.offer.vendor)}`);
    const claimed = body.match(/Last updated (\d{4}-\d{2}-\d{2})\./);
    assert.ok(claimed, "the page states no last-updated date");
    assert.ok(
      claimed[1]! >= widestGap.read,
      `the page says it was last updated ${claimed[1]} and that we read the page on ${widestGap.read}`,
    );
  });

  it("labels the read date on a record read and verified on the same day", async () => {
    const together = offers.find((o) => confirmationDate(o) !== null && confirmationDate(o) === lastReadDate(o) && !/\//.test(o.vendor));
    assert.ok(together, "no record reads and confirms on the same day, so this control proves nothing");
    const { status, body } = await get(`/vendor/${slugOf(together.vendor)}`);
    assert.equal(status, 200);
    assert.ok(body.includes(LAST_READ_LABEL), `the page for ${together.vendor} hides the read date because it matches the verification`);
    assert.ok(
      body.includes("and the day we last confirmed"),
      `the page for ${together.vendor} does not say the one date it publishes is both`,
    );
  });

  it("answers the same two dates over stdio MCP as over HTTP MCP", async () => {
    const uri = `agentdeals://vendor/${slugOf(widestGap.offer.vendor)}`;
    const overStdio = await readResourceOverStdio(uri);
    const overHttp = await readResourceOverHttp(uri);
    const publishedLineIn = (text: string) =>
      text.split("\n").find((l) => l.startsWith(`**${CONFIRMED_DATE_LABEL}:**`) || l.startsWith(`**${UNCONFIRMED_DATE_LABEL}:**`)) ?? null;
    const expectedLabel = confirmationDate(widestGap.offer) ? CONFIRMED_DATE_LABEL : UNCONFIRMED_DATE_LABEL;
    for (const [transport, text] of [["stdio", overStdio], ["http", overHttp]] as const) {
      assert.match(
        text,
        new RegExp(`\\*\\*${expectedLabel}:\\*\\* ${widestGap.offer.verifiedDate}|last confirmed on ${widestGap.offer.verifiedDate}`),
        `${transport} dropped the date the record holds, or labelled it something other than ${expectedLabel}`,
      );
      assert.match(text, new RegExp(`\\*\\*Last read:\\*\\* ${widestGap.read}`), `${transport} does not publish the day we read the page`);
    }
    assert.strictEqual(
      publishedLineIn(overStdio),
      publishedLineIn(overHttp),
      "the two MCP surfaces publish different dated lines for the same record",
    );
  });

  it("relates the confirmation it holds to the read it withholds on, over both MCP transports", async () => {
    const subject = confirmationsHeld.find((o) => termsWithheldOn(o) !== null);
    assert.ok(subject, "no record holding a confirmation withholds its terms, so this control proves nothing");
    const uri = `agentdeals://vendor/${slugOf(subject.vendor)}`;
    const standing = storedConfirmationClause(subject);
    const held = confirmationDate(subject)!;
    const answers = [
      ["stdio", await readResourceOverStdio(uri)],
      ["http", await readResourceOverHttp(uri)],
    ] as const;
    const lines: string[] = [];
    for (const [transport, text] of answers) {
      const line = text.split("\n").find((l) => l.startsWith("**Verification:**")) ?? "";
      assert.ok(line, `${transport} publishes no verification line for ${subject.vendor}`);
      assert.ok(
        !line.includes(standing),
        `${transport} states a confirmation that stands beside a refusal to confirm: ${line}`,
      );
      assert.ok(line.includes(held), `${transport} drops the ${held} confirmation the store holds for ${subject.vendor}`);
      lines.push(line);
    }
    assert.strictEqual(lines[0], lines[1], "the two MCP surfaces relate the confirmation differently");
  });

  it("heads every category table with both dates and fills every row", async () => {
    const categories = [...new Set(offers.map((o) => o.category))];
    const unheaded: string[] = [];
    let published = 0;
    for (const category of categories) {
      const { status, body } = await get(`/category/${slugOf(category)}`);
      assert.equal(status, 200, `/category/${slugOf(category)} must exist for this test to mean anything`);
      if (!body.includes(VERIFICATION_DATES_HEADING)) unheaded.push(category);
      for (const o of offers.filter((x) => x.category === category)) {
        if (body.includes(`>${verificationDatesCell(o)}</td>`)) published++;
      }
    }
    assert.deepEqual(unheaded, [], "category tables still head their date column with one date");
    assertCoversPopulation(published, recordsInTheCatalogue(), "rows publishing a day we read the page");
  });
});
