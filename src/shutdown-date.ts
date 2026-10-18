export function statedShutdownDateOf(record: { discontinued_date?: string | null }): string | null {
  const stated = record.discontinued_date;
  return typeof stated === "string" && /^\d{4}-\d{2}-\d{2}$/.test(stated) ? stated : null;
}
