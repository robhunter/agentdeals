export function statedShutdownDateOf(record: { discontinued_date?: string | null }): string | null {
  const stated = record.discontinued_date;
  return typeof stated === "string" && /^\d{4}-\d{2}-\d{2}$/.test(stated) ? stated : null;
}

export function isShutdownMonth(date: string): boolean {
  return /^\d{4}-(?:0[1-9]|1[0-2])$/.test(date);
}

export function statedShutdownMonthOf(record: { discontinued_date?: string | null }): string | null {
  const stated = record.discontinued_date;
  return typeof stated === "string" && isShutdownMonth(stated) ? stated : null;
}

export function shutdownDateStart(date: string): string {
  return isShutdownMonth(date) ? `${date}-01` : date;
}

export function shutdownDateEnd(date: string): string {
  if (!isShutdownMonth(date)) return date;
  const end = new Date(`${date}-01T00:00:00Z`);
  end.setUTCMonth(end.getUTCMonth() + 1);
  end.setUTCDate(0);
  return end.toISOString().slice(0, 10);
}

export function shutdownMonthLabel(date: string): string {
  return new Date(`${date}-01T00:00:00Z`).toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
}

export function shutdownMonthDateLabel(date: string): string {
  return `${shutdownMonthLabel(date)} (no day is given)`;
}
