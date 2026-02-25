export interface Eligibility {
  type: "public" | "accelerator" | "oss" | "student" | "fintech" | "geographic" | "enterprise";
  conditions: string[];
  program?: string;
}

export interface Offer {
  vendor: string;
  category: string;
  description: string;
  tier: string;
  url: string;
  tags: string[];
  verifiedDate: string;
  eligibility?: Eligibility;
}

export interface OfferIndex {
  offers: Offer[];
}
