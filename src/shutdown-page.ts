import { shutdownDates, type ShutdownDate } from "./shutdown-deadline.js";
import { isShutdownMonth, shutdownDateEnd, shutdownMonthLabel } from "./shutdown-date.js";

export interface ShutdownPageEntry extends ShutdownDate {
  service: string;
  vendorSlug: string;
  what: string;
  whoAffected?: string;
  impact?: string;
  migrationPath?: string;
  migrationLink?: string;
  groupedDeadlines?: readonly { sentence: string; sourceUrl?: string | null }[];
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function dateLabel(date: string): string {
  if (isShutdownMonth(date)) return shutdownMonthLabel(date);
  return new Date(`${date}T00:00:00Z`).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" });
}

export function shutdownPageContent(entry: ShutdownPageEntry, today: string): { title: string; body: string } {
  const stages = shutdownDates(entry);
  const stageText = stages.map(stage => `${stage.label ? `${stage.label} on ` : ""}${dateLabel(stage.date)}`).join(", ");
  const title = `${entry.service}: ${stageText}`;
  const completed = shutdownDateEnd(stages[stages.length - 1].date) < today;
  const source = entry.dateSource && /^https?:\/\//i.test(entry.dateSource)
    ? `<p><a href="${escapeHtml(entry.dateSource)}">Source</a></p>` : "";
  const description = entry.groupedDeadlines
    ? `<ul>${entry.groupedDeadlines.map(item => `<li>${escapeHtml(item.sentence)}${item.sourceUrl && /^https?:\/\//i.test(item.sourceUrl) ? ` <a href="${escapeHtml(item.sourceUrl)}">Source</a>` : ""}</li>`).join("")}</ul>`
    : `<p>${escapeHtml(entry.what)}</p>`;
  const details = ([["Who’s affected", entry.whoAffected], ["Impact", entry.impact], ["Migration path", entry.migrationPath]] as const)
    .filter(([, value]) => value !== undefined)
    .map(([label, value]) => `<p><strong>${label}:</strong> ${escapeHtml(value!)}</p>`).join("");
  const migration = entry.migrationLink && /^\/(?!\/)/.test(entry.migrationLink)
    ? `<p><a href="${escapeHtml(entry.migrationLink)}">Migration guide</a></p>` : "";
  const body = `<h1>${escapeHtml(title)}</h1><p>${completed ? "Completed" : "Upcoming"}</p>${description}<ul>${stages.map(stage => `<li>${escapeHtml(stage.label ? `${stage.label}: ${dateLabel(stage.date)}` : dateLabel(stage.date))}</li>`).join("")}</ul>${source}${details}${migration}<p><a href="/vendor/${encodeURIComponent(entry.vendorSlug)}">Vendor</a> · <a href="/shutdowns">Shutdown tracker</a></p>`;
  return { title, body };
}
