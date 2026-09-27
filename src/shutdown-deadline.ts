import { figureSourceLinkHtml } from "./source-citation.js";

export interface ShutdownDate {
  deadline: string;
  dateSource?: string;
}

export function countsDownTo(entry: ShutdownDate): boolean {
  return typeof entry.dateSource === "string" && /^https?:\/\//.test(entry.dateSource);
}

export function shutdownDeadlineHtml(
  entry: ShutdownDate,
  shown: { date: string; color: string; countdown: string },
  esc: (text: string) => string,
): string {
  const sourced = countsDownTo(entry);
  return `<div class="shutdown-deadline" style="color:${shown.color}">
            <span class="deadline-icon">⏰</span>
            <span>${esc(shown.date)}</span>${sourced ? figureSourceLinkHtml(entry.dateSource!, esc) : ""}
            ${sourced ? `<span class="days-badge" style="background:${shown.color}20;color:${shown.color}">${esc(shown.countdown)}</span>` : ""}
          </div>`;
}
