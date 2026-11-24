import { readFileSync } from "node:fs";

const RealDate = Date;
const clock = () => Number(readFileSync(process.env.TEST_CLOCK_FILE, "utf8"));
class TestDate extends RealDate {
  constructor(...args) {
    if (args.length === 0) super(clock());
    else super(...args);
  }
  static now() { return clock(); }
}
globalThis.Date = TestDate;
