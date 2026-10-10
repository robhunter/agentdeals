import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  HETZNER_APRIL_CHANGES,
  HETZNER_APRIL_DOLLAR_EXAMPLE,
  HETZNER_AVAILABILITY_READ,
  HETZNER_AX102_GERMANY,
  HETZNER_AX42_GERMANY,
  HETZNER_CLOUD_ADD_ON_PRICES,
  HETZNER_CLOUD_PLANS,
  HETZNER_OBJECT_STORAGE_PRICES,
  HETZNER_PRICES_READ,
  HETZNER_SINGAPORE_EXAMPLE,
  HETZNER_STORAGE_BOX_PRICES,
  HETZNER_VOLUME_PRICES,
  cheaperUnorderablePlanWithMoreServer,
  cheapestOrderableEuPlanForEachMemorySize,
  cheapestOrderableEuPlanForEachMemorySizeSentence,
  cheapestOrderableHetznerPlan,
  hetznerEntryPriceClause,
  unorderableHetznerPlans,
  unpayableLowestPricesSentence,
} from "../dist/hetzner-pricing.js";
import { parseHetznerPricesRead } from "../dist/page-reviews.js";
import { everyRouteTheSitemapPublishes } from "./sitemap-routes.ts";

type HetznerPlan = import("../src/hetzner-pricing.ts").HetznerPlan;
type ListingCondition = import("../src/types.ts").ListingCondition;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(__dirname, "..");

let serverPort = 0;
let proc: ChildProcess | null = null;

function spawnServer(env: Record<string, string> = {}): Promise<{ child: ChildProcess; port: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn("node", [path.join(REPO, "dist", "serve.js")], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, PORT: "0", BASE_URL: "http://localhost", ...env },
    });
    const timeout = setTimeout(() => { child.kill(); reject(new Error("Server startup timeout")); }, 30000);
    child.stderr!.on("data", (data: Buffer) => {
      const m = data.toString().match(/running on http:\/\/localhost:(\d+)/);
      if (m) { clearTimeout(timeout); resolve({ child, port: parseInt(m[1], 10) }); }
    });
    child.on("error", (err) => { clearTimeout(timeout); reject(err); });
  });
}

async function startServer(): Promise<ChildProcess> {
  const { child, port } = await spawnServer();
  serverPort = port;
  return child;
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

const CATALOGUE_OFFERS = JSON.parse(readFileSync(path.join(REPO, "data", "index.json"), "utf8")).offers as { vendor: string; conditions?: ListingCondition[] }[];

const OTHER_LISTED_VENDORS = new Set(
  CATALOGUE_OFFERS
    .map(o => o.vendor)
    .filter(vendor => vendor !== "Hetzner"),
);

const HETZNER_CONDITIONS = CATALOGUE_OFFERS.find(o => o.vendor === "Hetzner")?.conditions ?? [];

const hetznerConditionOpening = (opening: string) => {
  const found = HETZNER_CONDITIONS.filter(condition => condition.text.startsWith(opening));
  assert.equal(found.length, 1, `Hetzner's listing should hold one condition opening "${opening}"`);
  return found[0].text;
};

const TRAFFIC_CONDITION = "Outgoing traffic beyond";
const BACKUP_PRICE_CONDITION = "Backups cost";
const BACKUP_SLOTS_CONDITION = "Backups are automatic";
const SNAPSHOT_CONDITION = "Snapshots cost";
const OBJECT_STORAGE_PRICE_CONDITION = "Object Storage costs";
const OBJECT_STORAGE_BILLING_CONDITION = "The base price is billed for every hour";
const VOLUME_PRICE_CONDITION = "Volumes (block storage) cost";
const VOLUME_SIZE_CONDITION = "A Volume can be made larger";
const STORAGE_BOX_CONDITION = "Storage Boxes cost";

const { trafficPerTbBeyondTheIncluded, ipv4PerMonth, backupShareOfThePriceWithoutIpv4, snapshotPerGbMonth } = HETZNER_CLOUD_ADD_ON_PRICES;
const { basePerMonth, storagePerTbHourBeyondTheQuota, egressPerTbBeyondTheQuota } = HETZNER_OBJECT_STORAGE_PRICES;

const eurosIn = (text: string) => text.match(/€\d+\.\d{2,}/g) ?? [];
const dollarsIn = (text: string) => text.match(/\$\d+\.\d{2,}/g) ?? [];
const dollars = (usd: number) => `$${usd.toFixed(2)}`;
const asWritten = (eur: number) => `€${eur.toFixed(4).replace(/0{1,2}$/, "")}`;
const dollarsAsWritten = (usd: number) => `$${usd.toFixed(4).replace(/0{1,2}$/, "")}`;
const cents = (eur: number) => Math.round(eur * 100);
const fromCents = (amount: number) => `€${(amount / 100).toFixed(2)}`;

const ADD_ON_PRICES_AS_WRITTEN = [
  trafficPerTbBeyondTheIncluded.euAndUs,
  trafficPerTbBeyondTheIncluded.singapore,
  ipv4PerMonth,
  snapshotPerGbMonth,
].map(asWritten);

const OBJECT_STORAGE_PRICES = [basePerMonth, storagePerTbHourBeyondTheQuota, egressPerTbBeyondTheQuota];
const OBJECT_STORAGE_EUROS_AS_WRITTEN = OBJECT_STORAGE_PRICES.map(price => asWritten(price.eur));
const OBJECT_STORAGE_DOLLARS_AS_WRITTEN = OBJECT_STORAGE_PRICES.map(price => dollarsAsWritten(price.usd));

const { perGbMonth: volumePerGbMonth, perGbMonthBeforeApril: volumePerGbMonthBeforeApril } = HETZNER_VOLUME_PRICES;
const VOLUME_EUROS_AS_WRITTEN = [asWritten(volumePerGbMonth.eur), asWritten(volumePerGbMonthBeforeApril.eur)];
const VOLUME_DOLLARS_AS_WRITTEN = [dollarsAsWritten(volumePerGbMonth.usd)];
const STORAGE_BOX_EUROS_AS_WRITTEN = HETZNER_STORAGE_BOX_PRICES.map(box => asWritten(box.eur));

function backupExample(text: string) {
  const skus = text.match(/\bC[A-Z]*X\d+\b/g) ?? [];
  assert.equal(skus.length, 1, `the backup condition should name one plan: ${text}`);
  const plan = HETZNER_CLOUD_PLANS.find(p => p.sku === skus[0]);
  assert.ok(plan, `${skus[0]} is not in the plan table`);
  const backup = Math.round((cents(plan.eur) - cents(ipv4PerMonth)) * backupShareOfThePriceWithoutIpv4);
  return { backup: fromCents(backup), withBackups: fromCents(cents(plan.eur) + backup) };
}

function snapshotExample(text: string) {
  const sizes = [...text.matchAll(/(\d+) GB\b/g)].map(([, gb]) => Number(gb));
  assert.equal(sizes.length, 1, `the snapshot condition should give one example size: ${text}`);
  return fromCents(Math.round(sizes[0] * snapshotPerGbMonth * 100));
}

function objectStorageMonthExample(text: string) {
  const days = [...text.matchAll(/(\d+)-day month\b/g)].map(([, count]) => Number(count));
  assert.equal(days.length, 1, `the Object Storage condition should give one example month: ${text}`);
  return fromCents(Math.round(days[0] * 24 * storagePerTbHourBeyondTheQuota.eur * 100));
}

const addOnExamples = () => {
  const { backup, withBackups } = backupExample(hetznerConditionOpening(BACKUP_PRICE_CONDITION));
  return [backup, withBackups, snapshotExample(hetznerConditionOpening(SNAPSHOT_CONDITION))];
};

const objectStorageExamples = () => [objectStorageMonthExample(hetznerConditionOpening(OBJECT_STORAGE_PRICE_CONDITION))];

function volumeMonthExample(text: string) {
  const sizes = [...text.matchAll(/\bA (\d+) GB Volume costs\b/g)].map(([, gb]) => Number(gb));
  assert.equal(sizes.length, 1, `the Volume condition should give one example Volume: ${text}`);
  return fromCents(Math.round(sizes[0] * volumePerGbMonth.eur * 100));
}

const volumeExamples = () => [volumeMonthExample(hetznerConditionOpening(VOLUME_PRICE_CONDITION))];

const headedByAnotherVendor = (cell: string) => {
  const linked = cell.match(/<a href="\/vendor\/([^"]+)"/)?.[1];
  return OTHER_LISTED_VENDORS.has(cell.replace(/<[^>]+>/g, "").trim()) || (linked !== undefined && linked !== "hetzner");
};

