import type { DailyRollup } from "./analytics-rollup.js";
import type { ClientClass } from "./client-class.js";
import { CLASS_ROUTE_SEP, OVERFLOW_PAGE_KEY } from "./stats.js";

export const AGENT_OPENS_WINDOW_DAYS = 14;
export const HOMEPAGE_GUIDE_COUNT = 20;

const AGENT_CLASS: ClientClass = "ai_agent";

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

export function agentOpensByPath(
  rollups: readonly DailyRollup[],
  days = AGENT_OPENS_WINDOW_DAYS,
): Map<string, number> {
  const opens = new Map<string, number>();
  for (const day of mostRecentDays(rollups, days)) {
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

export function guideSelectionSentence(
  selectedCount: number,
  populationCount: number,
  window: AgentOpensWindow | null,
): string {
  if (!window) {
    return `All ${populationCount} guides we publish, in the order /guides lists them.`;
  }
  return `The ${selectedCount} of ${populationCount} guides AI agents opened most across the ${window.days} days of traffic we hold, ${window.from} to ${window.to}. `
    + `Membership is that ranking and nothing else, so it changes when the window moves — every guide we publish stays at /guides.`;
}

export function browseSectionSentence(categories: number, offers: number): string {
  return `All ${categories} categories are links below, and each one lists its own deals. `
    + `The search box and the ${offers.toLocaleString()}-deal grid under it run in your browser, so a client that does not execute JavaScript gets the categories and not the grid.`;
}
