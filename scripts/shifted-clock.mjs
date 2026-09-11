const RealDate = Date;
const shift = Number.parseInt(process.env.AGENTDEALS_CLOCK_SHIFT_MS ?? "0", 10);

if (!Number.isFinite(shift)) {
  throw new Error(`AGENTDEALS_CLOCK_SHIFT_MS must be a whole number of milliseconds, got ${process.env.AGENTDEALS_CLOCK_SHIFT_MS}`);
}

class ShiftedDate extends RealDate {
  constructor(...args) {
    if (args.length === 0) super(RealDate.now() + shift);
    else super(...args);
  }

  static now() {
    return RealDate.now() + shift;
  }
}

globalThis.Date = ShiftedDate;
