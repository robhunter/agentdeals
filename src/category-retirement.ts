import type { CategoryRetirement } from "./category-scope.js";

export const RETIRED_CATEGORY_BADGE = "Retired category";

export const RETIRED_CATEGORY_ONWARD_PATH = "/category";

export function retiredCategoryTitle(name: string): string {
  return `${name} — retired category — AgentDeals`;
}

export function retiredCategoryDescription(name: string): string {
  return `${name} is a category AgentDeals no longer lists. Nothing is filed under this name, and the page stays here to say so rather than answer with a 404.`;
}

export function retiredCategoryHeadline(name: string): string {
  return `${name} is no longer listed`;
}

export function retiredCategoryStatedOn(retirement: CategoryRetirement): string {
  return `Retired on ${retirement.retired}.`;
}

export function retiredCategoryNoticeHtml(
  name: string,
  retirement: CategoryRetirement,
  escape: (value: string) => string,
): string {
  return `<div class="retired-category">
    <p class="retired-category-badge">${RETIRED_CATEGORY_BADGE}</p>
    <h2 class="retired-category-headline">${escape(retiredCategoryHeadline(name))}</h2>
    <p class="retired-category-date">${escape(retiredCategoryStatedOn(retirement))}</p>
    <p class="retired-category-reason">${escape(retirement.reason)}</p>
    <p class="retired-category-onward"><a href="${RETIRED_CATEGORY_ONWARD_PATH}">Browse the categories we do list</a>.</p>
  </div>`;
}
