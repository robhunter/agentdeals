import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");

let server: ChildProcess;
let base = "";

function startServer(): Promise<ChildProcess> {
  return new Promise((resolve, reject) => {
    const proc = spawn("node", [path.join(root, "dist", "serve.js")], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, PORT: "0", BASE_URL: "http://localhost", TZ: "UTC" },
    });
    const timeout = setTimeout(() => {
      proc.kill();
      reject(new Error("Server startup timeout"));
    }, 20000);
    proc.stderr!.on("data", (data: Buffer) => {
      const match = data.toString().match(/running on http:\/\/localhost:(\d+)/);
      if (match) {
        base = `http://localhost:${match[1]}`;
        clearTimeout(timeout);
        resolve(proc);
      }
    });
    proc.on("error", (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });
}

const ROUTES_STATING_NEON_FREE_STORAGE = [
  "/free-nextjs-stack",
  "/free-django-stack",
  "/free-fastapi-stack",
  "/free-go-stack",
  "/free-saas-stack",
  "/neon-vs-supabase",
  "/neon-vs-turso",
  "/database-pricing",
  "/vector-database-pricing",
  "/database-free-tier-comparison-2026",
  "/mongodb-alternatives",
  "/database-alternatives",
  "/aws-free-tier-2026",
  "/azure-free-tier-2026",
  "/gcp-free-tier-2026",
  "/estimate",
  "/budget-builder",
  "/free-tier-risk",
];

const SUPERSEDED_FREE_STORAGE = /0\.5 ?GiB|0\.5 ?GB|512 ?MB/g;
const CURRENT_FREE_STORAGE = /\b1 GB\b/g;
const REACH_OF_A_NEON_MENTION = 220;
const REACH_OF_A_RECORD_QUOTE = 30;

const OTHER_VENDORS_FIGURES_NEAR_NEON = [
  { vendor: "MongoDB Atlas", text: "MongoDB Atlas 512 MB" },
  { vendor: "MongoDB Atlas", text: "(within 512 MB) 512 MB (M0 cluster)" },
  { vendor: "Railway", text: "1 vCPU / 0.5 GB" },
  { vendor: "Render", text: "(512 MB RAM)" },
];

const ENTITIES: Record<string, string> = {
  "&mdash;": "—", "&ndash;": "–", "&amp;": "&", "&quot;": '"', "&#39;": "'", "&#x27;": "'",
  "&apos;": "'", "&nbsp;": " ", "&lt;": "<", "&gt;": ">", "&rarr;": "→", "&nearr;": "↗",
};

function decode(text: string): string {
  return text.replace(/&[a-z#0-9]+;/gi, (e) => ENTITIES[e] ?? e).replace(/\s+/g, " ");
}

function servedText(html: string): string {
  const scripts: string[] = [];
  const markup = html.replace(/<script\b[^>]*>([\s\S]*?)<\/script>/gi, (_, body: string) => {
    scripts.push(body);
    return " ";
  });
  return decode([markup.replace(/<[^>]+>/g, " "), ...scripts].join(" "))
    .replace(/\\"/g, '"')
    .replace(/\\\//g, "/");
}

const changes = (() => {
  const parsed = JSON.parse(readFileSync(path.join(root, "data", "deal_changes.json"), "utf-8"));
  return (Array.isArray(parsed) ? parsed : (parsed.changes ?? parsed.deal_changes ?? [])) as Array<Record<string, any>>;
})();

const neonRecordText = changes
  .filter((c) => c.vendor === "Neon")
  .flatMap((c) => [c.summary, c.previous_state, c.current_state])
  .filter((s): s is string => typeof s === "string")
  .map((s) => s.replace(/\s+/g, " "))
  .join("\n");

function quotesANeonRecord(text: string, at: number, figure: string): boolean {
  const leading = text.slice(Math.max(0, at - REACH_OF_A_RECORD_QUOTE), at + figure.length);
  const trailing = text.slice(at, at + figure.length + REACH_OF_A_RECORD_QUOTE);
  return neonRecordText.includes(leading) || neonRecordText.includes(trailing);
}

function statesTheChange(text: string, at: number, figure: string): boolean {
  return text.slice(Math.max(0, at - 5), at) === "from " && text.slice(at + figure.length, at + figure.length + 4) === " to ";
}

function belongsToAnotherVendor(text: string, at: number): boolean {
  return OTHER_VENDORS_FIGURES_NEAR_NEON.some(({ text: figureText }) => {
    for (let i = text.indexOf(figureText); i !== -1; i = text.indexOf(figureText, i + 1)) {
      if (at >= i && at < i + figureText.length) return true;
    }
    return false;
  });
}

function figuresNearNeon(text: string, figures: RegExp): Array<{ at: number; figure: string }> {
  const found: Array<{ at: number; figure: string }> = [];
  for (const m of text.matchAll(figures)) {
    const at = m.index!;
    const around = text.slice(Math.max(0, at - REACH_OF_A_NEON_MENTION), at + m[0].length + REACH_OF_A_NEON_MENTION);
    if (around.includes("Neon")) found.push({ at, figure: m[0] });
  }
  return found;
}

const pages = new Map<string, string>();

before(async () => {
  server = await startServer();
  for (const route of ROUTES_STATING_NEON_FREE_STORAGE) {
    const res = await fetch(base + route);
    assert.strictEqual(res.status, 200, route);
    pages.set(route, servedText(await res.text()));
  }
});

after(() => {
  server?.kill();
});

describe("Neon's Free plan storage, 1 GB per project since 2026-10-01", () => {
  it("is given as 0.5 GB, 0.5 GiB or 512 MB near Neon only where a page quotes Neon's dated change records or states the change", () => {
    const superseded: string[] = [];
    for (const [route, text] of pages) {
      for (const { at, figure } of figuresNearNeon(text, SUPERSEDED_FREE_STORAGE)) {
        if (quotesANeonRecord(text, at, figure) || statesTheChange(text, at, figure) || belongsToAnotherVendor(text, at)) continue;
        superseded.push(`${route}: ...${text.slice(Math.max(0, at - 80), at + figure.length + 40)}...`);
      }
    }
    assert.deepStrictEqual(superseded, []);
  });

  it("is given as 1 GB on every page that states it", () => {
    const silent = [...pages].filter(([, text]) => figuresNearNeon(text, CURRENT_FREE_STORAGE).length === 0).map(([route]) => route);
    assert.deepStrictEqual(silent, []);
  });

  it("is not called similar to Supabase's limit on /neon-vs-supabase", () => {
    const text = pages.get("/neon-vs-supabase")!;
    assert.ok(!text.includes("Similar raw limits"));
    assert.ok(text.includes("Neon allows 1 GB per project and 20 GB across all projects. Supabase's Free plan lists a 500 MB database size and a limit of 2 active projects."));
  });

  it("dates Neon's row on /free-tier-risk from the 2026-10-01 increase, not a January 2026 restructuring", () => {
    const text = pages.get("/free-tier-risk")!;
    assert.ok(!text.includes("Pricing restructured Jan 2026"));
    assert.ok(text.includes("and on 2026-10-01 storage from 0.5 GB to 1 GB per project. The acquisition leaves its long-term commitment to a free tier uncertain."));
  });
});
