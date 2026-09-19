import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  README_TOOLS_HEADING,
  SKILL_TOOLS_HEADING,
  readmeToolsSection,
  skillToolsSection,
} from "../dist/mcp-tool-inventory.js";

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

export function toTheNextHeading(markdown, start, heading) {
  const next = markdown.indexOf("\n## ", start + heading.length);
  return next < 0 ? markdown.length : next + 1;
}

export function toTheEndOfTheTable(markdown, start, heading) {
  let cursor = start + heading.length;
  let end = cursor;
  for (const line of markdown.slice(cursor).split("\n")) {
    cursor += line.length + 1;
    if (line.startsWith("|")) end = cursor;
    else if (line.trim().length > 0) break;
  }
  return end;
}

export function withSection(markdown, heading, rendered, endOfSection) {
  const start = markdown.indexOf(`${heading}\n`);
  if (start < 0) throw new Error(`no "${heading}" section to replace`);
  const end = endOfSection(markdown, start, heading);
  const trailing = markdown.slice(start, end).match(/\n*$/)?.[0] ?? "\n";
  return markdown.slice(0, start) + rendered + trailing + markdown.slice(end);
}

export const PUBLISHED_TOOL_COPIES = [
  { file: "SKILL.md", heading: SKILL_TOOLS_HEADING, render: skillToolsSection, endOfSection: toTheNextHeading },
  { file: "README.md", heading: README_TOOLS_HEADING, render: readmeToolsSection, endOfSection: toTheEndOfTheTable },
];

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  for (const copy of PUBLISHED_TOOL_COPIES) {
    const full = path.join(REPO, copy.file);
    const before = readFileSync(full, "utf8");
    const after = withSection(before, copy.heading, copy.render(), copy.endOfSection);
    if (before === after) {
      console.log(`${copy.file}: already states the contract the registry holds`);
      continue;
    }
    writeFileSync(full, after);
    console.log(`${copy.file}: rewrote "${copy.heading}" from the registry`);
  }
}
