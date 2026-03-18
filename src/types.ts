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
  expires_date?: string;
}

export interface EnrichedOffer extends Offer {
  recent_change: string | null;
  expires_soon: string | null;
  risk_level: "stable" | "caution" | "risky" | null;
}

export interface OfferIndex {
  offers: Offer[];
}

export interface DealChange {
  vendor: string;
  change_type: "free_tier_removed" | "limits_reduced" | "restriction" | "limits_increased" | "new_free_tier" | "pricing_restructured" | "open_source_killed" | "pricing_model_change" | "startup_program_expanded" | "pricing_postponed" | "product_deprecated";
  date: string;
  summary: string;
  previous_state: string;
  current_state: string;
  impact: "high" | "medium" | "low";
  source_url: string;
  category: string;
  alternatives: string[];
}

export interface DealChangesIndex {
  changes: DealChange[];
}
