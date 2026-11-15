import TurndownService from "turndown";
import { createDocument } from "@mixmark-io/domino";

type UpcomingEntry = { date: string };
export const UPCOMING_TIMELINE_END = '<template id="upcoming-timeline-end"></template>';

export function renderUpcomingTimeline(entries: readonly UpcomingEntry[], render: (count: number, overflowHtml: string, indexAfterUpcoming: boolean) => string, servedHtml: (page: string) => string = page => page): string {
  if (entries.length === 0) return render(0, "", false);
  let indexAfterUpcoming = false;
  const converter = new TurndownService();
  const dateFormat = new Intl.DateTimeFormat("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" });
  const candidate = (count: number) => {
    const date = count < entries.length ? dateFormat.format(new Date(entries[count].date + "T00:00:00Z")) : "";
    const overflow = count < entries.length
      ? `<p class="upcoming-overflow">${entries.length - count} more scheduled changes from ${date} are listed on <a href="/deadlines">/deadlines</a>.</p>`
      : "";
    const raw = render(count, overflow, indexAfterUpcoming);
    const page = raw.replace(UPCOMING_TIMELINE_END, "");
    const served = servedHtml(raw);
    const boundary = served.indexOf(UPCOMING_TIMELINE_END);
    const document = createDocument(boundary < 0 ? served : served.slice(0, boundary));
    for (const node of document.querySelectorAll("head, script, style")) node.parentNode!.removeChild(node);
    const section = document.querySelector<HTMLElement>(".upcoming-section")!;
    for (let node: Node = section; node !== document.body; node = node.parentNode!) {
      while (node.nextSibling) node.parentNode!.removeChild(node.nextSibling);
    }
    return { page, fits: converter.turndown(document.body).length <= 95_000 };
  };
  let best = candidate(0);
  if (!best.fits) { indexAfterUpcoming = true; best = candidate(0); }
  if (!best.fits) throw new RangeError("Content before Upcoming Changes exceeds the reading budget");
  let low = 0;
  let high = Math.min(entries.length, 32);
  while (true) {
    const next = candidate(high);
    if (!next.fits) break;
    low = high;
    best = next;
    if (low === entries.length) return best.page;
    high = Math.min(entries.length, high * 2);
  }
  while (low + 1 < high) {
    const middle = Math.floor((low + high) / 2);
    const next = candidate(middle);
    if (next.fits) { low = middle; best = next; }
    else high = middle;
  }
  return best.page;
}