const withoutItemsOrRowsHeadedByAnotherVendor = (body: string) =>
  body
    .replace(/<li><strong>([^<]*):<\/strong>[\s\S]*?<\/li>/g, (item, label: string) =>
      OTHER_LISTED_VENDORS.has(label.trim()) ? " " : item,
    )
    .replace(/<tr[^>]*>\s*<td[^>]*>([\s\S]*?)<\/td>[\s\S]*?<\/tr>(\s*<tr class="vendor-conditions-row">[\s\S]*?<\/tr>)?/g, (row, firstCell: string) =>
      headedByAnotherVendor(firstCell) ? " " : row,
    );

const PAGES_NAMING_HETZNER_PRICES = [
  "/hetzner-pricing-2026",
  "/hetzner-alternatives",
  "/hosting-alternatives",
  "/digitalocean-free-tier-2026",
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

  it("lists the cheapest orderable plan as the first orderable row, as the table note says", () => {
    assert.equal(HETZNER_CLOUD_PLANS.find(p => p.available)?.sku, cheapestOrderableHetznerPlan().sku);
  });
});

function plan(sku: string, eur: number, available: boolean, vcpu = 2, ram = 4): HetznerPlan {
  return { sku, line: "Synthetic", cpu: "AMD", vcpu, ram, region: "EU", eur, available };
}

describe("the table note's count of listed prices nobody can pay", () => {
  it("says nothing when the cheapest listed plan can be ordered", () => {
    assert.equal(unpayableLowestPricesSentence([plan("CX1", 3, true), plan("CX2", 2.5, true), plan("CX3", 4, false)]), "");
  });

  it("speaks of one plan in the singular", () => {
    assert.equal(
      unpayableLowestPricesSentence([plan("CX1", 3, false), plan("CX2", 4, true), plan("CX3", 5, false)]),
      "The cheapest listed price belongs to a plan marked not available, so the lowest number on the page is not a number you can pay.",
    );
  });

  it("counts every listed price below the cheapest orderable one, and none level with it", () => {
    assert.equal(
      unpayableLowestPricesSentence([plan("CX1", 3, false), plan("CX2", 3.5, false), plan("CX3", 4, false), plan("CX4", 4, true), plan("CX5", 3.9, false)]),
      "The 3 cheapest listed prices all belong to plans marked not available, so the lowest number on the page is not a number you can pay.",
    );
  });

  it("names the cheaper plan as more server only when it has at least as much of each and more of one, and sits above", () => {
    const entry = plan("CPX1", 6, true, 1, 1);
    assert.equal(cheaperUnorderablePlanWithMoreServer([plan("CX1", 5, false, 2, 4), entry])?.sku, "CX1");
    assert.equal(cheaperUnorderablePlanWithMoreServer([plan("CX1", 5, false, 1, 2), entry])?.sku, "CX1");
    assert.equal(cheaperUnorderablePlanWithMoreServer([plan("CX1", 5, false, 1, 1), entry]), null);
    assert.equal(cheaperUnorderablePlanWithMoreServer([plan("CX1", 5, false, 2, 0.5), entry]), null);
    assert.equal(cheaperUnorderablePlanWithMoreServer([entry, plan("CX1", 5, false, 2, 4)]), null);
    assert.equal(cheaperUnorderablePlanWithMoreServer([plan("CX1", 7, false, 2, 4), entry]), null);
  });
});

function sized(sku: string, ram: number, eur: number, usd: number, available = true, region = "EU"): HetznerPlan {
  return { sku, line: "Synthetic", cpu: "AMD", vcpu: 2, ram, region, eur, usd, available };
}

const isOrderableInTheEu = (p: HetznerPlan) => p.available && p.region === "EU";

const withAvailability = (sku: string, available: boolean) =>
  HETZNER_CLOUD_PLANS.map(p => (p.sku === sku ? { ...p, available } : p));

const memorySizeEntry = (p: HetznerPlan) => `${p.ram} GB, ${p.sku} at €${p.eur.toFixed(2)} (${dollars(p.usd)})`;

