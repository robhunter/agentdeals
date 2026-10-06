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
  "Different API Structure",
  "different endpoint patterns",
  "all different from Tenor",
  "requires API approval",
  "Easiest migration",
  "strongest brand recognition",
  "actively migrating",
  "High-traffic apps on a deadline",
];

const ROWS: Record<string, [string, string, string, string]> = {
  Klipy: ["No published price; test key 100 calls/hour, production key on request; attribution required", "10M+ items (Klipy's figure)", "Tenor-compatible v2 endpoints", "Minimal"],
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

const BOTH_PROVIDERS_TERMS = [
  "Key insight: Klipy and GIPHY both offer Tenor-compatible endpoints. You migrate by changing the API host and key. Both start with a key limited to 100 calls per hour. Both require requests to originate from the user’s app or browser.",
  "Client-side requests only: Klipy and GIPHY both prohibit routing API calls or media loads through your servers. This applies to bots and server-side integrations. Requests must come directly from the user’s app or browser. Klipy makes exceptions only with its prior written approval.",
  "Production keys: Klipy offers a production key providing limitless requests, requested through its Partner Panel; it publishes no price. GIPHY production keys require an application and incur a fee; the GIPHY team will discuss pricing if your application meets their criteria.",
  "Three paths depending on your constraints.",
  "Path 1: Migrate to Klipy Replace tenor.googleapis.com with api.klipy.com and use your Klipy API key; Klipy’s endpoints are Tenor-compatible. A test key allows 100 calls per hour; a production key, requested through Klipy’s Partner Panel, removes the limit. Requests must come from the user’s app or browser, with Klipy attribution. Discord and Bluesky use Klipy. Best for: Teams needing a direct Tenor replacement.",
  "Path 2: Migrate to GIPHY Change the host to api.giphy.com; the search endpoint keeps Tenor’s request and response shape. GIPHY also has its own /v1 API and native SDKs with a picker UI. Beta keys allow 100 calls per hour; a production key needs an approved application and has a fee. Requests must come from the user’s app or browser. Best for: Apps that need a native SDK.",
  "Tenor → GIPHY (Tenor-compatible endpoints) Change the host to api.giphy.com and use a GIPHY key; the search endpoint keeps Tenor’s request and response shape. /v2/registershare is not implemented; use the analytics URLs GIPHY returns on each item.",
  "The Tenor API is now shut down. Discord and Bluesky have switched to Klipy. WhatsApp’s provider is unconfirmed.",
  "Apps that call the API from the user’s device: Klipy and GIPHY both offer Tenor-compatible endpoints; switching takes a host change and a new key. Klipy provides a production key on request via its Partner Panel and publishes no price. GIPHY requires an application for a production key and charges a fee. Discord and Bluesky use Klipy.",
  "Bots and server-side integrations: Klipy and GIPHY both require client-side calls; Klipy makes exceptions only with written approval. For bots, consider a self-hosted search index.",
];

const INTEGRATION_RULES =
  "Caching, ordering and mixing: Klipy and GIPHY set the same rules for standard integrations. Load media from the URLs the API returns; do not cache, store or re-host the media, unless the provider has approved a caching integration. Do not reorder or filter Search and Trending results in your code; Klipy’s filters are set in its Partner Panel. Do not mix their GIFs with another provider’s in the same grid; Klipy allows it only with written approval. (From docs.klipy.com/integration-requirements and GIPHY’s API docs, read 2026-10-06.)";

const STORED_TENOR_LINKS =
  "GIF links an app already stored: Google’s notice covers API requests and says nothing about media links. A media.tenor.com GIF link still loaded when we checked on 2026-10-06; Google does not say how long they will.";

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

function inReadingOrder(text: string, ...passages: string[]): boolean {
  const positions = passages.map((passage) => text.indexOf(passage));
  return positions.every((position, i) => position >= 0 && (i === 0 || position > positions[i - 1]));
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

  it("points the GIPHY sample at GIPHY's Tenor-compatible v2 search and parses it like the Tenor sample", () => {
    const text = readable(served.get("/tenor-alternatives")!);
    const sample = text.split("// After: GIPHY's Tenor-compatible API (change host and key)")[1]?.split("Who’s Affected")[0] ?? "";
    assert.ok(sample.includes("https://api.giphy.com/v2/search?q=${query}&key=${GIPHY_KEY}&client_key=my_app&limit=20"), sample);
    assert.ok(sample.includes("const { results } = await response.json(); const gifUrl = results[0].media_formats.gif.url;"), sample);
    assert.ok(!text.includes("api.giphy.com/v1/gifs/search"));
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

  it("states Klipy's and GIPHY's client-side rule and production-key terms as the providers do", () => {
    const text = readable(served.get("/tenor-alternatives")!);
    assert.deepStrictEqual(BOTH_PROVIDERS_TERMS.filter((line) => !text.includes(line)), []);
  });

  it("states Klipy's and GIPHY's caching, ordering and mixing rules after their client-side rule, naming both providers' docs and the day they were read", () => {
    const text = readable(served.get("/tenor-alternatives")!);
    assert.ok(text.includes(INTEGRATION_RULES));
    assert.ok(inReadingOrder(text, "Client-side requests only:", INTEGRATION_RULES, "Production keys:"));
  });

  it("says Google's notice is silent on stored media.tenor.com links, after what the shutdown leaves alone, and promises nothing past the day one last loaded", () => {
    const text = readable(served.get("/tenor-alternatives")!);
    assert.ok(text.includes(STORED_TENOR_LINKS));
    assert.ok(inReadingOrder(text, "What’s NOT affected:", STORED_TENOR_LINKS, "GIF API Alternative Comparison"));
  });

  it("describes the guide and the shutdown card the same way", () => {
    assert.ok(structuredStrings(served.get("/tenor-alternatives")!).some((s) => s.startsWith(META_DESCRIPTION)));
    assert.ok(readable(served.get("/shutdowns")!).includes(SHUTDOWNS_MIGRATION));
  });
});
