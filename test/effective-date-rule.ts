export interface DatedRecord {
  date: string;
  date_source?: string;
  recorded_date?: string | null;
  change_type?: string;
}

export function statesWhenItTookEffect(c: DatedRecord): boolean {
  if (c.date_source === "vendor_page") return true;
  if (c.date_source !== "hand_written") return false;
  if (c.change_type === "record_corrected") return true;
  return Boolean(c.recorded_date) && c.date !== c.recorded_date;
}
