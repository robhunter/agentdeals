import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src");
const CALL = /(?<!function )recordSearchQuery\(/g;
const SOURCE_LITERAL = /\bsource:\s*"([^"]+)"/;

export interface SearchRecordingCall {
  file: string;
  line: number;
  source: string | null;
}

function callSpan(source: string, open: number): string {
  let depth = 0;
  let quote: string | null = null;
  for (let at = open; at < source.length; at++) {
    const char = source[at]!;
    if (quote) {
      if (char === "\\") at++;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'" || char === "`") quote = char;
    else if (char === "(") depth++;
    else if (char === ")") {
      depth--;
      if (depth === 0) return source.slice(open, at + 1);
    }
  }
  return source.slice(open);
}

export function searchRecordingCalls(): SearchRecordingCall[] {
  const found: SearchRecordingCall[] = [];
  for (const file of readdirSync(SRC).filter((name) => name.endsWith(".ts")).sort()) {
    const text = readFileSync(path.join(SRC, file), "utf-8");
    for (const call of text.matchAll(CALL)) {
      const open = call.index + call[0].length - 1;
      found.push({
        file,
        line: text.slice(0, call.index).split("\n").length,
        source: callSpan(text, open).match(SOURCE_LITERAL)?.[1] ?? null,
      });
    }
  }
  return found;
}
