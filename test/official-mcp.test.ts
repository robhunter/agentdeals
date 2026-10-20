import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  officialMcpProblems, officialMcpKey, advanceOfficialMcpCheck,
  officialMcpPassage, withCheckedOfficialMcp,
} from "../dist/official-mcp.js";

const remote = {
  kind: "remote" as const,
  target: "https://api.example.com/mcp",
  transport: "Streamable HTTP",
  authentication: 'the header "Authorization: Bearer <API_KEY>"',
  doc_url: "https://docs.example.com/mcp",
  source_quote: "The MCP server connects an AI agent to your workspace.",
  read_on: "2026-10-20",
};
const npm = {
  ...remote, kind: "npm" as const, target: "@example/mcp-server", transport: "stdio",
  authentication: "an API key",
  retired_names: [{ kind: "npm" as const, target: "@example/old-server", notice: "Package no longer supported.",
    url: "https://www.npmjs.com/package/@example/old-server", read_on: "2026-10-20" }],
};
const listing = { vendor: "Example", url: "https://example.com/pricing", tier: "Free", description: "Stored terms." };

describe("official MCP evidence validation", () => {
  it("accepts each supported target with complete evidence", () => {
    for (const entry of [remote, npm, { ...remote, kind: "pypi", target: "example-mcp" },
      { ...remote, kind: "github", target: "https://github.com/example/server" }]) {
      assert.deepEqual(officialMcpProblems([entry]), []);
    }
    assert.deepEqual(officialMcpProblems(undefined), []);
  });

  for (const field of ["doc_url", "source_quote", "read_on", "target", "transport", "authentication"]) {
    it(`rejects absent ${field}`, () => {
      const entry = { ...remote } as Record<string, unknown>;
      delete entry[field];
      assert.ok(officialMcpProblems([entry]).some(problem => problem.includes(field)));
    });
  }

  it("rejects unsupported kinds and malformed containers", () => {
    assert.ok(officialMcpProblems([{ ...remote, kind: "community" }]).some(problem => problem.includes("kind")));
    for (const value of [null, {}, [], "remote", [null], [[]]]) assert.ok(officialMcpProblems(value).length);
  });

  it("rejects invalid calendar dates and documentation URLs", () => {
    for (const read_on of ["2026-02-30", "2026-13-01", "2026-1-01", " "]) {
      assert.ok(officialMcpProblems([{ ...remote, read_on }]).length, read_on);
    }
    for (const doc_url of ["http://example.com", "javascript:alert(1)", "https://secret@example.com/", " "]) {
      assert.ok(officialMcpProblems([{ ...remote, doc_url }]).length, doc_url);
    }
  });

  it("rejects invalid targets and duplicate servers", () => {
    for (const entry of [{ ...remote, target: "http://api.example.com/mcp" },
      { ...npm, target: "@example/server --token SECRET" },
      { ...npm, target: "" }, { ...remote, kind: "pypi", target: "-package" },
      { ...remote, kind: "github", target: "https://github.com/example/server/tree/main" },
      { ...remote, kind: "github", target: "https://other.example/example/server" }]) {
      assert.ok(officialMcpProblems([entry]).length, JSON.stringify(entry));
    }
    assert.ok(officialMcpProblems([remote, remote]).some(problem => problem.includes("repeats")));
  });

  it("requires independent evidence for retired names", () => {
    for (const field of ["notice", "url", "read_on", "target", "kind"]) {
      const retired = { ...npm.retired_names[0] } as Record<string, unknown>;
      delete retired[field];
      assert.ok(officialMcpProblems([{ ...npm, retired_names: [retired] }]).length, field);
    }
    assert.ok(officialMcpProblems([{ ...npm, retired_names: {} }]).length);
    assert.ok(officialMcpProblems([{ ...npm, retired_names: [null] }]).length);
  });
});

