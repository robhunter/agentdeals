import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(__dirname, "..");

const PAGES = ["/tenor-alternatives", "/aws-app-runner-migration", "/q2-pricing-preview-2026"];

const STATED: Record<string, string[]> = {
  "/tenor-alternatives": [
    "What happened: Google shut down the Tenor GIF API on June 30, 2026. New API key sign-ups stopped on January 13, 2026, and Google says any API request after June 30 fails with an error. Only the API was discontinued: Tenor content stays available in Google's own apps, including Gboard, Tenor.com and the GIF Keyboard app.",
    "Who was affected: apps, bots and forums that used the Tenor API for inline GIF search, including Discord, WhatsApp and Bluesky.",
    "Complete API shutdown. Existing API keys stopped working; Google says every API request now fails with an error.",
    "that used the Tenor API for GIF search.",
    'Why Google shut it down: Google says the decision is part of "an ongoing effort to focus resources on enhancing our core products."',
  ],
  "/aws-app-runner-migration": [
    "AWS App Runner closed to new customers on April 30, 2026.",
    "What happened: AWS App Runner stopped accepting new customers on April 30, 2026. Existing customers can keep using it as normal, including creating new services, and AWS says it does not plan new features. AWS recommends Amazon ECS Express Mode for migrating.",
    "AWS announces that App Runner closes to new customers on April 30, 2026, with no new features planned, and recommends ECS Express Mode.",
  ],
  "/q2-pricing-preview-2026": [
    "Since this preview was published: Hetzner's price changes took effect on April 1, 2026, for new orders and existing products. Google shut down the Tenor API on June 30, 2026, and OpenAI shut down the Assistants API on August 26, 2026.",
  ],
};

const STATUS_CARDS: Record<string, string> = {
  "/tenor-alternatives": '<div class="stat-number red">Shut down</div><div class="stat-label">June 30, 2026</div>',
  "/aws-app-runner-migration": '<div class="stat-number red">Closed</div><div class="stat-label">To new customers since April 30, 2026</div>',
};

const APP_RUNNER_ANSWERS: Record<string, string> = {
  "When does AWS App Runner shut down?":
    "AWS App Runner closed to new customers on April 30, 2026. Existing customers can keep using it, including creating new services, and AWS says it does not plan new features. AWS has not announced a shutdown date for existing services, and recommends Amazon ECS Express Mode for migrations.",
  "Can I still use App Runner if I'm already a customer?":
    "Yes. AWS says existing customers can continue to use App Runner as normal, including creating new services. AWS does not plan new features and recommends ECS Express Mode when you migrate.",
};

const WITHDRAWN = [
  "until Tenor API shutdown",
  "until App Runner closes to new customers",
  "Days Remaining",
  "Act now",
  "Google is shutting down the Tenor GIF API",
  "Existing API keys will stop working",
  "the June 30 deadline is approaching fast",
  "wait until close to the June 30 deadline",
  "started migration yet",
  "Why Google is shutting it down",
  "Discord is testing Giphy and Klipy",
  "Bluesky is actively working on migration",
  "will stop accepting new customers",
  "stops accepting new customers on April 30, 2026",
  "closes to new customers April 30, 2026",
  "has entered maintenance mode",
  "strongly recommends planning a migration",
  "Key action item",
  "evaluate alternatives or optimize before April 1",
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

describe("the Tenor, App Runner and Q2 preview pages state their deadlines as past events", () => {
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

  it("states each passed deadline as what happened", () => {
    const missing = Object.entries(STATED).flatMap(([page, lines]) => {
      const html = served.get(page)!;
      const text = `${readable(html)} ${structuredStrings(html).join(" ")}`;
      return lines.filter((line) => !text.includes(line)).map((line) => `${page}: ${line}`);
    });
    assert.deepStrictEqual(missing, []);
  });

  it("shows a fixed status and the date where the pages counted days", () => {
    const wrong = Object.entries(STATUS_CARDS)
      .filter(([page, card]) => !served.get(page)!.includes(card))
      .map(([page]) => page);
    assert.deepStrictEqual(wrong, []);
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

  it("answers App Runner's two questions with the closure to new customers in its structured FAQ", () => {
    const faq = faqQuestions(served.get("/aws-app-runner-migration")!);
    for (const [question, answer] of Object.entries(APP_RUNNER_ANSWERS)) {
      assert.strictEqual(faq.get(question), answer, question);
    }
  });
});
