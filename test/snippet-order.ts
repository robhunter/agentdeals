import assert from "node:assert";

const { NOTHING_CONTRADICTS_OUR_TERMS_FOR } = await import("../dist/data.js");

export function appendedAfter(description: string, clause: string, other: string): boolean {
  const beside = description.indexOf(other);
  if (beside === -1) return false;
  return description.indexOf(clause) > beside;
}

export function statesBoth(description: string, clause: string, other: string): boolean {
  return description.includes(clause) && description.includes(other);
}

export function assertAheadOfTheVendorList(description: string, clause: string, where: string): boolean {
  assert.ok(
    !appendedAfter(description, clause, NOTHING_CONTRADICTS_OUR_TERMS_FOR),
    `${where} appends the clause after the vendor list, where a snippet truncates it: ${description}`,
  );
  return statesBoth(description, clause, NOTHING_CONTRADICTS_OUR_TERMS_FOR);
}
