import type { DailyRollup } from "./analytics-rollup.js";
import type { ClientClass } from "./client-class.js";
import { CLASS_ROUTE_SEP, OVERFLOW_PAGE_KEY } from "./stats.js";

export const AGENT_OPENS_WINDOW_DAYS = 14;
export const HOMEPAGE_GUIDE_COUNT = 20;

export const RANKED_TRAFFIC_CLASS: ClientClass = "ai_agent";
const AGENT_CLASS = RANKED_TRAFFIC_CLASS;

export interface GuideEntry {
  slug: string;
  title: string;
  heading: string;
}

export interface RankedGuide extends GuideEntry {
  agentOpens: number;
}

export interface AgentOpensWindow {
  days: number;
  from: string;
  to: string;
}

function mostRecentDays(rollups: readonly DailyRollup[], days: number): DailyRollup[] {
  return [...rollups].sort((a, b) => a.date.localeCompare(b.date)).slice(-days);
}

export function agentOpensWindow(
  rollups: readonly DailyRollup[],
  days = AGENT_OPENS_WINDOW_DAYS,
): AgentOpensWindow | null {
  const window = mostRecentDays(rollups, days);
  if (window.length === 0) return null;
  return { days: window.length, from: window[0].date, to: window[window.length - 1].date };
}

function agentRouteKey(path: string): string {
  return `${AGENT_CLASS}${CLASS_ROUTE_SEP}${path}`;
}

function agentOverflowOn(day: DailyRollup): number {
  return day.traffic.by_class_route[agentRouteKey(OVERFLOW_PAGE_KEY)] ?? 0;
}

export function dayMeasuresPath(day: DailyRollup, path: string): boolean {
  if (agentRouteKey(path) in day.traffic.by_class_route) return true;
  if (agentOverflowOn(day) === 0) return true;
  return day.traffic.class_route_truncation?.reserved_paths.includes(path) === true;
}

export function rankableDays(
  rollups: readonly DailyRollup[],
  guides: readonly GuideEntry[],
  days = AGENT_OPENS_WINDOW_DAYS,
): DailyRollup[] {
  return mostRecentDays(rollups, days).filter((day) => {
    if (agentOverflowOn(day) === 0) return true;
    const reserved = new Set(day.traffic.class_route_truncation?.reserved_paths ?? []);
    return guides.every((guide) => {
      const path = `/${guide.slug}`;
      return reserved.has(path) || agentRouteKey(path) in day.traffic.by_class_route;
    });
  });
}

export function agentOpensByPath(days: readonly DailyRollup[]): Map<string, number> {
  const opens = new Map<string, number>();
  for (const day of days) {
    for (const [key, count] of Object.entries(day.traffic.by_class_route)) {
      const sep = key.indexOf(CLASS_ROUTE_SEP);
      if (sep < 0) continue;
      if (key.slice(0, sep) !== AGENT_CLASS) continue;
      const path = key.slice(sep + 1);
      if (path === OVERFLOW_PAGE_KEY) continue;
      opens.set(path, (opens.get(path) ?? 0) + count);
    }
  }
  return opens;
}

export interface AgentRequestAttribution {
  attributed: number;
  unattributed: number;
  total: number;
}

export function agentRequestAttribution(days: readonly DailyRollup[]): AgentRequestAttribution {
  let attributed = 0;
  let unattributed = 0;
  for (const day of days) {
    for (const [key, count] of Object.entries(day.traffic.by_class_route)) {
      const sep = key.indexOf(CLASS_ROUTE_SEP);
      if (sep < 0) continue;
      if (key.slice(0, sep) !== AGENT_CLASS) continue;
      if (key.slice(sep + 1) === OVERFLOW_PAGE_KEY) unattributed += count;
      else attributed += count;
    }
  }
  return { attributed, unattributed, total: attributed + unattributed };
}

export function rankGuidesByAgentOpens(
  guides: readonly GuideEntry[],
  opens: Map<string, number>,
): RankedGuide[] {
  return guides
    .map((guide) => ({ ...guide, agentOpens: opens.get(`/${guide.slug}`) ?? 0 }))
    .sort((a, b) => b.agentOpens - a.agentOpens || a.slug.localeCompare(b.slug));
}

export function guidesHomepageLinks(
  guides: readonly GuideEntry[],
  opens: Map<string, number>,
  count = HOMEPAGE_GUIDE_COUNT,
): RankedGuide[] {
  return rankGuidesByAgentOpens(guides, opens).slice(0, count);
}

export function guidesGroupedByHeading(
  selected: readonly RankedGuide[],
  headingOrder: readonly string[],
): { heading: string; guides: RankedGuide[] }[] {
  return headingOrder
    .map((heading) => ({ heading, guides: selected.filter((g) => g.heading === heading) }))
    .filter((group) => group.guides.length > 0);
}

export interface GuideSelection {
  selectedCount: number;
  populationCount: number;
  heldDays: number;
  rankedWindow: AgentOpensWindow | null;
  attribution: AgentRequestAttribution;
}

function sharePhrase(part: number, whole: number): string {
  const pct = (100 * part) / whole;
  return pct > 0 && pct < 0.1 ? "under 0.1%" : `${pct.toFixed(1)}%`;
}

export function guideSelectionSentence(selection: GuideSelection): string {
  const { selectedCount, populationCount, heldDays, rankedWindow, attribution } = selection;
  if (heldDays === 0) {
    return `All ${populationCount} guides we publish, in the order /guides lists them.`;
  }
  if (!rankedWindow) {
    return `All ${populationCount} guides we publish, in the order /guides lists them, and not a ranking. `
      + `We hold ${heldDays} days of traffic and can rank on none of them: on every one, at least one guide's requests could have been folded into a shared bucket, so a zero there would not mean no agent opened it.`;
  }
  const lede = `The ${selectedCount} of ${populationCount} guides AI agents opened most across the ${rankedWindow.days} days we can attribute in full, ${rankedWindow.from} to ${rankedWindow.to}. `;
  if (attribution.unattributed === 0) {
    return lede
      + `Membership is that ranking and nothing else, so it changes when the window moves — every guide we publish stays at /guides.`;
  }
  return lede
    + `${attribution.unattributed} of ${attribution.total} agent requests in those days (${sharePhrase(attribution.unattributed, attribution.total)}) went to a shared bucket rather than a page, so this ranks what we attributed and not every request — every guide we publish stays at /guides.`;
}

export function browseSectionSentence(categories: number, offers: number): string {
  return `All ${categories} categories are links below, and each one lists its own deals. `
    + `The search box and the ${offers.toLocaleString()}-deal grid under it run in your browser, so a client that does not execute JavaScript gets the categories and not the grid.`;
}
