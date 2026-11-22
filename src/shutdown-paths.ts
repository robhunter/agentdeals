import { shutdownDates, type ShutdownDate } from "./shutdown-deadline.js";

export interface ShutdownPathEntry extends ShutdownDate {
  vendorSlug: string;
  service: string;
}

function pathPart(value: string): string {
  return value.toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

export function shutdownPath(entry: ShutdownPathEntry): string {
  const vendor = pathPart(entry.vendorSlug);
  const service = pathPart(entry.service);
  const firstDate = shutdownDates(entry)[0].date;
  if (!vendor || !service || !/^\d{4}-\d{2}(?:-\d{2})?$/.test(firstDate)) {
    throw new Error("Invalid shutdown page identity");
  }
  return `/shutdowns/${vendor}-${firstDate}-${service}`;
}

export function shutdownPaths<T extends ShutdownPathEntry>(entries: readonly T[]): Map<string, T> {
  const pages = new Map<string, T>();
  for (const entry of entries) {
    const path = shutdownPath(entry);
    if (pages.has(path)) throw new Error(`Duplicate shutdown page: ${path}`);
    pages.set(path, entry);
  }
  return pages;
}

export function groupedShutdownRedirects<T extends ShutdownPathEntry>(members: readonly T[], group: T | undefined): Map<string, string> {
  if (!group) {
    if (members.length) throw new Error("Shutdown group is missing");
    return new Map();
  }
  const target = shutdownPath(group);
  const paths = shutdownPaths(members);
  if (!paths.has(target)) throw new Error("Shutdown group is not a member");
  return new Map([...paths.keys()].filter(path => path !== target).map(path => [path, target]));
}
