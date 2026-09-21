export function appendedAfter(description: string, clause: string, other: string): boolean {
  const beside = description.indexOf(other);
  if (beside === -1) return false;
  return description.indexOf(clause) > beside;
}

export function statesBoth(description: string, clause: string, other: string): boolean {
  return description.includes(clause) && description.includes(other);
}
