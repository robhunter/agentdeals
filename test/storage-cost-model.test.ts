import { describe, it } from "node:test";
import assert from "node:assert";

const model = await import("../dist/storage-cost-model.js");

const {
  STORAGE_RATE_CARDS,
  STORAGE_SCALE_WORKLOADS,
  billableEgressGb,
  cheapestProviderAt,
  costliestProviderAt,
  egressAllowanceSentence,
  egressBillOnceOverAllowance,
  fixedMonthlyGrantClause,
  fixedMonthlyGrantsSentence,
  formatMonthlyStorageCost,
  freeEgressAllowanceGb,
  monthlyStorageCost,
  providersWithScalingEgressAllowance,
  rateCardFor,
  scaleCostFor,
} = model;

describe("published storage rate cards", () => {
  it("prices every scenario for every provider in the scaling table", () => {
    for (const workload of STORAGE_SCALE_WORKLOADS) {
      for (const card of STORAGE_RATE_CARDS) {
        const cost = monthlyStorageCost(card, workload);
        assert.ok(Number.isFinite(cost) && cost > 0, `${card.provider} at ${workload.label} priced ${cost}`);
      }
    }
  });

  it("reproduces the three columns compiled from list rates without allowances", () => {
    const expected: Record<string, string[]> = {
      "Cloudflare R2": ["$1.50", "$15", "$150", "$1,500"],
      "AWS S3": ["$11.30", "$113", "$1,130", "$11,300"],
      "Google Cloud Storage": ["$14", "$140", "$1,400", "$14,000"],
    };
    for (const [provider, cells] of Object.entries(expected)) {
      STORAGE_SCALE_WORKLOADS.forEach((workload, i) => {
        assert.strictEqual(scaleCostFor(provider, workload), cells[i], `${provider} at ${workload.label}`);
      });
    }
  });

  it("charges Backblaze B2 nothing for egress inside its 3x allowance", () => {
    const b2 = rateCardFor("Backblaze B2");
    for (const workload of STORAGE_SCALE_WORKLOADS) {
      assert.strictEqual(workload.egressGb, workload.storageGb, `${workload.label} is not a 1x egress scenario`);
      assert.strictEqual(billableEgressGb(b2, workload), 0, `${workload.label} billed egress inside the allowance`);
      assert.strictEqual(
        monthlyStorageCost(b2, workload),
        workload.storageGb * b2.storagePerGbMonth,
        `${workload.label} charged more than storage`,
      );
    }
    assert.deepStrictEqual(
      STORAGE_SCALE_WORKLOADS.map(w => scaleCostFor("Backblaze B2", w)),
      ["$0.70", "$6.95", "$69.50", "$695"],
    );
  });

  it("bills Backblaze B2 for the excess once egress passes 3x storage", () => {
    const b2 = rateCardFor("Backblaze B2");
    const readHeavy = { storageGb: 1_000, egressGb: 10_000 };
    assert.strictEqual(freeEgressAllowanceGb(b2, readHeavy), 3_000);
    assert.strictEqual(billableEgressGb(b2, readHeavy), 7_000);
    assert.strictEqual(monthlyStorageCost(b2, readHeavy), 6.95 + 70);
    assert.match(egressBillOnceOverAllowance(b2, readHeavy), /3 TB free, 7 TB billed at \$0\.01\/GB/);
  });

  it("bills the whole egress at the headline rate for providers with no scaling allowance", () => {
    const workload = { storageGb: 1_000, egressGb: 1_000 };
    for (const card of STORAGE_RATE_CARDS) {
      if (card.freeEgressMultipleOfStorage > 0) continue;
      assert.strictEqual(freeEgressAllowanceGb(card, workload), 0, `${card.provider} was given an allowance`);
      assert.strictEqual(billableEgressGb(card, workload), 1_000, `${card.provider} egress was discounted`);
    }
  });

  it("names Backblaze B2 as the only provider whose egress allowance scales", () => {
    assert.deepStrictEqual(providersWithScalingEgressAllowance().map(c => c.provider), ["Backblaze B2"]);
  });

  it("nets out no fixed monthly grant from any column", () => {
    const withGrants = STORAGE_RATE_CARDS.filter(c => c.freeStorageGbPerMonth > 0 || c.freeEgressGbPerMonth > 0);
    assert.ok(withGrants.length >= 3, "expected most providers to publish a fixed monthly grant");
    const smallest = STORAGE_SCALE_WORKLOADS[0];
    for (const card of withGrants) {
      const billed = monthlyStorageCost(card, smallest);
      const netted =
        Math.max(0, smallest.storageGb - card.freeStorageGbPerMonth) * card.storagePerGbMonth +
        Math.max(0, billableEgressGb(card, smallest) - card.freeEgressGbPerMonth) * card.egressPerGb;
      assert.ok(billed >= netted, `${card.provider} priced below its own list rate`);
      assert.strictEqual(
        billed,
        smallest.storageGb * card.storagePerGbMonth + billableEgressGb(card, smallest) * card.egressPerGb,
        `${card.provider} had a fixed grant netted out`,
      );
    }
  });

  it("states every provider's fixed monthly grant so none is applied silently", () => {
    const sentence = fixedMonthlyGrantsSentence();
    for (const card of STORAGE_RATE_CARDS) {
      const clause = fixedMonthlyGrantClause(card);
      if (card.freeStorageGbPerMonth === 0 && card.freeEgressGbPerMonth === 0) {
        assert.strictEqual(clause, null, `${card.provider} has no grant to state`);
        continue;
      }
      assert.ok(clause, `${card.provider} publishes a grant with no clause`);
      assert.ok(sentence.includes(clause), `${card.provider} grant missing from the stated assumption`);
    }
    assert.match(sentence, /AWS S3 gives every account the first 100 GB of internet egress free each month/);
  });

  it("states the allowance for every provider, including the ones that have none", () => {
    for (const card of STORAGE_RATE_CARDS) {
      const sentence = egressAllowanceSentence(card);
      assert.ok(sentence.startsWith(card.provider), `${card.provider} sentence names another provider`);
      if (card.freeEgressMultipleOfStorage > 0) {
        assert.match(sentence, /free up to 3x average monthly storage, then \$0\.01\/GB/);
      } else {
        assert.match(sentence, /no egress allowance that scales/);
      }
    }
  });

  it("ranks Backblaze B2 cheapest and Google Cloud Storage dearest at every scenario in the table", () => {
    for (const workload of STORAGE_SCALE_WORKLOADS) {
      assert.strictEqual(cheapestProviderAt(workload), "Backblaze B2", `cheapest at ${workload.label}`);
      assert.strictEqual(costliestProviderAt(workload), "Google Cloud Storage", `dearest at ${workload.label}`);
      assert.ok(
        monthlyStorageCost(rateCardFor("Backblaze B2"), workload) < monthlyStorageCost(rateCardFor("Cloudflare R2"), workload),
        `B2 not below R2 at ${workload.label}`,
      );
    }
  });

  it("finds the egress ratio where B2 stops being cheaper than R2", () => {
    const b2 = rateCardFor("Backblaze B2");
    const r2 = rateCardFor("Cloudflare R2");
    const crossover = model.egressRatioWhereCostsMatch(b2, r2);
    assert.strictEqual(crossover, 3.8);
    const below = { storageGb: 1_000, egressGb: 1_000 * (crossover! - 0.2) };
    const above = { storageGb: 1_000, egressGb: 1_000 * (crossover! + 0.2) };
    assert.ok(monthlyStorageCost(b2, below) < monthlyStorageCost(r2, below), "B2 not cheaper below the crossover");
    assert.ok(monthlyStorageCost(b2, above) > monthlyStorageCost(r2, above), "B2 not dearer above the crossover");
  });

  it("reports no crossover for a provider that never starts out cheaper", () => {
    assert.strictEqual(
      model.egressRatioWhereCostsMatch(rateCardFor("Cloudflare R2"), rateCardFor("Backblaze B2")),
      null,
    );
    assert.strictEqual(
      model.egressRatioWhereCostsMatch(rateCardFor("Backblaze B2"), rateCardFor("AWS S3")),
      null,
    );
  });

  it("shows cents only where the amount has them", () => {
    assert.strictEqual(formatMonthlyStorageCost(0.695), "$0.70");
    assert.strictEqual(formatMonthlyStorageCost(15), "$15");
    assert.strictEqual(formatMonthlyStorageCost(11.3), "$11.30");
    assert.strictEqual(formatMonthlyStorageCost(11300), "$11,300");
  });

  it("refuses a provider it holds no published rate card for", () => {
    assert.throws(() => rateCardFor("Wasabi"), /No published storage rate card for Wasabi/);
  });

  it("cites a source and a read date for every rate card", () => {
    assert.match(model.STORAGE_RATES_READ, /^\d{4}-\d{2}-\d{2}$/);
    for (const card of STORAGE_RATE_CARDS) {
      assert.match(card.source, /^https:\/\//, `${card.provider} has no source URL`);
      assert.ok(card.publishedStorageRate.includes("$"), `${card.provider} has no published storage rate`);
      assert.ok(card.storagePerGbMonth > 0, `${card.provider} stores for nothing`);
    }
  });
});
