import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(__dirname, "..");

const PAGES = ["/openai-assistants-alternatives", "/openai-assistants-migration", "/openai-assistants-migration-2026"];

const STATED: Record<string, string[]> = {
  "/openai-assistants-alternatives": [
    "OpenAI shut down the Assistants API on August 26, 2026; it is no longer available.",
    "OpenAI shut down the Assistants API on August 26, 2026. Compare migration paths",
  ],
  "/openai-assistants-migration": [
    "When did the OpenAI Assistants API shut down?",
    "OpenAI shut down the Assistants API on August 26, 2026; it is no longer available. OpenAI recommends the Responses API for prompts and tool use and the Conversations API for thread and session state.",
    "OpenAI sunset the Assistants API on August 26, 2026, and it is no longer available.",
    "OpenAI shut down the Assistants API on August 26, 2026. Compare migration costs",
  ],
  "/openai-assistants-migration-2026": [
    "Since the shutdown on August 26, 2026, Assistants API calls no longer work, including the call that retrieves thread messages; OpenAI says to migrate history from messages your application stored.",
  ],
};

const WITHDRAWN = [
  "will be fully shut down",
  "shuts down August 26, 2026",
  "When does the OpenAI Assistants API shut down?",
  "is sunsetting the Assistants API",
  "will stop working",
  "Export your data before the deadline",
  "Assistants API v2 still functional",
  "the shutdown date is firm",
  "until Assistants API shutdown",
  "Days Remaining",
  "Days to Shutdown",
];

const COUNTDOWN = /\b\d+\s*days?\s+(?:remaining|left|until|to shutdown)\b|\b\d+\s*days?\s*<\/div>/i;

const ENTITIES: Record<string, string> = {
  "&mdash;": "—", "&ndash;": "–", "&amp;": "&", "&quot;": '"', "&#39;": "'", "&#x27;": "'",
  "&rsquo;": "’", "&nbsp;": " ", "&middot;": "·", "&rarr;": "→",
};

function readable(html: string): string {
  return html
    .replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, " ")
    .replace(/<\/?(?:a|abbr|b|code|em|i|small|span|strong|sub|sup)\b[^>]*>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&[a-z#0-9]+;/gi, (e) => ENTITIES[e] ?? e)
    .replace(/\s+/g, " ")
    .trim();
}

function structuredStrings(html: string): string[] {
  const strings: string[] = [];
  for (const m of html.matchAll(/<meta[^>]+content="([^"]*)"/gi)) strings.push(m[1]);
  for (const [, raw] of html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/gi)) {
    const walk = (value: unknown): void => {
      if (typeof value === "string") strings.push(value);
      else if (value && typeof value === "object") Object.values(value).forEach(walk);
    };
    try {
      walk(JSON.parse(raw));
    } catch {
      continue;
    }
  }
  return strings;
}

function faqQuestions(html: string): Map<string, string> {
  const found = new Map<string, string>();
  for (const [, raw] of html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/gi)) {
    let parsed: any;
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue;
    }
    for (const entry of Array.isArray(parsed) ? parsed : [parsed]) {
      if (entry?.["@type"] !== "FAQPage") continue;
      for (const q of entry.mainEntity ?? []) found.set(q.name, q.acceptedAnswer?.text ?? "");
    }
  }
  return found;
}

let server: ChildProcess;
const served = new Map<string, string>();

describe("the OpenAI Assistants pages say the API has shut down", () => {
  before(async () => {
    server = spawn("node", [path.join(REPO, "dist", "serve.js")], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, PORT: "0", BASE_URL: "http://localhost", TZ: "UTC" },
    });
    const base = await new Promise<string>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Server startup timeout")), 30000);
      server.stderr!.on("data", (data: Buffer) => {
        const match = data.toString().match(/running on http:\/\/localhost:(\d+)/);
        if (match) {
          clearTimeout(timeout);
          resolve(`http://localhost:${match[1]}`);
        }
      });
      server.on("error", (err) => {
        clearTimeout(timeout);
        reject(err);
      });
    });
    for (const page of PAGES) {
      const response = await fetch(`${base}${page}`);
      assert.strictEqual(response.status, 200, `${page} answered ${response.status}`);
      served.set(page, await response.text());
    }
  });
  after(() => {
    server?.kill();
  });

  it("states the shutdown in the past tense where the pages said it was coming", () => {
    const missing = Object.entries(STATED).flatMap(([page, lines]) => {
      const html = served.get(page)!;
      const text = `${readable(html)} ${structuredStrings(html).join(" ")}`;
      return lines.filter((line) => !text.includes(line)).map((line) => `${page}: ${line}`);
    });
    assert.deepStrictEqual(missing, []);
  });

  it("keeps none of the future-tense lines, countdowns or deadline advice on any of the three pages", () => {
    const kept = PAGES.flatMap((page) => {
      const html = served.get(page)!;
      const text = `${readable(html)} ${structuredStrings(html).join(" ")}`;
      return [
        ...WITHDRAWN.filter((line) => text.includes(line)).map((line) => `${page}: "${line}"`),
        ...(COUNTDOWN.test(html) ? [`${page}: counts days (${html.match(COUNTDOWN)![0]})`] : []),
      ];
    });
    assert.deepStrictEqual(kept, []);
  });

  it("asks and answers the shutdown question in the past tense in the page's structured FAQ", () => {
    const faq = faqQuestions(served.get("/openai-assistants-migration")!);
    assert.ok(faq.has("When did the OpenAI Assistants API shut down?"), `questions: ${[...faq.keys()].join(" | ")}`);
    assert.ok(
      faq.get("When did the OpenAI Assistants API shut down?")!.startsWith("OpenAI shut down the Assistants API on August 26, 2026; it is no longer available."),
      faq.get("When did the OpenAI Assistants API shut down?")
    );
  });
});
