export const ITEM_LIST_UNORDERED = "https://schema.org/ItemListUnordered";
export const ITEM_LIST_ASCENDING = "https://schema.org/ItemListOrderAscending";
export const ITEM_LIST_DESCENDING = "https://schema.org/ItemListOrderDescending";

export type ListOrderRule =
  | "rotates-daily"
  | "as-catalogued"
  | "as-curated"
  | "sectioned"
  | "newest-first"
  | "largest-first"
  | "soonest-first"
  | "demerit-bands";

interface OrderClaim {
  itemListOrder: string;
  prose: string;
}

export const LIST_ORDER: Record<ListOrderRule, OrderClaim> = {
  "rotates-daily": {
    itemListOrder: ITEM_LIST_UNORDERED,
    prose: "in an order that rotates daily",
  },
  "as-catalogued": {
    itemListOrder: ITEM_LIST_UNORDERED,
    prose: "in the order we catalogued them, which ranks nothing",
  },
  "as-curated": {
    itemListOrder: ITEM_LIST_UNORDERED,
    prose: "in an order that ranks nothing",
  },
  sectioned: {
    itemListOrder: ITEM_LIST_UNORDERED,
    prose: "in sections, and a position in the whole list ranks nothing",
  },
  "newest-first": {
    itemListOrder: ITEM_LIST_DESCENDING,
    prose: "newest first",
  },
  "largest-first": {
    itemListOrder: ITEM_LIST_DESCENDING,
    prose: "largest first",
  },
  "soonest-first": {
    itemListOrder: ITEM_LIST_ASCENDING,
    prose: "soonest first",
  },
  "demerit-bands": {
    itemListOrder: ITEM_LIST_ASCENDING,
    prose: "with the offers carrying no recorded demerit first, then the demoted, then the gated",
  },
};

export function listOrderOf(rule: ListOrderRule): string {
  return LIST_ORDER[rule].itemListOrder;
}

export function listOrderProse(rule: ListOrderRule): string {
  return LIST_ORDER[rule].prose;
}

export function listOrderSentence(rule: ListOrderRule): string {
  return `Listed ${LIST_ORDER[rule].prose}.`;
}

export function bandedListRule(bands: number[]): ListOrderRule {
  return new Set(bands).size > 1 ? "demerit-bands" : "rotates-daily";
}

export function bandedListOrder(bands: number[]): string {
  return listOrderOf(bandedListRule(bands));
}

export function orderedClaim(itemListOrder: string): boolean {
  return itemListOrder === ITEM_LIST_ASCENDING || itemListOrder === ITEM_LIST_DESCENDING;
}

export function rulesClaiming(itemListOrder: string): ListOrderRule[] {
  return (Object.keys(LIST_ORDER) as ListOrderRule[]).filter(
    (rule) => LIST_ORDER[rule].itemListOrder === itemListOrder,
  );
}
