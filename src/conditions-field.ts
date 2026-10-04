import type { ListingCondition, Offer } from "./types.js";

export function conditionsField(offer: Pick<Offer, "conditions">): { conditions?: ListingCondition[] } {
  return offer.conditions === undefined ? {} : { conditions: offer.conditions };
}
