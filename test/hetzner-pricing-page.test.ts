import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  HETZNER_APRIL_CHANGES,
  HETZNER_CLOUD_PLANS,
  HETZNER_PRICES_READ,
  HETZNER_SINGAPORE_EXAMPLE,
  cheapestOrderableHetznerPlan,
  hetznerEntryPriceClause,
  unorderableHetznerPlans,
} from "../dist/hetzner-pricing.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(__dirname, "..");

let serverPort = 0;
let proc: ChildProcess | null = null;

function startServer(): Promise<ChildProcess> {
  return new Promise((resolve, reject) => {
    const child = spawn("node", [path.join(REPO, "dist", "serve.js")], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, PORT: "0", BASE_URL: "http://localhost" },
    });
    const timeout = setTimeout(() => { child.kill(); reject(new Error("Server startup timeout")); }, 30000);
    child.stderr!.on("data", (data: Buffer) => {
      const m = data.toString().match(/running on http:\/\/localhost:(\d+)/);
      if (m) { serverPort = parseInt(m[1], 10); clearTimeout(timeout); resolve(child); }
    });
    child.on("error", (err) => { clearTimeout(timeout); reject(err); });
  });
}

const get = async (p: string) => {
  const res = await fetch(`http://localhost:${serverPort}${p}`);
  return { status: res.status, body: await res.text() };
};

const visible = (body: string) =>
  body
    .replace(/<script[\s\S]*?<\/script>/g, " ")
    .replace(/<style[\s\S]*?<\/style>/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&euro;/g, "€")
    .replace(/\s+/g, " ");

const PAGES_NAMING_HETZNER_PRICES = [
  "/hetzner-pricing-2026",
  "/hetzner-alternatives",
  "/hosting-alternatives",
];

before(async () => { proc = await startServer(); });
after(() => { if (proc) proc.kill(); });

describe("the plan table Hetzner pages are priced from", () => {
  it("holds every plan under one identity, priced once", () => {
    const skus = HETZNER_CLOUD_PLANS.map(p => p.sku);
    assert.equal(new Set(skus).size, skus.length);
    assert.ok(HETZNER_CLOUD_PLANS.length >= 20, "the table must cover the published lineup");
    for (const plan of HETZNER_CLOUD_PLANS) {
      assert.ok(plan.eur > 0, plan.sku);
      assert.ok(plan.vcpu > 0 && plan.ram > 0, plan.sku);
      assert.match(plan.sku, /^C[A-Z]*X\d+$/);
    }
  });

  it("keeps at least one plan a reader can order, and knows which it is", () => {
    const orderable = HETZNER_CLOUD_PLANS.filter(p => p.available);
    assert.ok(orderable.length > 0, "a page cannot recommend a lineup with nothing in it");
    const cheapest = cheapestOrderableHetznerPlan();
    assert.ok(cheapest.available);
    for (const plan of orderable) assert.ok(plan.eur >= cheapest.eur, plan.sku);
  });

  it("records that some plans carry a price without being orderable", () => {
    const unorderable = unorderableHetznerPlans();
    assert.ok(unorderable.length > 0, "the distinction this page turns on must have an instance");
    const cheapestListed = HETZNER_CLOUD_PLANS.reduce((a, b) => (a.eur <= b.eur ? a : b));
    assert.equal(cheapestListed.available, false, "the trap is that the lowest price is not orderable");
  });
});

describe("the pricing page prices what Hetzner sells today", () => {
  it("renders, so the assertions below are about a real page", async () => {
    const res = await get("/hetzner-pricing-2026");
    assert.equal(res.status, 200);
  });

  it("names the date its prices were read", async () => {
    const { body } = await get("/hetzner-pricing-2026");
    assert.match(visible(body), new RegExp(`read from hetzner\\.com on ${HETZNER_PRICES_READ}`));
  });

  it("publishes every plan in the table with its price and its availability", async () => {
    const { body } = await get("/hetzner-pricing-2026");
    const text = visible(body);
    for (const plan of HETZNER_CLOUD_PLANS) {
      const row = new RegExp(`${plan.sku}\\b[^€]*€${plan.eur.toFixed(2)}[^A-Za-z]*(orderable|not available)`);
      const match = text.match(row);
      assert.ok(match, `${plan.sku} must appear with €${plan.eur.toFixed(2)} and a state`);
      assert.equal(match[1], plan.available ? "orderable" : "not available", plan.sku);
    }
  });

  it("names no cloud plan Hetzner no longer lists", async () => {
    const { body } = await get("/hetzner-pricing-2026");
    const known = new Set(HETZNER_CLOUD_PLANS.map(p => p.sku));
    const named = new Set(visible(body).match(/\bC[AP]?X\d{2}\b/g) ?? []);
    const unknown = [...named].filter(sku => !known.has(sku));
    assert.deepEqual(unknown, [], `named plans that are not in the table: ${unknown.join(", ")}`);
  });

  it("quotes no cloud price that is not in the table", async () => {
    const { body } = await get("/hetzner-pricing-2026");
    const allowed = new Set([
      ...HETZNER_CLOUD_PLANS.map(p => `€${p.eur.toFixed(2)}`),
      ...HETZNER_APRIL_CHANGES.flatMap(c => [c.before, c.after]),
      `€${HETZNER_SINGAPORE_EXAMPLE.eur.toFixed(2)}`,
    ]);
    const quoted = new Set(visible(body).match(/€\d+\.\d{2}/g) ?? []);
    const strays = [...quoted].filter(price => !allowed.has(price));
    assert.deepEqual(strays, [], `prices with no plan or April row behind them: ${strays.join(", ")}`);
  });

  it("does not describe a completed price change as still to come", async () => {
    const { body } = await get("/hetzner-pricing-2026");
    const text = visible(body);
    assert.doesNotMatch(text, /Hetzner is raising/);
    assert.doesNotMatch(text, /prices are increasing/);
    assert.doesNotMatch(text, /will (raise|increase) prices/);
  });

  it("does not claim Hetzner undercuts a competitor it now costs more than", async () => {
    const { body } = await get("/hetzner-pricing-2026");
    const text = visible(body);
    assert.doesNotMatch(text, /roughly 3x cheaper than DigitalOcean/);
    assert.doesNotMatch(text, /Still cheapest EU cloud/);
  });
});

describe("every page that states a Hetzner entry price states the same one", () => {
  for (const page of PAGES_NAMING_HETZNER_PRICES) {
    it(`gives ${page} the orderable entry price and no other`, async () => {
      const { status, body } = await get(page);
      assert.equal(status, 200, page);
      const text = visible(body);
      const cheapest = cheapestOrderableHetznerPlan();
      for (const plan of unorderableHetznerPlans()) {
        const asEntry = new RegExp(`cheapest[^.]{0,60}${plan.sku}`);
        assert.doesNotMatch(text, asEntry, `${page} offers ${plan.sku} as an entry price`);
      }
      if (/cheapest plan you can order|cheapest orderable plan/.test(text)) {
        assert.match(text, new RegExp(`${cheapest.sku}[^.]{0,40}€${cheapest.eur.toFixed(2)}`), page);
      }
    });
  }

  it("composes that price from the plan table rather than from a literal", () => {
    const cheapest = cheapestOrderableHetznerPlan();
    assert.equal(hetznerEntryPriceClause(), `${cheapest.sku} at €${cheapest.eur.toFixed(2)}/mo (${cheapest.vcpu} vCPU, ${cheapest.ram} GB)`);
  });
});
