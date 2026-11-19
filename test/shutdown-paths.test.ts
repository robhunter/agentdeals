import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { shutdownPath, shutdownPaths } from "../dist/shutdown-paths.js";

describe("shutdown paths", () => {
  const entry = { vendorSlug: "openai", service: "Realtime API Beta", deadline: "2026-05-12" };

  it("distinguishes services from the same vendor on the same day", () => {
    const other = { ...entry, service: "DALL·E Model Snapshots" };
    assert.equal(shutdownPaths([entry, other]).size, 2);
    assert.equal(shutdownPath(entry), "/shutdowns/openai-2026-05-12-realtime-api-beta");
  });

  it("uses the first stage independently of stage order", () => {
    const stages = [{ date: "2026-12-22", label: "reads end" }, { date: "2026-12-07", label: "read-only" }];
    assert.equal(shutdownPath({ ...entry, deadline: "2026-12-22", stages }), "/shutdowns/openai-2026-12-07-realtime-api-beta");
  });

  it("rejects collisions and malformed identities", () => {
    assert.throws(() => shutdownPaths([entry, { ...entry, service: "Realtime API: Beta" }]), /Duplicate shutdown page/);
    assert.throws(() => shutdownPath({ ...entry, service: "!!!" }), /Invalid shutdown page identity/);
    assert.throws(() => shutdownPath({ ...entry, deadline: "tomorrow" }), /Invalid shutdown page identity/);
  });

  it("supports a month-only date", () => {
    assert.equal(shutdownPath({ ...entry, deadline: "2027-03" }), "/shutdowns/openai-2027-03-realtime-api-beta");
  });
});
