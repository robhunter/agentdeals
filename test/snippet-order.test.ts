import { describe, it } from "node:test";
import assert from "node:assert";
import { appendedAfter, statesBoth, vendorsNamedAsUncontradicted } from "./snippet-order.ts";

const { NOTHING_CONTRADICTS_OUR_TERMS_FOR } = await import("../dist/data.js");

const QUALIFICATION = "1 requires an application or qualification.";
const VENDOR_LIST = `${NOTHING_CONTRADICTS_OUR_TERMS_FOR} Render, Fly.io, Railway.`;
const OPENING = "Compare 6 free education tools, free tiers, and developer deals.";
const UNCONFIRMED = "We could not confirm today's terms for 6 of them, and each says which and why.";

describe("a search snippet states its qualification ahead of the vendor list", () => {
  it("accepts a description that states the qualification first", () => {
    const description = `${OPENING} ${QUALIFICATION} ${VENDOR_LIST}`;
    assert.strictEqual(appendedAfter(description, QUALIFICATION, NOTHING_CONTRADICTS_OUR_TERMS_FOR), false);
    assert.strictEqual(statesBoth(description, QUALIFICATION, NOTHING_CONTRADICTS_OUR_TERMS_FOR), true);
  });

  it("refuses a description that appends the qualification after the vendor list", () => {
    const description = `${OPENING} ${VENDOR_LIST} ${QUALIFICATION}`;
    assert.strictEqual(appendedAfter(description, QUALIFICATION, NOTHING_CONTRADICTS_OUR_TERMS_FOR), true);
    assert.strictEqual(statesBoth(description, QUALIFICATION, NOTHING_CONTRADICTS_OUR_TERMS_FOR), true);
  });

  it("accepts a description naming no uncontradicted vendor at all", () => {
    const description = `${OPENING} ${QUALIFICATION} ${UNCONFIRMED}`;
    assert.ok(!description.includes(NOTHING_CONTRADICTS_OUR_TERMS_FOR));
    assert.strictEqual(appendedAfter(description, QUALIFICATION, NOTHING_CONTRADICTS_OUR_TERMS_FOR), false);
    assert.strictEqual(statesBoth(description, QUALIFICATION, NOTHING_CONTRADICTS_OUR_TERMS_FOR), false);
  });

  it("accepts a description that opens on the qualification and names no vendor list", () => {
    const description = `${QUALIFICATION} ${UNCONFIRMED}`;
    assert.strictEqual(description.indexOf(QUALIFICATION), 0);
    assert.strictEqual(appendedAfter(description, QUALIFICATION, NOTHING_CONTRADICTS_OUR_TERMS_FOR), false);
  });

  it("accepts a description that opens on the qualification and carries a vendor list behind it", () => {
    const description = `${QUALIFICATION} ${VENDOR_LIST}`;
    assert.strictEqual(description.indexOf(QUALIFICATION), 0);
    assert.strictEqual(appendedAfter(description, QUALIFICATION, NOTHING_CONTRADICTS_OUR_TERMS_FOR), false);
  });

  it("accepts a description that states the vendor list and no qualification", () => {
    const description = `${OPENING} ${VENDOR_LIST}`;
    assert.strictEqual(appendedAfter(description, QUALIFICATION, NOTHING_CONTRADICTS_OUR_TERMS_FOR), false);
    assert.strictEqual(statesBoth(description, QUALIFICATION, NOTHING_CONTRADICTS_OUR_TERMS_FOR), false);
  });

  it("reads an ordering between two clauses that are both stated, whichever comes first", () => {
    assert.strictEqual(appendedAfter("a b", "b", "a"), true);
    assert.strictEqual(appendedAfter("a b", "a", "b"), false);
    assert.strictEqual(appendedAfter("a b", "a", "a"), false);
  });
});

describe("the vendors a description names as uncontradicted", () => {
  it("reads every name where one of them carries a dot", () => {
    assert.deepStrictEqual(
      vendorsNamedAsUncontradicted(`${OPENING} ${QUALIFICATION} ${VENDOR_LIST}`),
      ["Render", "Fly.io", "Railway"],
    );
  });

  it("reads the names ahead of a truncated tail and not the tail", () => {
    const description = `${OPENING} ${NOTHING_CONTRADICTS_OUR_TERMS_FOR} Cal.com, Trigger.dev, cdnjs.com and more.`;
    assert.deepStrictEqual(vendorsNamedAsUncontradicted(description), ["Cal.com", "Trigger.dev", "cdnjs.com"]);
  });

  it("reads a list of one", () => {
    const description = `${OPENING} ${NOTHING_CONTRADICTS_OUR_TERMS_FOR} Proton VPN.`;
    assert.deepStrictEqual(vendorsNamedAsUncontradicted(description), ["Proton VPN"]);
  });

  it("names nobody where the description carries no vendor list", () => {
    assert.deepStrictEqual(vendorsNamedAsUncontradicted(`${OPENING} ${QUALIFICATION} ${UNCONFIRMED}`), []);
  });

  it("refuses to read a list that something else follows", () => {
    assert.throws(
      () => vendorsNamedAsUncontradicted(`${OPENING} ${VENDOR_LIST} ${QUALIFICATION}`),
      /runs to the end of the description/,
    );
  });
});
