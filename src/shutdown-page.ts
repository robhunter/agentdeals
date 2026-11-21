import { shutdownDates, type ShutdownDate } from "./shutdown-deadline.js";
import { isShutdownMonth, shutdownDateEnd, shutdownMonthLabel } from "./shutdown-date.js";
import type { StatedDeadline } from "./stated-deadlines.js";
import type { ChangeResolution } from "./types.js";

export interface ShutdownPageEntry extends ShutdownDate {
  service: string;
  vendorSlug: string;
  what: string;
  whoAffected?: string;
  impact?: string;
  migrationPath?: string;
  migrationLink?: string;
  statedDeadline?: StatedDeadline;
  groupedDeadlines?: readonly StatedDeadline[];
  resolution?: ChangeResolution | null;
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function dateLabel(date: string): string {
  if (isShutdownMonth(date)) return shutdownMonthLabel(date);
  return new Date(`${date}T00:00:00Z`).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" });
}

export function shutdownPageContent(entry: ShutdownPageEntry, today: string, options: {
  conditionsHtml: (deadline: StatedDeadline) => string;
  vendorPath: string | null;
}): { title: string; body: string } {
  const stages = shutdownDates(entry);
  if (entry.resolution && (entry.resolution.state === "cancelled" || entry.resolution.state === "retracted")) {
    const resolution = entry.resolution;
    const title = `${entry.service}: ${resolution.state === "cancelled" ? "shutdown called off" : "shutdown record retracted"}`;
    const source = resolution.source_url && /^https?:\/\//i.test(resolution.source_url)
      ? `<p><a href="${escapeHtml(resolution.source_url)}">Source</a></p>` : "";
    const vendor = options.vendorPath ? `<a href="${escapeHtml(options.vendorPath)}">Vendor</a> · ` : "";
    return { title, body: `<h1>${escapeHtml(title)}</h1><p>${escapeHtml(dateLabel(resolution.date))}</p>${resolution.detail ? `<p>${escapeHtml(resolution.detail)}</p>` : ""}${source}<p>${vendor}<a href="/shutdowns">Shutdown tracker</a></p>` };
  }
  const stageText = stages.map(stage => `${stage.label ? `${stage.label} on ` : ""}${dateLabel(stage.date)}`).join(", ");
  const title = `${entry.service}: ${stageText}`;
  const completed = shutdownDateEnd(stages[stages.length - 1].date) < today;
  const source = entry.dateSource && /^https?:\/\//i.test(entry.dateSource)
    ? `<p><a href="${escapeHtml(entry.dateSource)}">Source</a></p>` : "";
  const description = entry.groupedDeadlines
    ? `<ul>${entry.groupedDeadlines.map(item => `<li>${escapeHtml(item.sentence)}${item.sourceUrl && /^https?:\/\//i.test(item.sourceUrl) ? ` <a href="${escapeHtml(item.sourceUrl)}">Source</a>` : ""}${options.conditionsHtml(item)}</li>`).join("")}</ul>`
    : `<p>${escapeHtml(entry.what)}</p>${entry.statedDeadline ? options.conditionsHtml(entry.statedDeadline) : ""}`;
  const details = ([["Who’s affected", entry.whoAffected], ["Impact", entry.impact], ["Migration path", entry.migrationPath]] as const)
    .filter(([, value]) => value !== undefined)
    .map(([label, value]) => `<p><strong>${label}:</strong> ${escapeHtml(value!)}</p>`).join("");
  const migration = entry.migrationLink && /^\/(?!\/)/.test(entry.migrationLink)
    ? `<p><a href="${escapeHtml(entry.migrationLink)}">Migration guide</a></p>` : "";
  const vendor = options.vendorPath ? `<a href="${escapeHtml(options.vendorPath)}">Vendor</a> · ` : "";
  const body = `<h1>${escapeHtml(title)}</h1><p>${completed ? "Completed" : "Upcoming"}</p>${description}<ul>${stages.map(stage => `<li>${escapeHtml(stage.label ? `${stage.label}: ${dateLabel(stage.date)}` : dateLabel(stage.date))}${shutdownDateEnd(stage.date) < today ? " — Completed" : ""}</li>`).join("")}</ul>${source}${details}${migration}<p>${vendor}<a href="/shutdowns">Shutdown tracker</a></p>`;
  return { title, body };
}
