import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { reconcileShutdownRedirects } from "../dist/shutdown-redirects.js";

describe("shutdown redirects", () => {
  const oldPath = "/shutdowns/example-2026-12-01";
  const newPath = "/shutdowns/example-2026-12-08";

  it("requires a redirect when a previously listed page disappears", () => {
    assert.throws(() => reconcileShutdownRedirects([oldPath], [newPath], {}), /needs a redirect/);
    assert.equal(reconcileShutdownRedirects([oldPath], [newPath], { [oldPath]: newPath }).get(oldPath), newPath);
  });

  it("requires every target to be a current page, including older redirects", () => {
    const laterPath = "/shutdowns/example-2027-01-01";
    assert.throws(() => reconcileShutdownRedirects([], [laterPath], { [oldPath]: newPath }), /target is not a page/);
    const redirects = reconcileShutdownRedirects([], [laterPath], { [oldPath]: laterPath, [newPath]: laterPath });
    assert.equal(redirects.size, 2);
  });

  it("rejects a redirect that shadows a page or escapes the shutdown paths", () => {
    assert.throws(() => reconcileShutdownRedirects([], [oldPath, newPath], { [oldPath]: newPath }), /shadows a page/);
    assert.throws(() => reconcileShutdownRedirects([], [newPath], { "/vendor/example": newPath }), /Invalid shutdown redirect/);
    assert.throws(() => reconcileShutdownRedirects([], ["/vendor/example"], { [oldPath]: "/vendor/example" }), /Invalid shutdown redirect/);
  });

  it("leaves current shutdown pages and unrelated pages alone", () => {
    assert.equal(reconcileShutdownRedirects([oldPath, "/guides/example"], [oldPath], {}).size, 0);
  });
});
