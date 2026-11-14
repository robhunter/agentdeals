import type { ShutdownStage } from "./types.js";
import { figureSourceLinkHtml } from "./source-citation.js";

export interface ShutdownDate {
  deadline: string;
  dateSource?: string;
  stages?: readonly ShutdownStage[];
}

export function shutdownDates(entry: ShutdownDate): readonly ShutdownStage[] {
  const stages = [...(entry.stages ?? [])].sort((a, b) => a.date.localeCompare(b.date));
  return stages.length > 0 && stages.at(-1)!.date === entry.deadline
    ? stages
    : [{ date: entry.deadline, label: "" }];
}

export function nextShutdownDate(entry: ShutdownDate, today: string): string {
  return shutdownDates(entry).find(stage => stage.date >= today)?.date ?? entry.deadline;
}

export function countsDownTo(entry: ShutdownDate): boolean {
  return typeof entry.dateSource === "string" && /^https?:\/\//.test(entry.dateSource);
}

export function shutdownDeadlineHtml(
  entry: ShutdownDate,
  shown: { date: string; color: string; countdown?: string; label?: string },
  esc: (text: string) => string,
  sourceLinkHtml: typeof figureSourceLinkHtml = figureSourceLinkHtml,
): string {
  const sourced = countsDownTo(entry);
  return `<div class="shutdown-deadline" style="color:${shown.color}">
            <span class="deadline-icon">⏰</span>
            <span>${esc(shown.date)}</span>${shown.label ? `<span class="shutdown-stage-label">: ${esc(shown.label)}</span>` : ""}${sourced ? sourceLinkHtml(entry.dateSource!, esc) : ""}
            ${sourced && shown.countdown ? `<span class="days-badge" style="background:${shown.color}20;color:${shown.color}">${esc(shown.countdown)}</span>` : ""}
          </div>`;
}