describe("the cheapest orderable EU plan for each memory size", () => {
  it("is chosen among EU plans marked orderable, one per memory size, smallest size first", () => {
    const plans = [
      sized("CCX8", 8, 9, 10.6),
      sized("CX8", 8, 4, 4.7, false),
      sized("CPX8", 8, 7, 8.3),
      sized("CX16", 16, 2, 2.4),
      sized("CPX2", 2, 3, 3.5),
      sized("CPX1", 1, 1, 1.2, true, "US"),
    ];
    assert.deepEqual(cheapestOrderableEuPlanForEachMemorySize(plans).map(p => p.sku), ["CPX2", "CPX8", "CX16"]);
  });

  it("goes to the plan listed first when two plans of one size share the lowest euro price, as the entry price does", () => {
    assert.deepEqual(cheapestOrderableEuPlanForEachMemorySize([sized("CPX8", 8, 7, 8.3), sized("CCX8", 8, 7, 8.3)]).map(p => p.sku), ["CPX8"]);
  });

  it("prints each size with that plan's euro and dollar prices, and nothing when no EU plan can be ordered", () => {
    assert.equal(
      cheapestOrderableEuPlanForEachMemorySizeSentence([sized("CPX8", 8, 7, 8.25), sized("CPX2", 2, 3.5, 4.1)]),
      "Cheapest orderable EU plan for each memory size: 2 GB, CPX2 at €3.50 ($4.10); 8 GB, CPX8 at €7.00 ($8.25).",
    );
    assert.equal(cheapestOrderableEuPlanForEachMemorySizeSentence([sized("CX2", 2, 3, 3.5, false), sized("CPX2", 2, 3, 3.5, true, "US")]), "");
  });

  it("names, in every size the plan table has, a plan no other orderable EU plan of that size undercuts in dollars", () => {
    const named = cheapestOrderableEuPlanForEachMemorySize();
    assert.ok(named.length > 0);
    for (const cheapest of named) {
      for (const other of HETZNER_CLOUD_PLANS.filter(p => isOrderableInTheEu(p) && p.ram === cheapest.ram)) {
        assert.ok(cheapest.usd <= other.usd, `${cheapest.sku} is the cheapest ${cheapest.ram} GB plan in euros, but ${other.sku} is cheaper in dollars`);
      }
    }
  });

  it("hands a size to the next cheapest orderable EU plan of that size, or drops the size, when the plan named for it is marked not available", () => {
    for (const named of cheapestOrderableEuPlanForEachMemorySize()) {
      const plans = withAvailability(named.sku, false);
      const next = plans.filter(p => isOrderableInTheEu(p) && p.ram === named.ram).sort((a, b) => a.eur - b.eur)[0];
      const sentence = cheapestOrderableEuPlanForEachMemorySizeSentence(plans);
      assert.ok(!sentence.includes(memorySizeEntry(named)), `${named.sku} is still named once it is not available: ${sentence}`);
      if (next) assert.ok(sentence.includes(memorySizeEntry(next)), `${named.ram} GB should read ${memorySizeEntry(next)}: ${sentence}`);
      else assert.doesNotMatch(sentence, new RegExp(`[:;] ${named.ram} GB, `), sentence);
    }
  });

  it("gives a size to a plan nobody can order today once it is orderable, when it is cheaper than the plan named for that size", () => {
    const today = cheapestOrderableEuPlanForEachMemorySize();
    for (const candidate of HETZNER_CLOUD_PLANS.filter(p => !p.available && p.region === "EU")) {
      const named = today.find(p => p.ram === candidate.ram);
      const expected = named === undefined || candidate.eur < named.eur ? candidate : named;
      const sentence = cheapestOrderableEuPlanForEachMemorySizeSentence(withAvailability(candidate.sku, true));
      assert.ok(sentence.includes(memorySizeEntry(expected)), `with ${candidate.sku} orderable, ${candidate.ram} GB should read ${memorySizeEntry(expected)}: ${sentence}`);
    }
  });
});

