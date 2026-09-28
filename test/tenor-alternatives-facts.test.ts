import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

const PAGES = ["/tenor-alternatives", "/shutdowns"];

const NOT_ON_ANY_PAGE = [
  "near-identical",
  "api.klipy.com/v1",
  "former Tenor employees",
  "ex-Tenor team",
  "Validated by WhatsApp",
  "switched GIF search from Tenor to Klipy",
  "Actively testing both",
  "June 30 approaching",
  "days to weeks",
  "Gfycat (via Snap)",
  "Tenor API shuts down",
];

const ROWS: Record<string, [string, string, string, string]> = {
  Klipy: ["No published price; test key 100 calls/hour, production key on request; attribution required", "10M+ items (Klipy's figure)", "", "Minimal"],
  "Giphy API": ["Beta key free (100 calls/hour); production key has a fee", "GIPHY says it has the largest GIF library", "Tenor-compatible v2 endpoints, or its own REST API", "Minimal"],
  "Giphy SDK": ["Free on the beta key; 'Powered By GIPHY' attribution required", "", "", ""],
  "Imgur API": ["Free for non-commercial use (1,250 uploads or 12,500 requests a day); not available in the UK", "", "", ""],
  "Self-hosted (Meilisearch + media)": ["", "", "", ""],
};

const STATED_ON_THE_GUIDE = [
  "Discord’s GIF picker now uses Klipy.",
  "WhatsApp has not said which provider replaced Tenor.",
  "Switched to Klipy in app version 1.121.0 (April 2026), using Klipy’s Tenor-compatible endpoints.",
  "Klipy’s API compatibility was read from Klipy’s and GIPHY’s migration guides on 2026-09-28.",
  "What happened: Google shut down the Tenor GIF API on June 30, 2026. New API key sign-ups stopped on January 13, 2026, and Google says any API request after June 30 fails with an error.",
  'Google says the decision is part of "an ongoing effort to focus resources on enhancing our core products."',
];

const META_DESCRIPTION =
  "Google's Tenor API shut down on June 30, 2026. Compare GIF API alternatives: Klipy and GIPHY (both Tenor-compatible), Imgur, self-hosted options.";

const SHUTDOWNS_MIGRATION = "Migrate to Klipy or GIPHY; both offer Tenor-compatible v2 endpoints";

const ENTITIES: Record<string, string> = {
  "&mdash;": "—", "&ndash;": "–", "&amp;": "&", "&quot;": '"', "&#39;": "'", "&#x27;": "'",
  "&rsquo;": "’", "&nbsp;": " ", "&middot;": "·", "&rarr;": "→",
};

function decoded(text: string): string {
  return text.replace(/&[a-z#0-9]+;/gi, (e) => ENTITIES[e] ?? e);
}

function readable(html: string): string {
  return decoded(
    html
      .replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, " ")
      .replace(/<\/?(?:a|abbr|b|code|em|i|small|span|strong|sub|sup)\b[^>]*>/gi, "")
      .replace(/<[^>]+>/g, " ")
  )
    .replace(/\s+/g, " ")
    .trim();
}

function structuredStrings(html: string): string[] {
  const strings: string[] = [];
  for (const m of html.matchAll(/<meta[^>]+content="([^"]*)"/gi)) strings.push(decoded(m[1]));
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

function comparisonRows(html: string): string[][] {
  const table = html.split('id="comparison-table"')[1]?.split("</table>")[0] ?? "";
  const body = table.split("<tbody>")[1] ?? "";
  return [...body.matchAll(/<tr>([\s\S]*?)<\/tr>/g)].map(([, row]) =>
    [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map(([, cell]) => readable(cell))
  );
}

let server: ChildProcess;
const served = new Map<string, string>();

describe("the Tenor alternatives guide states each provider's terms as the provider does", () => {
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

  it("keeps none of the withdrawn claims in the body, meta or structured data of either page", () => {
    const kept = PAGES.flatMap((page) => {
      const html = served.get(page)!;
      const text = `${readable(html)} ${structuredStrings(html).join(" ")}`.toLowerCase();
      return NOT_ON_ANY_PAGE.filter((claim) => text.includes(claim.toLowerCase())).map((claim) => `${page}: "${claim}"`);
    });
    assert.deepStrictEqual(kept, []);
  });

  it("points the Klipy sample at Klipy's Tenor-compatible v2 search", () => {
    const html = served.get("/tenor-alternatives")!;
    assert.ok(html.includes("https://api.klipy.com/v2/search?q="), "the Klipy sample does not call /v2/search");
  });

  it("compares five providers, and every count on the page says five", () => {
    const html = served.get("/tenor-alternatives")!;
    const rows = comparisonRows(html);
    assert.deepStrictEqual(rows.map((cells) => cells[0]), Object.keys(ROWS));
    assert.ok(html.includes('<div class="stat-number">5</div><div class="stat-label">Alternatives Compared</div>'));
    assert.ok(readable(html).includes("All 5 alternatives compared."));
    assert.ok(html.includes('<div class="stat-number green">2</div><div class="stat-label">Drop-In Replacement</div>'));
    const about = structuredStrings(html).filter((s) => Object.keys(ROWS).includes(s));
    assert.deepStrictEqual(about, Object.keys(ROWS));
  });

  it("states each provider's free terms, library, API style and effort in the provider's own terms", () => {
    const rows = new Map(comparisonRows(served.get("/tenor-alternatives")!).map((cells) => [cells[0], cells.slice(1)]));
    const wrong = Object.entries(ROWS).flatMap(([provider, expected]) =>
      expected
        .map((cell, at) => [cell, rows.get(provider)?.[at]] as const)
        .filter(([cell, shown]) => cell !== "" && shown !== cell)
        .map(([cell, shown]) => `${provider}: "${shown}" where the provider's terms say "${cell}"`)
    );
    assert.deepStrictEqual(wrong, []);
  });

  it("states the platform cards, the method and the Tenor facts as checked", () => {
    const text = readable(served.get("/tenor-alternatives")!);
    assert.deepStrictEqual(STATED_ON_THE_GUIDE.filter((line) => !text.includes(line)), []);
  });

  it("describes the guide and the shutdown card the same way", () => {
    assert.ok(structuredStrings(served.get("/tenor-alternatives")!).some((s) => s.startsWith(META_DESCRIPTION)));
    assert.ok(readable(served.get("/shutdowns")!).includes(SHUTDOWNS_MIGRATION));
  });
});
