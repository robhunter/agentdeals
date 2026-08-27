import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

export interface RegisterRow {
  path: string;
  published: string;
  tier: string;
  reviewed_at: string | null;
  reviewer: string | null;
  review_outcome: string | null;
  [field: string]: unknown;
}

export const NEVER_REVIEWED: Partial<RegisterRow> = {
  reviewed_at: null,
  reviewer: null,
  review_outcome: null,
};

export function reviewFailedOn(date: string): Partial<RegisterRow> {
  return { reviewed_at: date, reviewer: "fixture", review_outcome: "fail" };
}

export interface RegisterFixture {
  dir: string;
  file: string;
  row(pagePath: string): RegisterRow;
}

export function registerWith(
  repo: string,
  prefix: string,
  overrides: Record<string, Partial<RegisterRow>>,
): RegisterFixture {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  const register = JSON.parse(readFileSync(path.join(repo, "data", "page-reviews.json"), "utf-8"));
  const row = (pagePath: string): RegisterRow => {
    const found = register.pages.find((p: RegisterRow) => p.path === pagePath);
    if (!found) throw new Error(`${pagePath} is not on the register, so a fixture built on it stands for nothing`);
    return found;
  };
  for (const [pagePath, fields] of Object.entries(overrides)) Object.assign(row(pagePath), fields);
  const file = path.join(dir, "page-reviews.json");
  writeFileSync(file, JSON.stringify(register));
  return { dir, file, row };
}