describe("the pricing page prices what Hetzner sells today", () => {
  it("renders, so the assertions below are about a real page", async () => {
    const res = await get("/hetzner-pricing-2026");
    assert.equal(res.status, 200);
  });

  it("names the date its prices were read, and where from", async () => {
    const { body } = await get("/hetzner-pricing-2026");
    assert.ok(visible(body).includes(`Plan prices read from Hetzner's price API on ${HETZNER_PRICES_READ}`));
    assert.doesNotMatch(visible(body), /read from hetzner\.com on/i);
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

  it("counts in its table note the listed prices below the cheapest orderable plan, and names that plan", async () => {
    const { body } = await get("/hetzner-pricing-2026");
    const text = visible(body);
    const cheapest = cheapestOrderableHetznerPlan();
    const below = HETZNER_CLOUD_PLANS.filter(p => p.eur < cheapest.eur);
    const several = text.match(/The (\d+) cheapest listed prices all belong to plans marked not available/)?.[1];
    const one = text.includes("The cheapest listed price belongs to a plan marked not available");
    assert.equal(several === undefined ? (one ? 1 : 0) : Number(several), below.length, "the note counts a different number of unpayable prices than the table holds");
    assert.ok(
      text.includes(`The first orderable row is ${cheapest.sku} at €${cheapest.eur.toFixed(2)}, and it is a ${cheapest.vcpu}-vCPU, ${cheapest.ram} GB machine`),
      "the note does not name the cheapest orderable plan",
    );
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
      ...[HETZNER_AX42_GERMANY, HETZNER_AX102_GERMANY].flatMap(server => Object.values(server)).map(price => `€${price.toFixed(2)}`),
      ...ADD_ON_PRICES_AS_WRITTEN,
      ...addOnExamples(),
      ...OBJECT_STORAGE_EUROS_AS_WRITTEN,
      ...objectStorageExamples(),
      ...VOLUME_EUROS_AS_WRITTEN,
      ...volumeExamples(),
      ...STORAGE_BOX_EUROS_AS_WRITTEN,
    ]);
    const quoted = new Set(eurosIn(visible(withoutItemsOrRowsHeadedByAnotherVendor(body))));
    const strays = [...quoted].filter(price => !allowed.has(price));
    assert.deepEqual(strays, [], `prices with no plan, April row, dedicated-server figure, add-on, Object Storage, Volume or Storage Box price behind them: ${strays.join(", ")}`);
  });

  it("quotes no dollar price that is not in the plan table, the April example, the Object Storage prices or the Volume price", async () => {
    const { body } = await get("/hetzner-pricing-2026");
    const allowed = new Set([
      ...HETZNER_CLOUD_PLANS.map(p => dollars(p.usd)),
      dollars(HETZNER_APRIL_DOLLAR_EXAMPLE.before),
      dollars(HETZNER_APRIL_DOLLAR_EXAMPLE.after),
      ...OBJECT_STORAGE_DOLLARS_AS_WRITTEN,
      ...VOLUME_DOLLARS_AS_WRITTEN,
    ]);
    const quoted = new Set(dollarsIn(visible(withoutItemsOrRowsHeadedByAnotherVendor(body))));
    const strays = [...quoted].filter(price => !allowed.has(price));
    assert.deepEqual(strays, [], `dollar prices with no plan, April, Object Storage or Volume figure behind them: ${strays.join(", ")}`);
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

  it("names every route that prints the plan table's entry price", async () => {
    const clause = hetznerEntryPriceClause();
    const routes = await everyRouteTheSitemapPublishes(`http://localhost:${serverPort}`);
    const printing: string[] = [];
    for (let at = 0; at < routes.length; at += 16) {
      await Promise.all(routes.slice(at, at + 16).map(async route => {
        const { status, body } = await get(route);
        if (status === 200 && visible(body).includes(clause)) printing.push(route);
      }));
    }
    assert.deepEqual(printing.sort(), [...PAGES_NAMING_HETZNER_PRICES].sort());
  });

  it("composes that price from the plan table rather than from a literal", () => {
    const cheapest = cheapestOrderableHetznerPlan();
    assert.equal(hetznerEntryPriceClause(), `${cheapest.sku} at €${cheapest.eur.toFixed(2)}/mo (${cheapest.vcpu} vCPU, ${cheapest.ram} GB)`);
  });
});

const SETUP_FEE_STATEMENTS = {
  "2 February": "https://www.hetzner.com/pressroom/statement-setup-fees-adjustment/",
  "29 April": "https://www.hetzner.com/pressroom/statement-on%20the-latest-adjustment-to%20setup-fees/",
};

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
    assert.ok(text.includes("Hetzner raised them in February: its add-on price list of 2026-02-17 put a 64 GB DDR5 ECC step at €111 a month, up from €22, and a 32 GB step at €66, up from €14."));
    assert.ok(text.includes("128 GB as two 64 GB DDR5 ECC steps went from €44 to €222 a month"));
    assert.ok(text.includes("Until 15 June, adding 128 GB of memory that way cost more than a whole AX102 server with 128 GB built in (€107.30 a month before April, €122.30 after, in Germany)."));
  });

  it("gives the range dedicated servers rose by in April, then what new orders cost after April and in June, directly after the range for cloud servers", async () => {
    const text = visible((await get("/hetzner-pricing-2026")).body);
    assert.ok(text.includes(
      "against 30-37% in euros. Dedicated servers rose 2-21% in euros and 3-26% in dollars on 1 April 2026. In Germany, the AX42 went from €47.30 to €57.30. After the April 1 adjustment, new orders cost €57.30 for an AX42 and €122.30 for an AX102. On June 15, prices rose to €187.30 and €452.30, then fell on June 30 to the current prices. Hetzner adjusted setup fees for dedicated servers on 2 February and 29 April 2026, citing RAM and NVMe SSD costs; its statements give no fee amounts. Memory upgrades for dedicated servers are not in the April table.",
    ));
  });

  it("gives what a new AX42 and AX102 cost today in section 1, with the setup fee and the day the price was read, and not in section 2's history", async () => {
    const { body } = await get("/hetzner-pricing-2026");
    const sectionOne = visible(body.slice(body.indexOf('<h2 id="pricing">'), body.indexOf('<h2 id="april">')).replace(/<ul class="listing-conditions"[^>]*>[\s\S]*?<\/ul>/g, "")).trim();
    const sectionTwo = visible(body.slice(body.indexOf('<h2 id="april">'), body.indexOf('<h2 id="why">')));
    assert.ok(sectionOne.includes(
      `A new AX42 dedicated server in Germany costs €97.30 a month and a new AX102 €257.30, excluding IPv4. The one-off setup fee is €49 for an AX42 and €129 for an AX102. These prices were read from Hetzner's price API on ${HETZNER_PRICES_READ}.`,
    ), sectionOne.slice(-400));
    assert.doesNotMatch(sectionTwo, /now costs?|€97\.30|€257\.30|setup fee is/);
  });

  it("links each setup-fee adjustment's day to Hetzner's statement of it", async () => {
    const { body } = await get("/hetzner-pricing-2026");
    for (const [day, statement] of Object.entries(SETUP_FEE_STATEMENTS)) {
      assert.ok(body.includes(`<a href="${statement}" target="_blank" rel="noopener">${day}</a>`), `${day} does not link ${statement}`);
    }
  });

  it("no longer advises bundling memory in a dedicated server, which new orders pay the June price for", async () => {
    const { body } = await get("/hetzner-pricing-2026");
    for (const retired of ["last changed 2026-02-17", "Bundle RAM in Dedicated Servers", "where RAM is bundled"]) {
      assert.ok(!body.includes(retired), retired);
    }
    assert.ok(visible(body).includes("128 GB as two 64 GB DDR5 ECC steps went from €44 to €222 a month. Consider auction servers."));
  });

  it("states none of the figures that were not Hetzner's", async () => {
    const text = visible((await get("/hetzner-pricing-2026")).body);
    assert.doesNotMatch(text, /575%|€45\.88|€264\.00|€49\.73|€51\.22|US\/SG object storage|cost €124/);
  });
});

describe("when /hetzner-pricing-2026 says each 2026 change happened", () => {
  it("dates each change right after its bold opening sentence", async () => {
    const { body } = await get("/hetzner-pricing-2026");
    const summary = body.slice(body.indexOf('<div class="executive-summary">'));
    const opening = visible(summary.slice(0, summary.indexOf("</p>"))).trim();
    assert.ok(opening.startsWith(
      "Hetzner raised cloud prices twice in 2026, and the second round changed the lineup as well as the numbers. Dedicated-server memory add-ons rose in February. Setup fees changed on 2 February and 29 April. Server prices rose on 1 April. New-order prices rose on 15 June. The April 1 adjustment",
    ), opening);
  });

  it("counts cloud price adjustments, not every 2026 change, in its tile", async () => {
    const { body } = await get("/hetzner-pricing-2026");
    const labels = [...body.matchAll(/<div class="stat-label">([^<]*)<\/div>/g)].map((m) => m[1]);
    assert.ok(labels.includes("Cloud price adjustments in 2026"), labels.join(" | "));
    assert.ok(!labels.includes("Price adjustments in 2026"), labels.join(" | "));
  });
});

