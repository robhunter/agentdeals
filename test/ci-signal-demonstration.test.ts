import { describe, it } from "node:test";
import assert from "node:assert";

describe("the check this workflow is meant to produce", () => {
  it("fails on purpose so the pull request shows a red check", () => {
    assert.strictEqual(1, 2, "this test exists only to prove a failing suite blocks nothing silently, and is removed in the next commit");
  });
});
