import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { shutdownPath, shutdownPaths } from "../dist/shutdown-paths.js";

describe("shutdown paths", () => {
  const entry = { vendorSlug: "openai", service: "Realtime API Beta", deadline: "2026-05-12", identity: "Realtime API Beta shutdown" };

  it("distinguishes services from the same vendor on the same day", () => {
    const other = { ...entry, service: "DALL·E Model Snapshots" };
    assert.equal(shutdownPaths([entry, other]).size, 2);
    assert.match(shutdownPath(entry), /^\/shutdowns\/openai-2026-05-12-realtime-api-beta-[0-9a-f]{16}$/);
  });

  it("uses the first stage independently of stage order", () => {
    const stages = [{ date: "2026-12-22", label: "reads end" }, { date: "2026-12-07", label: "read-only" }];
    assert.match(shutdownPath({ ...entry, deadline: "2026-12-22", stages }), /^\/shutdowns\/openai-2026-12-07-realtime-api-beta-/);
  });

  it("rejects collisions and malformed identities", () => {
    assert.throws(() => shutdownPaths([entry, { ...entry, service: "Realtime API: Beta" }]), /Duplicate shutdown page/);
    assert.throws(() => shutdownPath({ ...entry, service: "!!!" }), /Invalid shutdown page identity/);
    assert.throws(() => shutdownPath({ ...entry, deadline: "tomorrow" }), /Invalid shutdown page identity/);
  });

  it("supports a month-only date", () => {
    assert.match(shutdownPath({ ...entry, deadline: "2027-03" }), /^\/shutdowns\/openai-2027-03-realtime-api-beta-/);
  });

  it("distinguishes same-service records without depending on their order", () => {
    const other = { ...entry, identity: "Another shutdown" };
    assert.notEqual(shutdownPath(entry), shutdownPath(other));
    assert.deepEqual([...shutdownPaths([entry, other]).keys()].sort(), [...shutdownPaths([other, entry]).keys()].sort());
  });
});

describe("grouped shutdown paths", () => {
  const first = { vendorSlug: "nvidia-nim", service: "NVIDIA NIM", deadline: "2026-11-16", identity: "First retirement" };
  const second = { ...first, deadline: "2026-11-18", identity: "Second retirement" };
  const third = { ...first, deadline: "2026-12-01", identity: "Third retirement" };

  it("redirects each former member and group URL to the current group", async () => {
    const { groupedShutdownRedirects } = await import("../dist/shutdown-paths.js");
    assert.deepEqual([...groupedShutdownRedirects([first], first)], []);
    assert.deepEqual([...groupedShutdownRedirects([first, second], second)], [[shutdownPath(first), shutdownPath(second)]]);
    const redirects = groupedShutdownRedirects([first, second, third], third);
    assert.equal(redirects.get(shutdownPath(first)), shutdownPath(third));
    assert.equal(redirects.get(shutdownPath(second)), shutdownPath(third));
    assert.equal(redirects.size, 2);
  });

  it("rejects missing groups, nonmembers and colliding member paths", async () => {
    const { groupedShutdownRedirects } = await import("../dist/shutdown-paths.js");
    assert.equal(groupedShutdownRedirects([], undefined).size, 0);
    assert.throws(() => groupedShutdownRedirects([first], undefined), /missing/);
    assert.throws(() => groupedShutdownRedirects([first], second), /not a member/);
    assert.throws(() => groupedShutdownRedirects([first, first], first), /Duplicate/);
  });
});