describe("what /hetzner-pricing-2026 says the June round did", () => {
  it("ends its opening paragraph with the rise of each cloud line in Germany and Finland", async () => {
    const { body } = await get("/hetzner-pricing-2026");
    const summary = body.slice(body.indexOf('<div class="executive-summary">'));
    const opening = visible(summary.slice(0, summary.indexOf("</p>"))).trim();
    assert.ok(opening.endsWith("The June 15 adjustment raised Regular Performance (CPX) plans 144-175%, General Purpose (CCX) plans 113-173%, and Cost-Optimized (CX, CAX) plans 30-38% in Germany and Finland."), opening);
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
    const text = visible((await get("/hetzner-pricing-2026")).body.replace(/<div class="row-referral"[\s\S]*?<\/div>/g, " "));
    assert.ok(text.includes("Vultr Cloud — 1 vCPU, 1 GB $5/mo Global Free instance (1 vCPU, 512 MB, 10 GB SSD) for accepted applicants, in Miami, Seattle and Frankfurt Our record"));
  });
});

describe("the notes in /hetzner-pricing-2026's alternatives table", () => {
  it("gives the Linode row no note beside the figures the Akamai Cloud record states", async () => {
    const text = visible((await get("/hetzner-pricing-2026")).body);
    assert.ok(text.includes("Linode/Akamai Nanode — 1 vCPU, 1 GB $5/mo Global Our record"));
  });

  it("says of no row that it has not been re-read since March 2026", async () => {
    const text = visible((await get("/hetzner-pricing-2026")).body);
    assert.doesNotMatch(text, /Not re-read since March 2026/);
  });
});

const alternativesRowLabelled = (body: string, label: string) => {
  const section = body.slice(body.indexOf('<h2 id="alternatives">'), body.indexOf('<h2 id="industry">'));
  const rows = [...section.matchAll(/<tr[\s>][\s\S]*?<\/tr>/g)]
    .map(([row]) => row)
    .filter(row => (row.match(/<td[^>]*>([\s\S]*?)<\/td>/)?.[1] ?? "").replace(/<[^>]+>/g, "").trim() === label);
  assert.strictEqual(rows.length, 1, `section 6 should hold one ${label} row`);
  return rows[0];
};

const linksIn = (markup: string) => [...markup.matchAll(/<a href="([^"]+)"/g)].map(([, href]) => href);

describe("/hetzner-pricing-2026's Linode and Lightsail rows read the listings those vendors have", () => {
  for (const [label, listing] of [["Linode/Akamai", "akamai-cloud"], ["AWS Lightsail", "amazon-lightsail"]]) {
    it(`links the ${label} row's name and provenance to /vendor/${listing}`, async () => {
      const row = alternativesRowLabelled((await get("/hetzner-pricing-2026")).body, label);
      const [nameCell] = row.match(/<td[^>]*>[\s\S]*?<\/td>/) ?? [""];
      const provenanceCell = row.match(/<td class="figure-provenance"[^>]*>([\s\S]*?)<\/td>/)?.[1] ?? "";
      assert.deepStrictEqual(linksIn(nameCell), [`/vendor/${listing}`]);
      assert.strictEqual(provenanceCell.replace(/<[^>]+>/g, "").trim(), "Our record");
      assert.deepStrictEqual(linksIn(provenanceCell), [`/vendor/${listing}`]);
    });

    it(`answers 200 at /vendor/${listing}, the page the ${label} row links`, async () => {
      assert.strictEqual((await get(`/vendor/${listing}`)).status, 200);
    });
  }
});

describe("why /hetzner-pricing-2026 says prices rose", () => {
  it("gives the doubling of memory prices The Register reported as the forecast it was", async () => {
    const text = visible((await get("/hetzner-pricing-2026")).body);
    assert.ok(text.includes("Memory prices were forecast to double — in February 2026 The Register reported that DRAM and NAND flash prices were expected to double that quarter; NVMe SSDs in cloud servers use NAND flash"));
    assert.doesNotMatch(text, /NAND flash prices roughly doubled/);
  });
});

const QUOTED_HACKER_NEWS_COMMENT = {
  url: "https://news.ycombinator.com/item?id=47122482",
  text: [
    "Running a small project on Hetzner from Germany. Got the email this morning. Honestly, even after the increase their dedicated boxes are still absurdly cheap compared to what you'd pay at AWS or GCP for equivalent specs.",
    "The real story here isn't Hetzner being greedy. It's that AI companies are vacuuming up every DRAM chip on the planet and the rest of us get to pay the tax. I priced out a RAM upgrade for my home server last week. Same kit I bought 8 months ago for 90 EUR is now 400+. That's not normal market dynamics.",
    "What worries me more is the second-order effects. Startups that would normally spin up cheap VPS instances to prototype and iterate now face meaningfully higher costs at the exact stage where every euro matters. The \"just deploy it\" culture that made European indie dev scene so productive was built on sub-10 EUR/month boxes. Those days might be over for a while.",
  ].join(" "),
  excerpt: "Honestly, even after the increase their dedicated boxes are still absurdly cheap compared to what you'd pay at AWS or GCP for equivalent specs. The real story here isn't Hetzner being greedy. It's that AI companies are vacuuming up every DRAM chip on the planet and the rest of us get to pay the tax.",
};

const communityReaction = (body: string) =>
  body.match(/<p[^>]*><strong>Community reaction<\/strong>[\s\S]*?<\/p>/)?.[0] ?? "";

