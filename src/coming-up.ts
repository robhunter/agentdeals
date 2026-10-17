export const COMING_UP_DAYS = 30;

export const COMING_UP_HEADING = `Coming up (next ${COMING_UP_DAYS} days)`;

const A_DAY_IN_MS = 86400000;

export function lastDayComingUp(today: string): string {
  return new Date(Date.parse(`${today}T00:00:00Z`) + COMING_UP_DAYS * A_DAY_IN_MS).toISOString().slice(0, 10);
}
