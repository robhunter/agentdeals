export interface Offer {
  vendor: string;
  category: string;
  description: string;
  tier: string;
  url: string;
  tags: string[];
  verifiedDate: string;
}

export interface OfferIndex {
  offers: Offer[];
}
