export interface Eligibility {
  type: "public" | "accelerator" | "oss" | "student" | "fintech" | "geographic" | "enterprise";
  conditions: string[];
  program?: string;
}

export interface Referral {
  code?: string;
  url: string;
  referee_value: string;
  referrer_value?: string;
  referrer_compensation?: "commission" | "credit" | "none";
  type: "dual-sided" | "referrer-only" | "referee-only";
  source: "curated" | "sovrn" | "agent-submitted";
  submitted_by?: string | null;
  terms_url?: string;
  verified_date: string;
  restrictions?: string[];
  phase1_eligible: boolean;
}

export interface ReferralProgram {
  available: boolean;
  referrer_benefit: string;
  referee_benefit: string;
  program_url: string;
  type: "self-service" | "application" | "affiliate-network" | "partner" | "closed";
  commission_type?: "one-time" | "recurring" | "credits";
  notes?: string;
}

export interface PaymentProtocol {
  protocol: string;
  chain?: string;
  settlement?: string;
  pricing_model?: string;
  example_cost?: string;
}

export type DeploymentModel = "hosted" | "self_hosted" | "local_dev_only";

export interface ProductRole {
  deployment_model: DeploymentModel;
  is_addon: boolean;
  augments?: string;
  source_url: string;
  source_quote: string;
  reviewed: string;
}

export interface SubtypeLabel {
  subtype: string;
  source_url: string;
  source_quote: string;
}

export interface ProductSubtypes {
  taxonomy: string;
  labels: SubtypeLabel[];
  reviewed: string;
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
  payment_protocols?: PaymentProtocol[];
  referral?: Referral;
  referral_program?: ReferralProgram;
  product_role?: ProductRole;
  product_subtypes?: ProductSubtypes;
  source_check?: SourceCheck;
  free_tier_is_the_product?: true;
}

export type SourceCheckOutcome =
  | "ok"
  | "states_no_amount"
  | "does_not_name_vendor"
  | "states_no_terms"
  | "unreadable";

export interface SourceCheck {
  checked: string;
  outcome: SourceCheckOutcome;
  detail: string;
  read?: "markup";
  unrendered_prices?: string[];
}

export type StabilityClass = "stable" | "watch" | "volatile" | "improving";

export type RiskLevel = "stable" | "caution" | "risky";

export type ChangeResolutionState = "reversed" | "retracted";

export interface ChangeRecordRef {
  vendor: string;
  date: string;
  change_type: string;
}

export interface ChangeResolution {
  state: ChangeResolutionState;
  date: string;
  detail?: string;
  source_url?: string;
  resolved_by?: ChangeRecordRef;
}

export interface RiskCause {
  date: string;
  date_source?: ChangeDateSource;
  change_type: string;
  summary: string;
  current_state?: string;
  resolution?: ChangeResolution | null;
}

export interface LinkUnreachable {
  last_reachable: string | null;
  checked: string;
  terminal: boolean;
}

export interface RatingWithheld {
  reason: "no_source";
  records: number;
}

export interface EnrichedOffer extends Offer {
  recent_change: string | null;
  expires_soon: string | null;
  risk_level: RiskLevel | null;
  risk_cause: RiskCause | null;
  rating_withheld: RatingWithheld | null;
  stability: StabilityClass | null;
  days_since_verified: number;
  link_unreachable: LinkUnreachable | null;
  gate: import("./ranking.js").Gate | null;
  terms_superseded: import("./superseded-description.js").SupersededTermsRecord | null;
}

export interface OfferIndex {
  offers: Offer[];
}

export type ChangeDateSource = "vendor_page" | "hand_written" | "discovered";

export interface DealChange {
  vendor: string;
  change_type: "free_tier_removed" | "limits_reduced" | "restriction" | "limits_increased" | "new_free_tier" | "new_tier" | "pricing_restructured" | "open_source_killed" | "pricing_model_change" | "startup_program_expanded" | "pricing_postponed" | "product_deprecated" | "rebranded" | "record_corrected";
  reports?: import("./change-reporting.js").ChangeReportSubject;
  date: string;
  summary: string;
  previous_state: string;
  current_state: string;
  impact: "high" | "medium" | "low";
  source_url: string;
  category: string;
  alternatives: string[];
  detected_by?: string;
  recorded_date?: string;
  date_source?: ChangeDateSource;
  resolution?: ChangeResolution | null;
}

export interface DealChangesIndex {
  changes: DealChange[];
}

export interface Agent {
  id: string;
  name: string;
  api_key_hash: string;
  vestauth_public_key_url: string | null;
  x402_address: string | null;
  trust_tier: "new" | "verified" | "trusted";
  status: "active" | "suspended";
  registered_at: string;
}
