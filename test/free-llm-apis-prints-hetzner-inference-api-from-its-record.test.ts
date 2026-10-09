import { describe, it, before } from "node:test";
import assert from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(__dirname, "..");

const PAGE = "/free-llm-apis";
const SUBJECT = "Hetzner Inference API";
const SUBJECT_SLUG = "hetzner-inference-api";
const SYNTHETIC_TERMS = "Free while experimental: 7 requests a minute on Zorblax-9B.";

type Condition = { text: string };
type Offer = { vendor: string; description: string; conditions?: Condition[] };
type Catalogue = { offers: Offer[] };

const shipped: Catalogue = JSON.parse(readFileSync(path.join(REPO, "data", "index.json"), "utf8"));
const subjectOffer = shipped.offers.find((o) => o.vendor === SUBJECT);

async function served(catalogue: Catalogue): Promise<string> {
  const dir = mkdtempSync(path.join(tmpdir(), "free-llm-apis-card-"));
  const indexPath = path.join(dir, "index.json");
  writeFileSync(indexPath, JSON.stringify(catalogue));
  const proc: ChildProcess = spawn("node", [path.join(REPO, "dist", "serve.js")], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, PORT: "0", BASE_URL: "http://localhost", TZ: "UTC", AGENTDEALS_INDEX_PATH: indexPath },
  });
  try {
    const base = await new Promise<string>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Server startup timeout")), 30000);
      proc.stderr!.on("data", (data: Buffer) => {
        const match = data.toString().match(/running on http:\/\/localhost:(\d+)/);
        if (match) {
          clearTimeout(timeout);
          resolve(`http://localhost:${match[1]}`);
        }
      });
      proc.on("error", (err) => {
        clearTimeout(timeout);
        reject(err);
      });
    });
    const response = await fetch(`${base}${PAGE}`);
    assert.strictEqual(response.status, 200, `${PAGE} answered ${response.status}`);
    return await response.text();
  } finally {
    proc.kill();
    rmSync(dir, { recursive: true, force: true });
  }
}

function section(html: string, heading: string): string {
  const start = html.indexOf(`<h2>${heading}</h2>`);
  if (start < 0) return "";
  const end = html.indexOf("<h2>", start + heading.length);
  return end > start ? html.slice(start, end) : html.slice(start);
}

function cardOf(html: string, slug: string): string {
  const at = html.indexOf(`<a href="/vendor/${slug}" class="alt-card-name">`);
  if (at < 0) return "";
  const start = html.lastIndexOf('<div class="alt-card">', at);
  const end = html.indexOf('<div class="alt-card">', at);
  return html.slice(start, end > at ? end : undefined);
}

const decoded = (html: string) => html.replace(/&#39;|&rsquo;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&");

describe(`${PAGE} lists ${SUBJECT} among the open-model inference platforms`, () => {
  let page = "";
  let card = "";

  before(async () => {
    assert.ok(subjectOffer, `the catalogue holds no ${SUBJECT} listing`);
    page = await served({
      ...shipped,
      offers: shipped.offers.map((o) => (o.vendor === SUBJECT ? { ...o, description: SYNTHETIC_TERMS } : o)),
    });
    card = cardOf(section(page, "Open-Model Inference Platforms"), SUBJECT_SLUG);
  });

  it("prints its card in that section, with the terms its record holds", () => {
    assert.ok(card, `${PAGE} prints no ${SUBJECT} card under Open-Model Inference Platforms`);
    assert.ok(card.includes(`<p class="alt-card-desc">${SYNTHETIC_TERMS}`), card);
  });

  it("prints every condition its record holds", () => {
    const conditions = subjectOffer!.conditions ?? [];
    assert.ok(conditions.length >= 2, `${SUBJECT} holds ${conditions.length} conditions`);
    for (const condition of conditions) assert.ok(decoded(card).includes(condition.text), condition.text);
  });

  it("links the card to the vendor's profile", () => {
    assert.ok(card.includes(`<a href="/vendor/${SUBJECT_SLUG}">Full profile</a>`), card);
  });

  it("counts in its introduction every provider it prints a card for", () => {
    const stated = page.match(/This page compares <strong>(\d+) LLM API providers<\/strong>/)?.[1];
    assert.ok(stated, "the introduction states no provider count");
    assert.strictEqual(Number(stated), page.split('class="alt-card-name"').length - 1);
  });
});
