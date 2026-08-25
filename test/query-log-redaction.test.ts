import { describe, it } from "node:test";
import assert from "node:assert";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

const {
  toPublicRequestLog,
  PUBLISHED_TEXT_MAX,
} = await import("../src/stats.ts");

type RawEntry = Parameters<typeof toPublicRequestLog>[0][number];

function entry(over: Partial<RawEntry> = {}): RawEntry {
  return {
    ts: "2026-08-25T21:00:00.000Z",
    type: "api",
    endpoint: "/api/offers",
    params: {},
    result_count: 1,
    ...over,
  } as RawEntry;
}

describe("parameter values are replaced by their lengths", () => {
  it("publishes the name and length of a free-text query, never the text", () => {
    const [published] = toPublicRequestLog([
      entry({ params: { q: "how do i cancel my subscription", category: "Infrastructure" } }),
    ]);
    assert.deepEqual(published.param_lengths, { q: 31, category: 14 });
    const serialized = JSON.stringify(published);
    assert.ok(!serialized.includes("cancel"), "query text must not reach the response");
    assert.ok(!serialized.includes("Infrastructure"), "filter text must not reach the response");
  });

  it("has no params key at all", () => {
    const [published] = toPublicRequestLog([entry({ params: { q: "postgres" } })]);
    assert.ok(!("params" in published));
  });

  it("does not publish a registration name", () => {
    const [published] = toPublicRequestLog([
      entry({ endpoint: "/api/agents/register", params: { name: "ada-lovelace-bot" } }),
    ]);
    assert.deepEqual(published.param_lengths, { name: 16 });
    assert.ok(!JSON.stringify(published).includes("ada-lovelace"));
  });

  it("measures non-string values without publishing them", () => {
    const [published] = toPublicRequestLog([
      entry({ params: { limit: 2000, personalized: true, vendors: ["neon", "supabase"] } }),
    ]);
    assert.equal(published.param_lengths.limit, 4);
    assert.equal(published.param_lengths.personalized, 4);
    assert.equal(published.param_lengths.vendors, 19);
    assert.ok(!JSON.stringify(published).includes("neon"));
  });

  it("omits parameters that were never sent", () => {
    const [published] = toPublicRequestLog([
      entry({ params: { q: "redis", category: undefined, sort: undefined } }),
    ]);
    assert.deepEqual(Object.keys(published.param_lengths), ["q"]);
  });

  it("survives a value that cannot be serialized", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const [published] = toPublicRequestLog([entry({ params: { odd: cyclic } })]);
    assert.equal(published.param_lengths.odd, 0);
  });
});

describe("session identifiers are not published", () => {
  it("replaces the identifier with an index", () => {
    const [published] = toPublicRequestLog([
      entry({ session_id: "3f1c8a4e-2b7d-4a91-9c33-6de5b0f21a77" }),
    ]);
    assert.equal(published.session_index, 1);
    assert.ok(!("session_id" in published));
    assert.ok(!JSON.stringify(published).includes("3f1c8a4e"));
  });

  it("gives entries from one session the same index and different sessions different ones", () => {
    const published = toPublicRequestLog([
      entry({ session_id: "session-a" }),
      entry({ session_id: "session-b" }),
      entry({ session_id: "session-a" }),
    ]);
    assert.equal(published[0].session_index, 1);
    assert.equal(published[1].session_index, 2);
    assert.equal(published[2].session_index, 1);
  });

  it("assigns the index within one response, so it means nothing across responses", () => {
    const raw = [entry({ session_id: "session-a" }), entry({ session_id: "session-b" })];
    const wholeWindow = toPublicRequestLog(raw);
    const laterWindow = toPublicRequestLog(raw.slice(1));
    assert.equal(wholeWindow[1].session_index, 2);
    assert.equal(laterWindow[0].session_index, 1);
  });

  it("leaves the index off entries that carry no session", () => {
    const [published] = toPublicRequestLog([entry()]);
    assert.ok(!("session_index" in published));
  });
});

describe("caller-supplied text is bounded before it is republished", () => {
  it("keeps a normal user agent intact", () => {
    const ua = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36";
    const [published] = toPublicRequestLog([entry({ user_agent: ua })]);
    assert.equal(published.user_agent, ua);
  });

  it("bounds a user agent that is long enough to be prose", () => {
    const [published] = toPublicRequestLog([entry({ user_agent: "x".repeat(5000) })]);
    assert.equal(published.user_agent!.length, PUBLISHED_TEXT_MAX);
  });

  it("strips control characters from a user agent", () => {
    const escape = String.fromCharCode(27);
    const nul = String.fromCharCode(0);
    const del = String.fromCharCode(127);
    const [published] = toPublicRequestLog([
      entry({ user_agent: `curl/8.0${escape}[31m${nul}${del}Injected: header` }),
    ]);
    const hasControlChar = [...published.user_agent!].some(ch => {
      const code = ch.codePointAt(0) ?? 0;
      return code < 0x20 || code === 0x7f;
    });
    assert.equal(hasControlChar, false);
    assert.equal(published.user_agent, "curl/8.0 [31m Injected: header");
  });

  it("collapses a newline that would otherwise split the value across lines", () => {
    const [published] = toPublicRequestLog([
      entry({ user_agent: `curl/8.0${String.fromCharCode(10)}Injected: header` }),
    ]);
    assert.equal(published.user_agent, "curl/8.0 Injected: header");
  });

  it("bounds a client-reported name and version", () => {
    const [published] = toPublicRequestLog([
      entry({ client_info: { name: "y".repeat(900), version: "1.0.0" } }),
    ]);
    assert.equal(published.client_info!.name.length, PUBLISHED_TEXT_MAX);
    assert.equal(published.client_info!.version, "1.0.0");
  });

  it("reports an empty client name as unknown rather than as an empty string", () => {
    const [published] = toPublicRequestLog([
      entry({ client_info: { name: "   ", version: "" } }),
    ]);
    assert.equal(published.client_info!.name, "unknown");
    assert.equal(published.client_info!.version, "unknown");
  });
});

describe("the raw log is not reachable from the request path", () => {
  const stripComments = (src: string) =>
    src.split("\n").filter((l) => !/^\s*(\*|\/\/|\/\*|\*\/)/.test(l)).join("\n");

  it("serve.ts reads the published projection and never the stored entries", () => {
    const serve = stripComments(readFileSync(path.join(REPO, "src", "serve.ts"), "utf8"));
    assert.ok(
      !/getRequestLogResult/.test(serve),
      "the stored entries must not be reachable from the request path",
    );
    assert.ok(!/getRequestLog\b/.test(serve), "the stored entries must not be reachable either way");
    assert.ok(/getPublicRequestLogResult/.test(serve), "the endpoint must read the projection");
  });

  it("the projection is what the published schema describes", () => {
    const openapi = readFileSync(path.join(REPO, "src", "openapi.ts"), "utf8");
    const spec = openapi.slice(openapi.indexOf('"/api/query-log"'), openapi.indexOf('"/api/costs"'));
    assert.ok(spec.includes("param_lengths"));
    assert.ok(spec.includes("session_index"));
    assert.ok(!/\bsession_id\b/.test(spec));
    assert.ok(!/params: \{ type: "object" \}/.test(spec));
  });
});
