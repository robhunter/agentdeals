import {
  SOURCE_CHECK_NOT_NAMED,
  SOURCE_CHECK_NOT_THE_PRODUCT,
  SOURCE_CHECK_NO_TERMS,
} from "./vendor-naming.js";

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export const OUTCOMES_A_READING_ANSWERED_WITH_NOTHING = [
  SOURCE_CHECK_NOT_NAMED,
  SOURCE_CHECK_NOT_THE_PRODUCT,
  SOURCE_CHECK_NO_TERMS,
];

const ANSWERED_WITH_NOTHING = new Set(OUTCOMES_A_READING_ANSWERED_WITH_NOTHING);

export function readAnsweredWithNothing(offer) {
  return ANSWERED_WITH_NOTHING.has(offer?.source_check?.outcome);
}

export function oneTurnOfTheQueue(queueLength, limit) {
  if (!Number.isFinite(limit) || limit <= 0) return 0;
  return Math.ceil(Math.max(0, queueLength) / limit);
}

export function deferralMs(turnDays) {
  return Math.max(0, turnDays) * MS_PER_DAY;
}

export function queueOrderRule(turnDays) {
  return (
    "A record whose last reading reached the page and found nothing it could price is drawn one full turn "
    + `of the queue later than its age alone would place it — ${turnDays} day${turnDays === 1 ? "" : "s"} at this `
    + "run's limit. A reading that never reached the page is not deferred: that record has not been read at all, "
    + "and it keeps the place the queue already gives it. The deferral expires by arithmetic rather than by a "
    + "rule of its own — a deferred record goes on ageing, so once it is a turn older than the records being "
    + "drawn it is drawn, and a page that starts stating terms again is reached on the next turn rather than never."
  );
}

export function queueOrderLines(turnDays, deferred, queueLength) {
  if (queueLength === undefined) return [];
  return [
    `Deferred a turn because the page answered their last reading with nothing: ${deferred} of ${queueLength}`,
    `  ${queueOrderRule(turnDays)}`,
  ];
}
