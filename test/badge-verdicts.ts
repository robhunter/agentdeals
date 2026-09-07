export type SiteFreeTierVerdict = "offered" | "ended" | "unconfirmed";

const VERDICT_BY_BADGE_STATUS: Record<string, SiteFreeTierVerdict> = {
  "active": "offered",
  "at-risk": "offered",
  "stale": "offered",
  "removed": "ended",
  "retired": "ended",
  "withheld": "unconfirmed",
  "unknown": "unconfirmed",
};

export function verdictForBadgeStatus(status: string): SiteFreeTierVerdict | null {
  return VERDICT_BY_BADGE_STATUS[status] ?? null;
}

export function badgeVerdictsFromBadgesPage(html: string): Map<string, SiteFreeTierVerdict> {
  const verdicts = new Map<string, SiteFreeTierVerdict>();
  for (const m of html.matchAll(/<a href="\/vendor\/([a-z0-9-]+)" class="vendor-badge-link" title="[^"]*? — ([a-z-]+)"/g)) {
    const verdict = verdictForBadgeStatus(m[2]);
    if (verdict) verdicts.set(m[1], verdict);
  }
  return verdicts;
}

export function badgeLinksOnBadgesPage(html: string): string[] {
  return [...html.matchAll(/<a href="\/vendor\/([a-z0-9-]+)" class="vendor-badge-link"/g)].map(m => m[1]!);
}

export function badgesWithNoVerdict(html: string): string[] {
  const verdicts = badgeVerdictsFromBadgesPage(html);
  return badgeLinksOnBadgesPage(html).filter(slug => !verdicts.has(slug));
}

export async function fetchBadgesPage(port: number): Promise<string> {
  return await (await fetch(`http://localhost:${port}/badges`)).text();
}

export async function fetchBadgeVerdicts(port: number): Promise<Map<string, SiteFreeTierVerdict>> {
  return badgeVerdictsFromBadgesPage(await fetchBadgesPage(port));
}
