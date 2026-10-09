import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertPopulationFloor } from "./population-floor.ts";
import { CONTACT_EMAIL } from "../dist/contact.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(__dirname, "..");
const ADDRESSES_WE_PUBLISH = new Set([CONTACT_EMAIL, "rob@agentdeals.dev"]);
const AN_ADDRESS = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;
const A_MAILTO_TARGET = /mailto:([^"'\s<>?]+)/g;
const OUR_DOMAIN = /@agentdeals\.dev$/i;

let proc: ChildProcess | null = null;
let base = "";

function startServer(): Promise<ChildProcess> {
  return new Promise((resolve, reject) => {
    const child = spawn("node", [path.join(REPO, "dist", "serve.js")], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, PORT: "0", BASE_URL: "http://localhost" },
    });
    const timeout = setTimeout(() => { child.kill(); reject(new Error("Server startup timeout")); }, 20000);
    child.stderr!.on("data", (data: Buffer) => {
      const m = data.toString().match(/running on http:\/\/localhost:(\d+)/);
      if (m) { base = `http://localhost:${m[1]}`; clearTimeout(timeout); resolve(child); }
    });
    child.on("error", (err) => { clearTimeout(timeout); reject(err); });
  });
}

const text = async (p: string) => (await fetch(`${base}${p}`)).text();

async function locs(sitemap: string): Promise<string[]> {
  return [...(await text(sitemap)).matchAll(/<loc>([^<]+)<\/loc>/g)].map(m => new URL(m[1]).pathname);
}

async function routesThatCanHoldAnAddress(): Promise<string[]> {
  const routes = new Set<string>(["/", "/privacy", "/press"]);
  for (const sitemap of ["/sitemap-misc.xml", "/sitemap-pages.xml", "/sitemap-reports.xml"]) {
    for (const p of await locs(sitemap)) routes.add(p);
  }
  for (const p of (await locs("/sitemap-vendors.xml")).slice(0, 5)) routes.add(p);
  for (const p of (await locs("/sitemap-comparisons.xml")).slice(0, 5)) routes.add(p);
  return [...routes];
}

function mailtoTargets(body: string): string[] {
  return [...body.matchAll(A_MAILTO_TARGET)].map(m => decodeURIComponent(m[1]));
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return entry.name.endsWith(".ts") ? [full] : [];
  });
}

before(async () => { proc = await startServer(); });
after(() => { if (proc) proc.kill(); });

describe("#1084 every address we publish is one that reaches us", () => {
  it("writes every mailto link in the source to the contact address", () => {
    const strays: string[] = [];
    for (const file of sourceFiles(path.join(REPO, "src"))) {
      for (const target of mailtoTargets(readFileSync(file, "utf8"))) {
        if (target !== "${CONTACT_EMAIL}") strays.push(`${path.relative(REPO, file)}: ${target}`);
      }
    }
    assert.deepStrictEqual(strays, []);
  });

  it("sends privacy removal requests and questions about the policy to the contact address", async () => {
    const body = await text("/privacy");
    assert.deepStrictEqual(mailtoTargets(body), [CONTACT_EMAIL, CONTACT_EMAIL]);
    assert.deepStrictEqual([...new Set(body.match(AN_ADDRESS))], [CONTACT_EMAIL]);
  });

  it("links no served page to any address but the contact address, and names no other address of ours", async () => {
    const routes = await routesThatCanHoldAnAddress();
    assertPopulationFloor(routes.length, 500, "routes read for addresses");
    const found: string[] = [];
    for (const route of routes) {
      const body = await text(route);
      for (const target of mailtoTargets(body)) {
        if (target !== CONTACT_EMAIL) found.push(`${route}: mailto ${target}`);
      }
      for (const address of body.match(AN_ADDRESS) ?? []) {
        if (OUR_DOMAIN.test(address) && !ADDRESSES_WE_PUBLISH.has(address.toLowerCase())) found.push(`${route}: ${address}`);
      }
    }
    assert.deepStrictEqual(found, []);
  });

  it("names the contact address in llms.txt, which is served as plain text", async () => {
    const res = await fetch(`${base}/llms.txt`);
    assert.match(res.headers.get("content-type") ?? "", /^text\/plain/);
    const body = await res.text();
    assert.ok(body.includes(`- Email: ${CONTACT_EMAIL}`), "llms.txt lists the address beside the other ways to reach the service");
  });

  it("gives the contact address in the agent card's contact block", async () => {
    const card = JSON.parse(await text("/.well-known/agent-card.json"));
    assert.strictEqual(card.contact.email, CONTACT_EMAIL);
  });
});
