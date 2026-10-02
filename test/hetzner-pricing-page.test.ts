import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  HETZNER_APRIL_CHANGES,
  HETZNER_AX102_GERMANY,
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

const OTHER_LISTED_VENDORS = new Set(
  (JSON.parse(readFileSync(path.join(REPO, "data", "index.json"), "utf8")).offers as { vendor: string }[])
    .map(o => o.vendor)
    .filter(vendor => vendor !== "Hetzner"),
);

const withoutItemsOrRowsHeadedByAnotherVendor = (body: string) =>
  body
    .replace(/<li><strong>([^<]*):<\/strong>[\s\S]*?<\/li>/g, (item, label: string) =>
      OTHER_LISTED_VENDORS.has(label.trim()) ? " " : item,
    )
    .replace(/<tr[^>]*>\s*<td[^>]*>([\s\S]*?)<\/td>[\s\S]*?<\/tr>/g, (row, firstCell: string) =>
      OTHER_LISTED_VENDORS.has(firstCell.replace(/<[^>]+>/g, "").trim()) ? " " : row,
    );

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
      `€${HETZNER_AX102_GERMANY.beforeApril.toFixed(2)}`,
      `€${HETZNER_AX102_GERMANY.afterApril.toFixed(2)}`,
    ]);
    const quoted = new Set(visible(withoutItemsOrRowsHeadedByAnotherVendor(body)).match(/€\d+\.\d{2}/g) ?? []);
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

const aprilTableRows = (body: string) =>
  [...body.slice(body.indexOf('<h2 id="april">'), body.indexOf('<h2 id="why">')).matchAll(/<tr>([\s\S]*?)<\/tr>/g)]
    .map(row => visible(row[1]).trim())
    .filter(row => row.includes("€"));

describe("the April 1 table holds only rows from Hetzner's April price list", () => {
  it("gives every row the rise its own two prices make", () => {
    for (const change of HETZNER_APRIL_CHANGES) {
      const [before, after] = [change.before, change.after].map(price => Number(price.replace("€", "")));
      assert.equal(change.pctChange, Math.round((after / before - 1) * 100), change.product);
    }
  });

  it("prices the AX41-NVMe at Hetzner's April figures for Germany", async () => {
    const rows = aprilTableRows((await get("/hetzner-pricing-2026")).body);
    assert.ok(rows.includes("AX41-NVMe dedicated server, Germany €41.10 €42.30 +3%"), rows.join(" | "));
  });

  it("has no Object Storage row for the US, where Hetzner sells none, and no memory row, which April did not change", async () => {
    const rows = aprilTableRows((await get("/hetzner-pricing-2026")).body);
    assert.equal(rows.length, HETZNER_APRIL_CHANGES.length);
    for (const row of rows) {
      assert.doesNotMatch(row, /\bUS\b/);
      assert.doesNotMatch(row, /\bRAM\b|memory/i);
    }
  });

  it("dates the memory upgrade rise to February, at the prices Hetzner's add-on list gives", async () => {
    const text = visible((await get("/hetzner-pricing-2026")).body);
    assert.ok(text.includes("Hetzner raised them in February: its add-on price list, last changed 2026-02-17, put a 64 GB DDR5 ECC step at €111 a month, up from €22, and a 32 GB step at €66, up from €14."));
    assert.ok(text.includes("128 GB as two 64 GB DDR5 ECC steps went from €44 to €222 a month"));
    assert.ok(text.includes(`an AX102 with 128 GB built in cost €${HETZNER_AX102_GERMANY.afterApril.toFixed(2)} a month in Germany`));
  });

  it("states none of the figures that were not Hetzner's", async () => {
    const text = visible((await get("/hetzner-pricing-2026")).body);
    assert.doesNotMatch(text, /575%|€45\.88|€264\.00|€49\.73|€51\.22|US\/SG object storage|cost €124/);
  });
});

describe("OVHcloud's VPS-1 beside Hetzner on /hetzner-pricing-2026", () => {
  it("prices the EU row in euros ex-VAT and gives the US price as the US one", async () => {
    const text = visible((await get("/hetzner-pricing-2026")).body);
    assert.ok(text.includes("€4.49/mo EU VPS 2027 range, ex-VAT, without commitment (€3.81/mo on 12 months). $5.35/mo in the US. The 2026 range rose 36-49% from April 2026"));
    assert.ok(text.includes("It has since launched a VPS 2027 range, whose VPS-1 (2 vCores, 4 GB RAM) is €4.49 a month ex-VAT without commitment in Europe ($5.35 in the US)."));
    assert.doesNotMatch(text, /\$5\.35\/mo EU|is \$5\.35 a month without commitment/);
  });
});

describe("what /hetzner-pricing-2026 says costs nothing", () => {
  it("names Oracle's Always Free tier as the only VM open to every new account at no cost, beside Vultr's free instance and Railway's and Render's app plans", async () => {
    const text = visible((await get("/hetzner-pricing-2026")).body);
    assert.ok(text.includes("Of the VMs here, only Oracle Cloud's Always Free tier is open to every new account at no cost. Vultr gives a free 1 vCPU, 512 MB instance to accepted applicants in Miami, Seattle and Frankfurt. Railway and Render have free plans for apps, not VMs."));
    assert.doesNotMatch(text, /only option here that costs nothing/);
  });

  it("gives Vultr's free instance in Vultr's row", async () => {
    const text = visible((await get("/hetzner-pricing-2026")).body);
    assert.ok(text.includes("$5/mo Global Not re-read since March 2026. Free instance (1 vCPU, 512 MB, 10 GB SSD) for accepted applicants, in Miami, Seattle and Frankfurt"));
  });
});

describe("pages that compared US cloud providers' prices with Hetzner's on no source", () => {
  for (const route of ["/hetzner-pricing-2026", "/q2-pricing-preview-2026"]) {
    it(`${route} no longer says they cost 3-6x more or have announced no increases`, async () => {
      const { status, body } = await get(route);
      assert.strictEqual(status, 200);
      assert.doesNotMatch(visible(body), /3-6x higher|announced increases|US cloud providers:/);
    });
  }
});
