const RealDate = Date;
const instant = Number(process.env.TEST_FIXED_INSTANT_MS);
if (!Number.isFinite(instant)) throw new Error("TEST_FIXED_INSTANT_MS must be a timestamp");
class FixedDate extends RealDate {
  constructor(...args) {
    if (args.length === 0) super(instant);
    else super(...args);
  }
  static now() { return instant; }
}
globalThis.Date = FixedDate;
