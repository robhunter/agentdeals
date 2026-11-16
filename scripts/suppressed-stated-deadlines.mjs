import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { changesTheVendorMade, dealChangesAsPublished } from "../dist/data.js";
import { recordsStillInForce } from "../dist/change-resolution.js";
import { statedShutdownMonthOf } from "../dist/shutdown-date.js";
import { deadlineTextsOf, sameDayDeadlineSuppressions } from "../dist/stated-deadlines.js";

const { values } = parseArgs({ options: {
  today: { type: "string", default: new Date().toISOString().slice(0, 10) },
  index: { type: "string", default: fileURLToPath(new URL("../data/index.json", import.meta.url)) },
  changes: { type: "string", default: fileURLToPath(new URL("../data/deal_changes.json", import.meta.url)) },
} });
const today = values.today;
if (!/^\d{4}-\d{2}-\d{2}$/.test(today) || !Number.isFinite(Date.parse(today)) || new Date(today).toISOString().slice(0, 10) !== today) {
  throw new Error("Expected --today YYYY-MM-DD with a valid calendar date");
}
const offers = JSON.parse(readFileSync(values.index, "utf8")).offers;
const changes = dealChangesAsPublished(JSON.parse(readFileSync(values.changes, "utf8")).changes,
  new Set(offers.map(offer => offer.vendor.trim().toLowerCase())));
const listed = changesTheVendorMade(changes)
  .filter(record => record.date > today)
  .filter(record => record.change_type !== "product_deprecated" || statedShutdownMonthOf(record) === null);
const past = changesTheVendorMade(recordsStillInForce(changes)).filter(record => record.date <= today);
const suppressions = sameDayDeadlineSuppressions(deadlineTextsOf(offers, past), listed, today)
  .map(({ deadline, records }) => ({
    vendor: deadline.vendor, category: deadline.category, date: deadline.date,
    sentence: deadline.sentence, source_url: deadline.sourceUrl, stated_in: deadline.statedIn,
    record_date: deadline.record?.date ?? null, suppressing_records: records,
  }));
console.log(JSON.stringify({ today, count: suppressions.length, suppressions }, null, 2));