describe("daily official MCP failure history", () => {
  it("keeps the first failure and withholds on the next failing day", () => {
    const first = advanceOfficialMcpCheck(undefined, false, "2026-10-20", "endpoint: HTTP 404");
    assert.deepEqual(first, { checked_on: "2026-10-20", passed: false, failure_streak: 1, withheld: false, detail: "endpoint: HTTP 404" });
    const second = advanceOfficialMcpCheck(first, false, "2026-10-21", "endpoint: HTTP 404");
    assert.equal(second.failure_streak, 2);
    assert.equal(second.withheld, true);
  });

  it("counts neither a same-day retry nor an older observation as another failing day", () => {
    const first = advanceOfficialMcpCheck(undefined, false, "2026-10-20", "deprecated");
    assert.equal(advanceOfficialMcpCheck(first, false, "2026-10-20", "deprecated"), first);
    assert.equal(advanceOfficialMcpCheck(first, false, "2026-10-19", "deprecated"), first);
  });

  it("requires calendar adjacency rather than two arbitrary failures", () => {
    const first = advanceOfficialMcpCheck(undefined, false, "2026-10-20");
    const afterGap = advanceOfficialMcpCheck(first, false, "2026-10-22");
    assert.equal(afterGap.failure_streak, 1);
    assert.equal(afterGap.withheld, false);
    const next = advanceOfficialMcpCheck(afterGap, false, "2026-10-23");
    assert.equal(next.withheld, true);
    assert.equal(advanceOfficialMcpCheck(next, false, "2026-10-27").withheld, true);
  });

  it("restores publication after a passing check and clears the failure detail", () => {
    const first = advanceOfficialMcpCheck(undefined, false, "2026-10-20", "missing quote");
    const second = advanceOfficialMcpCheck(first, false, "2026-10-21", "missing quote");
    const recovered = advanceOfficialMcpCheck(second, true, "2026-10-22");
    assert.deepEqual(recovered, { checked_on: "2026-10-22", passed: true, failure_streak: 0, withheld: false });
    const failedAgain = advanceOfficialMcpCheck(recovered, false, "2026-10-23");
    assert.equal(failedAgain.withheld, false);
    assert.equal(failedAgain.failure_streak, 1);
  });

  it("counts adjacent days across month and year boundaries", () => {
    for (const [day, next] of [["2026-10-31", "2026-11-01"], ["2026-12-31", "2027-01-01"], ["2028-02-29", "2028-03-01"]]) {
      const first = advanceOfficialMcpCheck(undefined, false, day);
      assert.equal(advanceOfficialMcpCheck(first, false, next).withheld, true);
    }
    assert.throws(() => advanceOfficialMcpCheck(undefined, false, "2026-02-30"));
  });
});

describe("official MCP publication", () => {
  it("preserves a listing with no field and never interprets absence as a negative claim", () => {
    assert.equal(withCheckedOfficialMcp(listing, {}), listing);
    assert.equal(JSON.stringify(withCheckedOfficialMcp(listing, {})), JSON.stringify(listing));
  });

  it("filters individual entries without changing the curated field", () => {
    const original = { ...listing, official_mcp_servers: [remote, npm] };
    const before = JSON.stringify(original);
    const failed = advanceOfficialMcpCheck(advanceOfficialMcpCheck(undefined, false, "2026-10-20"), false, "2026-10-21");
    const key = officialMcpKey(listing, remote);
    assert.deepEqual(withCheckedOfficialMcp(original, { [key]: failed }).official_mcp_servers, [npm]);
    assert.equal(JSON.stringify(original), before);
    const allFailed = { [key]: failed, [officialMcpKey(listing, npm)]: failed };
    assert.equal("official_mcp_servers" in withCheckedOfficialMcp(original, allFailed), false);
    assert.equal(withCheckedOfficialMcp(original, {}), original);
  });

  it("keeps unchecked entries and the first failing day publishable", () => {
    const original = { ...listing, official_mcp_servers: [remote] };
    const first = advanceOfficialMcpCheck(undefined, false, "2026-10-20");
    assert.equal(withCheckedOfficialMcp(original, { [officialMcpKey(listing, remote)]: first }), original);
  });

  it("keys every evidence field and the listing identity independently of object property order", () => {
    const original = officialMcpKey(listing, remote);
    const reordered = Object.fromEntries(Object.entries(remote).reverse()) as typeof remote;
    assert.equal(officialMcpKey(listing, reordered), original);
    for (const [field, value] of Object.entries(remote)) {
      assert.notEqual(officialMcpKey(listing, { ...remote, [field]: value + " changed" }), original, field);
    }
    for (const field of ["vendor", "url", "tier"]) {
      assert.notEqual(officialMcpKey({ ...listing, [field]: "different" }, remote), original, field);
    }
    assert.notEqual(officialMcpKey(listing, npm), officialMcpKey(listing, { ...npm, retired_names: [] }));
  });

  it("prints the sourced remote passage without composing a command", () => {
    assert.equal(officialMcpPassage("Example", remote),
      'Example runs its own MCP server. "The MCP server connects an AI agent to your workspace." (From https://docs.example.com/mcp, read 2026-10-20.) The endpoint is https://api.example.com/mcp, the transport is Streamable HTTP, and authentication uses the header "Authorization: Bearer <API_KEY>".');
  });

  it("prints the package and registry notice with their own read dates", () => {
    assert.equal(officialMcpPassage("Example", npm),
      'Example runs its own MCP server. "The MCP server connects an AI agent to your workspace." (From https://docs.example.com/mcp, read 2026-10-20.) The npm package is @example/mcp-server, the transport is stdio, and authentication uses an API key. npm marks @example/old-server "Package no longer supported." (From https://www.npmjs.com/package/@example/old-server, read 2026-10-20.)');
  });
});
