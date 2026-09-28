import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import { rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { registerWith, reviewFailedOn, reviewPassedOn } from "./page-review-fixture.ts";

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const PAGE = "/shutdowns";
const SITEMAPS = ["/sitemap-pages.xml", "/sitemap-reports.xml", "/sitemap-misc.xml"];

interface Card {
  date: string;
  what: string;
  "Who’s affected": string;
  Impact: string;
  "Migration path": string;
}

const NEW_CARD: [string, Card] = ["OpenAI legacy GPT models (September 2026)", {
  date: "September 28, 2026",
  what: "gpt-3.5-turbo-instruct, babbage-002, davinci-002 and gpt-3.5-turbo-1106 shut down in the OpenAI API on September 28, 2026. Fine-tuned babbage-002 and davinci-002 models (ft-babbage-002, ft-davinci-002) are listed separately, for October 23, 2026.",
  "Who’s affected": "Developers calling these model IDs. gpt-3.5-turbo-instruct, babbage-002 and davinci-002 run on the legacy Completions endpoint (/v1/completions).",
  Impact: "Calls to these model IDs stop working.",
  "Migration path": "OpenAI names gpt-5.6-terra as the replacement for all four. gpt-5.6-terra does not support /v1/completions, so calls on that endpoint must move to the Chat Completions or Responses API.",
}];

const FIELDS: Record<string, Partial<Card>> = {
  "OpenAI legacy model snapshots": {
    what: "gpt-3.5-turbo (gpt-3.5-turbo-0125, gpt-3.5-turbo-completions), gpt-4 (gpt-4-0613, gpt-4-0613-completions, gpt-4-completions), gpt-4-turbo (gpt-4-turbo-2024-04-09, gpt-4-turbo-completions), gpt-4.1-nano (gpt-4.1-nano-2025-04-14), gpt-4o-2024-05-13, o1 (o1-2024-12-17), o1-pro (o1-pro-2025-03-19), o3-mini (o3-mini-2025-01-31), o4-mini (o4-mini-2025-04-16) and gpt-image-1 shut down in the OpenAI API on October 23, 2026, with fine-tuned versions of gpt-3.5-turbo, gpt-4, gpt-4.1-nano, o4-mini, babbage-002 and davinci-002. OpenAI lists gpt-4-1106-preview for October 23, 2026, and also says access to it ended on March 26, 2026.",
    "Migration path": "OpenAI's substitutes: gpt-5.6-terra for gpt-3.5-turbo and o4-mini; gpt-5.6-sol for gpt-4, gpt-4-turbo, gpt-4-1106-preview, gpt-4o-2024-05-13, o1 and o3-mini; gpt-5.6-sol with reasoning.mode: pro for o1-pro; gpt-5.6-luna for gpt-4.1-nano; gpt-image-2 for gpt-image-1. Replacement base models for fine-tunes: gpt-5.6-terra for gpt-3.5-turbo, o4-mini, babbage-002 and davinci-002; gpt-5.6-sol for gpt-4; gpt-5.6-luna for gpt-4.1-nano. The gpt-5.6 models do not support fine-tuning or the legacy /v1/completions endpoint.",
  },
  "OpenAI Realtime API Beta": {
    what: "The Realtime API Beta (requests with the OpenAI-Beta: realtime=v1 header) was removed from the API on May 12, 2026.",
    "Who’s affected": "Integrations still on the beta interface. The GA Realtime API was not affected.",
    Impact: "Calls to the beta interface no longer work.",
    "Migration path": "Move to the GA Realtime API: remove the OpenAI-Beta: realtime=v1 header, create ephemeral credentials for browser or mobile clients with POST /v1/realtime/client_secrets, use /v1/realtime/calls for WebRTC sessions, set session.type, move output audio settings under session.audio.output, and use the GA response event names, such as response.output_text.delta, response.output_audio.delta and response.output_audio_transcript.delta.",
  },
  "OpenAI DALL·E Model Snapshots": {
    "Who’s affected": "Developers calling dall-e-2 or dall-e-3, including image generation calls (POST /v1/images/generations) that leave out the model parameter, which OpenAI's reference says default to dall-e-2 unless a parameter specific to the GPT image models is used, and any use of the image variations endpoint, which supports only dall-e-2.",
    "Migration path": "OpenAI's substitutes are gpt-image-2, gpt-image-1 or gpt-image-1-mini, and its DALL·E model pages now recommend GPT-Image-2.5 Sunburst. The GPT image models return base64-encoded images only (response_format is not supported), do not take style, and take quality low, medium or high instead of standard or hd; GPT-Image-2.5 Sunburst also takes xhigh and max. OpenAI may require API Organization Verification.",
  },
  "OpenAI Assistants API": {
    Impact: "The Assistants API shut down. The call that retrieves thread messages no longer works.",
    "Migration path": "OpenAI names the Responses API and the Conversations API as replacements. Its migration guide turns assistants into reusable prompts, but the v1/prompts API and reusable prompt objects are scheduled to shut down November 30, 2026; OpenAI's advice for prompts is to move their content into your application code.",
  },
  "OpenAI Videos API (Sora)": {
    "Who’s affected": "Developers using the Videos API (POST /v1/videos and the other /v1/videos endpoints) and the sora-2 and sora-2-pro models, including their dated snapshots.",
    Impact: "Calls to the Videos API and the Sora 2 models no longer work. OpenAI says there is no one-to-one replacement API.",
  },
  "Firebase Studio (Full Shutdown)": {
    "Migration path": "Google recommends Antigravity or Google AI Studio. Code can also be downloaded as a zip or pushed to GitHub. Apps already deployed to Firebase keep running.",
  },
  "Firebase Studio (New Workspaces)": {
    what: "New workspace creation and user signup for Firebase Studio are disabled.",
    "Who’s affected": "New users and developers creating new Firebase Studio workspaces. Existing workspaces keep working until March 22, 2027.",
    "Migration path": "Google recommends migrating existing workspaces to Google AI Studio or Google Antigravity. GitHub Codespaces (120 free core hours a month on a GitHub Free personal account) and Replit's free Starter plan are other options.",
  },
  "Google Maps Platform Client IDs": {
    what: "Google Maps Platform client IDs have been deprecated since May 26, 2025. Google says they can no longer be used after May 31, 2026. Since May 2026, Google has restricted access periodically as a phased deprecation, and it has published no final termination date.",
    Impact: "Client ID requests fail during Google's periodic restrictions, which Google says will increase in frequency and duration. Service usually returns within a few hours; project Owners or Editors can restore it sooner by unpausing the client ID in the Cloud Console, and developers who cannot migrate quickly can ask Google Maps Platform Support for a temporary exemption.",
  },
  "HubSpot Contact Lists API v1": {
    "Who’s affected": "Developers using the Contact Lists API v1 endpoints, or reading list memberships from Contacts API v1 endpoints.",
    Impact: "Contact Lists API v1 endpoints return HTTP 404. HubSpot's changelog said three endpoints listing all, recently updated or recently created contacts would keep working, but its current migration guide lists them as returning 404 too. Six Contacts API v1 read endpoints (a contact or a batch of contacts by visitor ID, email address or user token) still work but no longer return list memberships.",
    "Migration path": "Move to the Lists v3 API or a date-versioned Lists API (/crm/lists/2026-03 in HubSpot's migration guide; 2026-09 is the latest version). Map each v1 list ID (legacyListId) to its listId first: HubSpot warns that a v1 ID used on the new endpoints may update or delete the wrong list.",
  },
};

const WITHDRAWN = [
  "POST /v1/videos/generations",
  "mostly compatible, some parameter changes",
  "all Client ID auth will stop working",
  "new filtering syntax, pagination changes",
  "switch to Claude/Gemini/open-source frameworks",
];

const CONTROLS = [
  "Migrate to Klipy or GIPHY; both offer Tenor-compatible v2 endpoints",
  "Google recommends gemini-3.6-flash for 2.0 Flash",
];

const ENTITIES: Record<string, string> = {
  "&mdash;": "—", "&ndash;": "–", "&amp;": "&", "&quot;": '"', "&#39;": "'", "&#x27;": "'",
  "&rsquo;": "’", "&nbsp;": " ", "&middot;": "·", "&lt;": "<", "&gt;": ">",
};

function decoded(text: string): string {
  return text.replace(/&[a-z#0-9]+;/gi, (e) => ENTITIES[e] ?? e);
}

function readable(html: string): string {
  return decoded(html.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
}

function cardsOn(html: string): Map<string, Card> {
  const cards = new Map<string, Card>();
  for (const chunk of html.split('<div class="shutdown-card"').slice(1)) {
    const service = readable(chunk.match(/<h3[^>]*>([\s\S]*?)<\/h3>/)?.[1] ?? "");
    const rows = Object.fromEntries(
      [...chunk.matchAll(/<span class="detail-label">([^<]+):<\/span> <span>([\s\S]*?)<\/span><\/div>/g)].map(([, label, value]) => [decoded(label), readable(value)])
    );
    cards.set(service, {
      date: readable(chunk.match(/<span class="deadline-icon">[^<]*<\/span>\s*<span>([^<]+)<\/span>/)?.[1] ?? ""),
      what: readable(chunk.match(/<p class="shutdown-what">([\s\S]*?)<\/p>/)?.[1] ?? ""),
      "Who’s affected": rows["Who’s affected"] ?? "",
      Impact: rows["Impact"] ?? "",
      "Migration path": rows["Migration path"] ?? "",
    });
  }
  return cards;
}

function startServer(env: NodeJS.ProcessEnv = {}): Promise<{ proc: ChildProcess; base: string }> {
  const proc = spawn("node", [path.join(REPO, "dist", "serve.js")], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, PORT: "0", BASE_URL: "http://localhost", TZ: "UTC", ...env },
  });
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Server startup timeout")), 30000);
    proc.stderr!.on("data", (data: Buffer) => {
      const match = data.toString().match(/running on http:\/\/localhost:(\d+)/);
      if (match) {
        clearTimeout(timeout);
        resolve({ proc, base: `http://localhost:${match[1]}` });
      }
    });
    proc.on("error", (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });
}

function dateModifiedOn(html: string): string | null {
  return html.match(/"dateModified"\s*:\s*"(\d{4}-\d{2}-\d{2})"/)?.[1] ?? null;
}

let server: ChildProcess;
const served = new Map<string, string>();

describe("the shutdown tracker states each shutdown as the vendor's own pages do", () => {
  before(async () => {
    const started = await startServer();
    server = started.proc;
    const routes = new Set<string>([PAGE]);
    for (const sitemap of SITEMAPS) {
      const xml = await (await fetch(`${started.base}${sitemap}`)).text();
      for (const [, loc] of xml.matchAll(/<loc>([^<]+)<\/loc>/g)) routes.add(new URL(loc).pathname);
    }
    for (const route of routes) {
      const response = await fetch(`${started.base}${route}`);
      if (response.status === 200) served.set(route, await response.text());
    }
  });
  after(() => {
    server?.kill();
  });

  it("has a card for OpenAI's September 28 shutdown, dated and written as OpenAI lists it", () => {
    const [service, expected] = NEW_CARD;
    assert.deepStrictEqual(cardsOn(served.get(PAGE)!).get(service), expected);
  });

  it("counts every card, the new one included, in exactly one of the page's sections and in its structured list", () => {
    const html = served.get(PAGE)!;
    const cards = cardsOn(html);
    const sectionCounts = [...html.matchAll(/class="section-count"[^>]*>\((\d+)\)/g)].reduce((sum, [, n]) => sum + Number(n), 0);
    assert.strictEqual(sectionCounts, cards.size);
    const listed = html.match(/"numberOfItems":(\d+)/)?.[1];
    assert.strictEqual(Number(listed), cards.size);
    assert.ok(html.includes(`"name":"${NEW_CARD[0]}"`), "the new card is not in the structured list");
  });

  it("states every corrected field as written", () => {
    const cards = cardsOn(served.get(PAGE)!);
    const wrong = Object.entries(FIELDS).flatMap(([service, fields]) => {
      const card = cards.get(service);
      if (!card) return [`${service}: no card`];
      return Object.entries(fields)
        .filter(([field, text]) => card[field as keyof Card] !== text)
        .map(([field]) => `${service} ${field}: "${card[field as keyof Card]}"`);
    });
    assert.deepStrictEqual(wrong, []);
  });

  it("states none of the withdrawn lines on any guide or report", () => {
    const found = [...served].flatMap(([route, html]) =>
      WITHDRAWN.filter((line) => readable(html).includes(line) || html.includes(line)).map((line) => `${route}: "${line}"`)
    );
    assert.deepStrictEqual(found, []);
  });

  it("keeps the Tenor and Gemini 2.0 Flash cards as they were", () => {
    const text = readable(served.get(PAGE)!);
    assert.deepStrictEqual(CONTROLS.filter((line) => !text.includes(line)), []);
  });

  it("names no Gitpod on either Firebase Studio card", () => {
    const cards = cardsOn(served.get(PAGE)!);
    const named = ["Firebase Studio (Full Shutdown)", "Firebase Studio (New Workspaces)"].filter((service) => {
      const card = cards.get(service);
      return !card || JSON.stringify(card).includes("Gitpod");
    });
    assert.deepStrictEqual(named, []);
  });
});

describe("the shutdown tracker's structured data carries the dates the other guides carry", () => {
  const underReview = async (review: Record<string, unknown>): Promise<{ published: string | null; modified: string | null }> => {
    const fixture = registerWith(REPO, "shutdowns-", { [PAGE]: review });
    const { proc, base } = await startServer({ AGENTDEALS_PAGE_REVIEWS_PATH: fixture.file });
    try {
      const html = await (await fetch(`${base}${PAGE}`)).text();
      return { published: html.match(/"datePublished"\s*:\s*"(\d{4}-\d{2}-\d{2})"/)?.[1] ?? null, modified: dateModifiedOn(html) };
    } finally {
      proc.kill("SIGKILL");
      rmSync(fixture.dir, { recursive: true, force: true });
    }
  };

  it("holds dateModified at the publication date while a review that found defects stands", async () => {
    assert.deepStrictEqual(await underReview(reviewFailedOn("2026-09-28")), { published: "2026-04-02", modified: "2026-04-02" });
  });

  it("moves dateModified to the review date once a review clears the page", async () => {
    assert.deepStrictEqual(await underReview(reviewPassedOn("2026-09-28")), { published: "2026-04-02", modified: "2026-09-28" });
  });
});