describe("the Hacker News comment /hetzner-pricing-2026 quotes", () => {
  it("is quoted as a run of the comment's own words", () => {
    assert.ok(QUOTED_HACKER_NEWS_COMMENT.text.includes(QUOTED_HACKER_NEWS_COMMENT.excerpt));
  });

  it("is printed word for word and linked to the comment itself", async () => {
    const paragraph = communityReaction((await get("/hetzner-pricing-2026")).body);
    assert.equal(paragraph.match(/<a href="([^"]+)"[^>]*>Hacker News comment<\/a>/)?.[1], QUOTED_HACKER_NEWS_COMMENT.url);
    assert.equal(visible(paragraph).match(/\): "([^"]*)"/)?.[1], QUOTED_HACKER_NEWS_COMMENT.excerpt);
  });

  it("is the only text the page attributes to Hacker News", async () => {
    const { body } = await get("/hetzner-pricing-2026");
    assert.deepEqual([...body.matchAll(/href="(https:\/\/news\.ycombinator\.com\/[^"]*)"/g)].map(([, url]) => url), [QUOTED_HACKER_NEWS_COMMENT.url]);
    assert.doesNotMatch(visible(body), /HN commenter|pricing out smaller operations|still the cheapest option|Even after \+30-50%/);
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

const sectionOneParagraphs = (body: string) => {
  const sectionOneHtml = body.slice(body.indexOf('<h2 id="pricing">'), body.indexOf('<h2 id="april">'));
  return [...sectionOneHtml.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/g)].map(([, inner]) => visible(inner).trim());
};

const isTheAvailabilityNote = (paragraph: string) => paragraph.startsWith("Read this table by availability first.");

describe("the cheapest orderable EU plan for each memory size on /hetzner-pricing-2026", () => {
  it("is the paragraph right after the table's availability note", async () => {
    const { body } = await get("/hetzner-pricing-2026");
    const paragraphs = sectionOneParagraphs(body);
    const availabilityNote = paragraphs.findIndex(isTheAvailabilityNote);
    assert.ok(availabilityNote > -1, paragraphs.join(" | "));
    assert.strictEqual(paragraphs[availabilityNote + 1], cheapestOrderableEuPlanForEachMemorySizeSentence());
  });

  it("gives every size the memory and the euro and dollar prices of the table row for the plan it names, an orderable EU plan", async () => {
    const { body } = await get("/hetzner-pricing-2026");
    const line = sectionOneParagraphs(body).find(paragraph => paragraph.startsWith("Cheapest orderable EU plan for each memory size: ")) ?? "";
    const entries = [...line.matchAll(/(\d+) GB, (\w+) at €(\d+\.\d{2}) \(\$(\d+\.\d{2})\)/g)];
    assert.ok(entries.length > 0, line);
    for (const [entry, ram, sku, eur, usd] of entries) {
      const row = HETZNER_CLOUD_PLANS.find(p => p.sku === sku);
      assert.ok(row && isOrderableInTheEu(row), `${sku} is not an orderable EU plan in the table: ${entry}`);
      assert.deepEqual([Number(ram), eur, usd], [row.ram, row.eur.toFixed(2), row.usd.toFixed(2)], entry);
    }
  });

  it("is printed by the guide's builder from the plan table, not typed into it", () => {
    const source = readFileSync(path.join(REPO, "src", "serve.ts"), "utf-8");
    const start = source.indexOf("function buildHetznerPricing2026Page(");
    assert.ok(start > 0, "buildHetznerPricing2026Page is no longer in src/serve.ts");
    const next = source.indexOf("\nfunction ", start + 1);
    const body = source.slice(start, next > 0 ? next : undefined);
    assert.ok(body.includes("cheapestOrderableEuPlanForEachMemorySizeSentence()"), "the guide does not take the line from the plan table");
    assert.ok(!body.includes("for each memory size"), "the guide types the line instead of printing it from the plan table");
  });
});

describe("what a Hetzner cloud price on /hetzner-pricing-2026 includes", () => {
  const INCLUDED_IN_THE_PRICE = "Every cloud price in this table includes the primary IPv4 address. Cloud servers include at least 20 TB of outgoing traffic a month in the EU, 1 TB in the US and 0.5 TB in Singapore; incoming traffic is free.";

  it("is the paragraph after the table's availability note and the cheapest plan for each memory size, ahead of the dedicated-server prices that exclude IPv4", async () => {
    const { body } = await get("/hetzner-pricing-2026");
    const paragraphs = sectionOneParagraphs(body);
    const availabilityNote = paragraphs.findIndex(isTheAvailabilityNote);
    assert.ok(availabilityNote > -1, paragraphs.join(" | "));
    assert.strictEqual(paragraphs[availabilityNote + 2], INCLUDED_IN_THE_PRICE);
    assert.match(paragraphs[availabilityNote + 3] ?? "", /^A new AX42 dedicated server in Germany costs .*, excluding IPv4\./);
  });
});

describe("the add-on prices Hetzner's listing states", () => {
  it("are printed among the listing's conditions on /hetzner-pricing-2026 and /vendor/hetzner", async () => {
    const texts = [TRAFFIC_CONDITION, BACKUP_PRICE_CONDITION, BACKUP_SLOTS_CONDITION, SNAPSHOT_CONDITION].map(hetznerConditionOpening);
    for (const route of ["/hetzner-pricing-2026", "/vendor/hetzner"]) {
      const { status, body } = await get(route);
      assert.equal(status, 200, route);
      const printed = [...body.matchAll(/<ul class="listing-conditions"[\s\S]*?<\/ul>/g)].map(([list]) => visible(list)).join(" ");
      for (const text of texts) assert.ok(printed.includes(text), `${route} does not print: ${text}`);
    }
  });

  it("charge traffic beyond the included amount at the per-TB prices the add-on table holds", () => {
    const text = hetznerConditionOpening(TRAFFIC_CONDITION);
    assert.deepEqual(eurosIn(text), [trafficPerTbBeyondTheIncluded.euAndUs, trafficPerTbBeyondTheIncluded.singapore].map(asWritten), text);
  });

  it("price backups at the table's share of the server price less its IPv4 address, with an example derived from the plan it names", () => {
    const text = hetznerConditionOpening(BACKUP_PRICE_CONDITION);
    const { backup, withBackups } = backupExample(text);
    assert.equal(text.match(/(\d+)%/)?.[1], String(Math.round(backupShareOfThePriceWithoutIpv4 * 100)), text);
    assert.deepEqual(eurosIn(text).sort(), [asWritten(ipv4PerMonth), withBackups, backup].sort(), text);
  });

  it("price snapshots per GB, with an example derived from that price", () => {
    const text = hetznerConditionOpening(SNAPSHOT_CONDITION);
    assert.deepEqual(eurosIn(text).sort(), [asWritten(snapshotPerGbMonth), snapshotExample(text)].sort(), text);
  });
});

describe("what Object Storage costs, as Hetzner's listing states it", () => {
  it("follows the snapshot condition, the prices first and then how the base price is billed", () => {
    const at = (opening: string) => HETZNER_CONDITIONS.findIndex(condition => condition.text.startsWith(opening));
    assert.ok(at(SNAPSHOT_CONDITION) > -1);
    assert.deepEqual(
      [at(OBJECT_STORAGE_PRICE_CONDITION), at(OBJECT_STORAGE_BILLING_CONDITION)],
      [at(SNAPSHOT_CONDITION) + 1, at(SNAPSHOT_CONDITION) + 2],
    );
  });

  it("is printed after the snapshot condition on /hetzner-pricing-2026 and /vendor/hetzner", async () => {
    const texts = [SNAPSHOT_CONDITION, OBJECT_STORAGE_PRICE_CONDITION, OBJECT_STORAGE_BILLING_CONDITION].map(hetznerConditionOpening);
    for (const route of ["/hetzner-pricing-2026", "/vendor/hetzner"]) {
      const { status, body } = await get(route);
      assert.equal(status, 200, route);
      const printed = [...body.matchAll(/<ul class="listing-conditions"[\s\S]*?<\/ul>/g)].map(([list]) => visible(list)).join(" ");
      const positions = texts.map(text => printed.indexOf(text));
      assert.ok(positions.every(position => position > -1), `${route} does not print all of: ${texts.join(" | ")}`);
      assert.deepEqual([...positions].sort((a, b) => a - b), positions, route);
    }
  });

  it("gives the base price, storage and egress beyond the quota in euros and dollars as the Object Storage prices hold them", () => {
    const text = hetznerConditionOpening(OBJECT_STORAGE_PRICE_CONDITION);
    const [base, storage, egress] = OBJECT_STORAGE_EUROS_AS_WRITTEN;
    assert.deepEqual(eurosIn(text), [base, storage, objectStorageMonthExample(text), egress], text);
    assert.deepEqual(dollarsIn(text), OBJECT_STORAGE_DOLLARS_AS_WRITTEN, text);
  });
});

describe("what Volumes and Storage Boxes cost, as Hetzner's listing states it", () => {
  const VOLUME_AND_STORAGE_BOX_CONDITIONS = [VOLUME_PRICE_CONDITION, VOLUME_SIZE_CONDITION, STORAGE_BOX_CONDITION];

  it("follows the Object Storage billing condition, the Volume price first, then resizing, then Storage Boxes", () => {
    const at = (opening: string) => HETZNER_CONDITIONS.findIndex(condition => condition.text.startsWith(opening));
    assert.ok(at(OBJECT_STORAGE_BILLING_CONDITION) > -1);
    assert.deepEqual(
      VOLUME_AND_STORAGE_BOX_CONDITIONS.map(at),
      [1, 2, 3].map(offset => at(OBJECT_STORAGE_BILLING_CONDITION) + offset),
    );
  });

  it("is printed after the Object Storage billing condition on /hetzner-pricing-2026 and /vendor/hetzner", async () => {
    const texts = [OBJECT_STORAGE_BILLING_CONDITION, ...VOLUME_AND_STORAGE_BOX_CONDITIONS].map(hetznerConditionOpening);
    for (const route of ["/hetzner-pricing-2026", "/vendor/hetzner"]) {
      const { status, body } = await get(route);
      assert.equal(status, 200, route);
      const printed = [...body.matchAll(/<ul class="listing-conditions"[\s\S]*?<\/ul>/g)].map(([list]) => visible(list)).join(" ");
      const positions = texts.map(text => printed.indexOf(text));
      assert.ok(positions.every(position => position > -1), `${route} does not print all of: ${texts.join(" | ")}`);
      assert.deepEqual([...positions].sort((a, b) => a - b), positions, route);
    }
  });

  it("gives the Volume price in euros and dollars, an example derived from it, and the price before April as the Volume prices hold them", () => {
    const text = hetznerConditionOpening(VOLUME_PRICE_CONDITION);
    const [perGb, beforeApril] = VOLUME_EUROS_AS_WRITTEN;
    assert.deepEqual(eurosIn(text), [perGb, volumeMonthExample(text), beforeApril], text);
    assert.deepEqual(dollarsIn(text), VOLUME_DOLLARS_AS_WRITTEN, text);
  });

  it("gives each Storage Box size its price as the Storage Box prices hold them, smallest first, naming the 1 TB box", () => {
    const text = hetznerConditionOpening(STORAGE_BOX_CONDITION);
    assert.deepEqual(eurosIn(text), STORAGE_BOX_EUROS_AS_WRITTEN, text);
    assert.deepEqual([...text.matchAll(/€\d+\.\d{2} (?:a month )?for (\d+) TB/g)].map(([, tb]) => Number(tb)), HETZNER_STORAGE_BOX_PRICES.map(box => box.tb), text);
    assert.ok(text.includes(`for ${HETZNER_STORAGE_BOX_PRICES[0]!.tb} TB (${HETZNER_STORAGE_BOX_PRICES[0]!.sku})`), text);
  });
});

describe("the sign-up credit /hetzner-pricing-2026 tells new customers about", () => {
  const PROMO_CODE_PAGE = "https://www.hetzner.com/promo-code/";
  const SIGN_UP_CREDIT_SENTENCE = "New accounts can get €50 of credit with Hetzner's sign-up code, valid only for the billing period in which it is redeemed.";
  const SIGN_UP_CREDIT_SUBSECTION = "New customers without an active Hetzner account can get €50 in credit for all Hetzner products. The code must be redeemed within 14 days of account creation. The credit is valid only for the billing period in which it is redeemed. Redeeming on the 20th leaves about ten days of it. Redeem on the 1st for full benefit. The code is at hetzner.com/promo-code. It cannot be combined with a referral code.";

  it("is stated in section 1 right after the dedicated-server prices, ahead of the listing's conditions", async () => {
    const { body } = await get("/hetzner-pricing-2026");
    const sectionOneHtml = body.slice(body.indexOf('<h2 id="pricing">'), body.indexOf('<h2 id="april">'));
    const sectionOne = visible(sectionOneHtml.replace(/<ul class="listing-conditions"[^>]*>[\s\S]*?<\/ul>/g, "")).trim();
    assert.ok(sectionOne.endsWith(`These prices were read from Hetzner's price API on ${HETZNER_PRICES_READ}. ${SIGN_UP_CREDIT_SENTENCE}`), sectionOne.slice(-400));
    const conditionsAt = sectionOneHtml.indexOf('<ul class="listing-conditions"');
    if (conditionsAt > -1) assert.ok(sectionOneHtml.indexOf(SIGN_UP_CREDIT_SENTENCE) < conditionsAt);
  });

  it("is explained in section 8's last subsection, which links Hetzner's promo-code page", async () => {
    const { body } = await get("/hetzner-pricing-2026");
    const sectionEight = body.slice(body.indexOf('<h2 id="optimize">'), body.indexOf("<h2>Related Guides</h2>"));
    const subsections = [...sectionEight.matchAll(/<div class="impact-card"[^>]*>([\s\S]*?)<\/div>/g)].map(([, inner]) => inner);
    const last = subsections[subsections.length - 1] ?? "";
    assert.strictEqual(visible(last.replace(/<\/?a\b[^>]*>/g, "")).trim(), `Sign-up credit for new customers ${SIGN_UP_CREDIT_SUBSECTION}`);
    assert.ok(last.includes(`<a href="${PROMO_CODE_PAGE}" target="_blank" rel="noopener">hetzner.com/promo-code</a>`), last);
  });

  it("points to Hetzner's page for the code rather than printing one", async () => {
    const { body } = await get("/hetzner-pricing-2026");
    assert.doesNotMatch(body, /HetznerPromo/i);
  });
});

describe("the day /hetzner-pricing-2026 says Hetzner's prices were read", () => {
  const SCRATCH_DAY = "2026-10-09";
  let scratch = "";
  let scratchServer: ChildProcess | null = null;
  let page = "";

  before(async () => {
    scratch = mkdtempSync(path.join(tmpdir(), "hetzner-prices-read-"));
    const file = path.join(scratch, "hetzner_prices_read.json");
    writeFileSync(file, JSON.stringify({ read_on: SCRATCH_DAY }));
    const { child, port } = await spawnServer({ AGENTDEALS_HETZNER_PRICES_READ_PATH: file });
    scratchServer = child;
    page = await (await fetch(`http://localhost:${port}/hetzner-pricing-2026`)).text();
  });

  after(() => {
    if (scratchServer) scratchServer.kill();
    scratchServer = null;
    rmSync(scratch, { recursive: true, force: true });
  });

  it("is the day data/hetzner_prices_read.json gives", () => {
    const file = JSON.parse(readFileSync(path.join(REPO, "data", "hetzner_prices_read.json"), "utf8"));
    assert.strictEqual(HETZNER_PRICES_READ, file.read_on);
  });

  it("is printed from that file in the byline, the meta description, section 1, its dedicated-server prices, the methodology and section 6's Hetzner row", () => {
    const text = visible(page);
    const description = page.match(/<meta name="description" content="([^"]*)"/)?.[1] ?? "";
    assert.ok(text.includes(`Plan prices read from Hetzner's price API on ${SCRATCH_DAY}`), "byline");
    assert.ok(description.includes(`read from Hetzner's price API on ${SCRATCH_DAY}`), description);
    assert.ok(text.includes(`with the monthly price read from Hetzner's price API on ${SCRATCH_DAY} and the availability hetzner.com showed on ${HETZNER_AVAILABILITY_READ}.`), "section 1");
    assert.ok(text.includes(`These prices were read from Hetzner's price API on ${SCRATCH_DAY}.`), "section 1's dedicated-server prices");
    assert.ok(text.includes(`Plan prices in section 1 were read from Hetzner's price API on ${SCRATCH_DAY}`), "methodology");
    assert.ok(text.includes(`Hetzner's price API, read ${SCRATCH_DAY}`), "section 6");
    assert.doesNotMatch(text, /read from hetzner\.com on/i);
  });

  it("is refused unless the file gives a calendar day", () => {
    assert.strictEqual(parseHetznerPricesRead('{"read_on":"2026-10-02"}', "scratch.json"), "2026-10-02");
    for (const text of ["{", "null", "{}", '{"read_on":"2026-02-30"}', '{"read_on":"2026-10-2"}', '{"read_on":20261002}']) {
      assert.throws(() => parseHetznerPricesRead(text, "scratch.json"), /^Error: scratch\.json /, text);
    }
  });
});

describe("the dollar prices /hetzner-pricing-2026 gives beside each euro price", () => {
  const BOTH_CURRENCIES_SENTENCE = "Each cell shows the price for accounts billed in euros and the price for accounts billed in US dollars.";

  const planTable = (body: string) => {
    const sectionOneHtml = body.slice(body.indexOf('<h2 id="pricing">'), body.indexOf('<h2 id="april">'));
    return sectionOneHtml.match(/<table class="pricing-table">[\s\S]*?<\/table>/)?.[0] ?? "";
  };

  it("heads the price column Per month (€ / $) and prints both prices in every row, in the plan table's order", async () => {
    const { body } = await get("/hetzner-pricing-2026");
    const table = planTable(body);
    const headers = [...table.matchAll(/<th>([\s\S]*?)<\/th>/g)].map(([, inner]) => visible(inner).trim());
    assert.deepEqual(headers, ["Plan", "Spec", "Line", "Region", "Per month (€ / $)", "Availability"]);
    const rows = [...table.matchAll(/<tr\b[^>]*>\s*<td[\s\S]*?<\/tr>/g)].map(([row]) => [...row.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/g)].map(([, inner]) => visible(inner).trim()));
    assert.deepEqual(
      rows.map(cells => [cells[0], cells[4]]),
      HETZNER_CLOUD_PLANS.map(p => [p.sku, `€${p.eur.toFixed(2)} / ${dollars(p.usd)}`]),
    );
  });

  it("says what the two prices in each cell are, right after the sentence on Singapore", async () => {
    const { body } = await get("/hetzner-pricing-2026");
    const sectionOneHtml = body.slice(body.indexOf('<h2 id="pricing">'), body.indexOf('<h2 id="april">'));
    const intro = visible(sectionOneHtml.match(/<p class="section-intro">([\s\S]*?)<\/p>/)?.[1] ?? "").trim();
    assert.ok(intro.endsWith(`Singapore is priced higher again and is not listed here. ${BOTH_CURRENCIES_SENTENCE}`), intro);
  });

  it("gives the April dollar example from its named figures", async () => {
    const { body } = await get("/hetzner-pricing-2026");
    const { sku, before, after } = HETZNER_APRIL_DOLLAR_EXAMPLE;
    assert.ok(visible(body).includes(`cloud servers rose 28-43% in dollars (${sku} from ${dollars(before)} to ${dollars(after)})`));
  });
});

describe("the account currency and payment methods Hetzner's listing states", () => {
  const LAST_VAT_CONDITION = "Outside the EU, Hetzner adds tax only";
  const CURRENCY_CONDITION = "When you create a Hetzner account, you choose euros or US dollars.";
  const PAYMENT_CONDITION = "Hetzner takes credit cards, SEPA direct debit, bank transfer and PayPal.";

  it("follow the VAT conditions, currency first", () => {
    const at = (opening: string) => HETZNER_CONDITIONS.findIndex(condition => condition.text.startsWith(opening));
    assert.ok(at(LAST_VAT_CONDITION) > -1);
    assert.deepEqual([at(CURRENCY_CONDITION), at(PAYMENT_CONDITION)], [at(LAST_VAT_CONDITION) + 1, at(LAST_VAT_CONDITION) + 2]);
  });

  it("are printed among the listing's conditions on /hetzner-pricing-2026 and /vendor/hetzner", async () => {
    const texts = [CURRENCY_CONDITION, PAYMENT_CONDITION].map(hetznerConditionOpening);
    for (const route of ["/hetzner-pricing-2026", "/vendor/hetzner"]) {
      const { status, body } = await get(route);
      assert.equal(status, 200, route);
      const printed = [...body.matchAll(/<ul class="listing-conditions"[\s\S]*?<\/ul>/g)].map(([list]) => visible(list)).join(" ");
      for (const text of texts) assert.ok(printed.includes(text), `${route} does not print: ${text}`);
    }
  });
});
