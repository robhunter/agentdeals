import type { Offer, ProductRole, ProductSubtypes } from "./types.js";

export type RoleCarrier = { product_role?: ProductRole; product_subtypes?: ProductSubtypes; category?: string };

export type MembershipGate = "local_dev_only" | "addon" | "not_yet_classified" | "not_in_taxonomy" | "subtype_mismatch";

export const MEMBERSHIP_GATE_ORDER: MembershipGate[] = ["local_dev_only", "addon", "not_yet_classified", "not_in_taxonomy", "subtype_mismatch"];

export const MEMBERSHIP_GATE_RULES: Record<MembershipGate, { label: string; rule: string }> = {
  local_dev_only: {
    label: "Runs only on a developer machine",
    rule: "The product is a local stand-in for a service you would otherwise run in production. It is not an alternative to the hosted service it stands in for.",
  },
  addon: {
    label: "Extends another product",
    rule: "The product adds a capability to another product rather than replacing it. It is not an alternative to the thing it augments.",
  },
  not_yet_classified: {
    label: "We have not classified this record",
    rule: "The offer is listed in a category whose subtypes we publish, and we have not yet read it against them. We therefore hold no basis for offering it as an alternative to anything here. This states what we have not done rather than a finding about the product, and it stops applying the day we classify the record.",
  },
  not_in_taxonomy: {
    label: "None of this category's subtypes apply",
    rule: "The offer is listed in the category, but it is not one of the kinds of product the category's subtypes describe, so it is not an alternative to any of them.",
  },
  subtype_mismatch: {
    label: "Shares no subtype with this product",
    rule: "Two offers in a category are alternatives when their subtype sets share at least one member, or when both carry a subtype from one of the category's membership groups. This offer does neither with the vendor the list is about.",
  },
};

export const SUBTYPE_TAXONOMIES: Record<string, Array<{ subtype: string; definition: string }>> = {
  Databases: [
    { subtype: "relational", definition: "tables, rows and joins under SQL — Postgres, MySQL, SQLite family" },
    { subtype: "document", definition: "schemaless JSON/BSON documents as the stored unit" },
    { subtype: "vector", definition: "stores embeddings and answers similarity queries as its primary access path" },
    { subtype: "kv_cache", definition: "key to value, no query language over the value" },
    { subtype: "graph", definition: "nodes and edges are the primary model, with a traversal query language" },
    { subtype: "timeseries", definition: "rows are time-indexed measurements, retention is a first-class setting" },
    { subtype: "analytical", definition: "columnar warehouse for aggregate scans, not row-level transactions" },
    { subtype: "backend_platform", definition: "bundles a database with auth, functions or storage as one product" },
  ],
  "Cloud Hosting": [
    { subtype: "static_site", definition: "serves prebuilt files from a CDN; there is no server process you control" },
    { subtype: "serverless_function", definition: "your code runs per request with no long-lived instance, billed by invocation or CPU time" },
    { subtype: "container_app", definition: "you deploy an app or image and the platform keeps a process running for it" },
    { subtype: "shared_web_hosting", definition: "a directory on a managed server, reached by FTP or SSH, with a bundled MySQL or Postgres" },
    { subtype: "managed_cms_hosting", definition: "hosting specialised to one CMS or documentation framework, provisioned and updated by the host" },
    { subtype: "site_builder", definition: "you author the site in the vendor's own editor and it is served from there" },
    { subtype: "backend_as_a_service", definition: "an API bundling a datastore with auth, push or realtime; there is no server you deploy" },
    { subtype: "agent_sandbox", definition: "isolated execution environments provisioned programmatically, sold for AI agent workloads" },
  ],
  Monitoring: [
    { subtype: "uptime_check", definition: "polls a URL or host from outside your infrastructure on a fixed interval and alerts when it stops answering; it runs no code of yours" },
    { subtype: "synthetic_check", definition: "runs a check you author — a scripted browser session, a multi-step API call, or an assertion on a response body — on a schedule from outside your infrastructure, and reports whether the behaviour it asserts still holds" },
    { subtype: "host_metrics", definition: "an agent you install on a machine reports CPU, memory, disk and process state for that machine" },
    { subtype: "apm_traces", definition: "instruments application code and reports per-request latency, throughput and spans across services" },
    { subtype: "log_management", definition: "ingests, stores and queries log lines; the line is the stored unit and retention is a priced dimension" },
    { subtype: "metrics_backend", definition: "stores time-indexed measurements and serves queries over them; dashboards and alerting are built on top rather than sold as the product" },
    { subtype: "dashboards", definition: "renders charts, dashboards and alert rules over telemetry held in stores it does not own; what is sold is the view, not the store" },
    { subtype: "error_tracking", definition: "captures unhandled exceptions with stack traces and groups repeat occurrences into one issue" },
    { subtype: "cron_monitor", definition: "waits for a scheduled job to check in and alerts on the absence of the check-in rather than on a failure it observed" },
    { subtype: "status_page", definition: "publishes a page your own users read to see whether your service is up" },
    { subtype: "upstream_status_watch", definition: "watches status pages or endpoints belonging to third parties you depend on, and reports to you rather than to your users" },
    { subtype: "on_call_response", definition: "routes a firing alert to a named human by schedule and escalation policy" },
    { subtype: "page_change_watch", definition: "fetches a web page on a schedule and notifies you when its content differs from last time" },
  ],
  "AI / ML": [
    { subtype: "llm_api", definition: "the vendor runs language or multimodal models on its own infrastructure and sells calls to them by model name; you send a prompt and receive a completion" },
    { subtype: "llm_observability", definition: "records the prompts, responses, latency, cost and tool calls an application sent to a model, for reading afterwards" },
    { subtype: "llm_evaluation", definition: "scores model or agent output against a dataset, a rubric or a judge model on runs you trigger" },
    { subtype: "model_gateway", definition: "one endpoint that reaches models run by several independent providers; what is sold is the routing, key management and fallback, not the weights" },
    { subtype: "model_hosting", definition: "you supply or select a model and the platform serves it behind an endpoint on hardware you choose" },
    { subtype: "embeddings_api", definition: "returns a vector for text or media so it can be compared to other vectors; the vector is the output, not a completion" },
    { subtype: "gpu_compute", definition: "sells accelerator time for code you write; the unit billed is machine time, not a model call" },
    { subtype: "speech_api", definition: "converts recorded or streamed speech to text, or text to speech" },
    { subtype: "document_extraction", definition: "turns a document or a scan into text or structured fields" },
    { subtype: "image_video_generation", definition: "produces images or video from a prompt or a source image" },
    { subtype: "vector_store", definition: "stores embeddings and answers nearest-neighbour queries as its primary access path" },
    { subtype: "data_labeling", definition: "produces labelled or annotated training data" },
    { subtype: "experiment_tracking", definition: "records training or evaluation runs, their metrics and artifacts, and keeps a registry of model versions" },
    { subtype: "web_search_api", definition: "answers a query with current web results shaped for a model to read" },
    { subtype: "agent_sandbox", definition: "isolated execution environments provisioned programmatically for code an agent writes" },
    { subtype: "agent_tool_access", definition: "supplies an agent with authenticated connections to third-party applications it can call as tools" },
  ],
};

export interface SubtypeMembershipGroup {
  subtypes: string[];
  rule: string;
}

export const SUBTYPE_MEMBERSHIP_GROUPS: Record<string, SubtypeMembershipGroup[]> = {
  "Cloud Hosting": [
    {
      subtypes: ["static_site", "serverless_function", "container_app"],
      rule: "These three describe how your code is executed, not what can replace what. A reader leaving one of them is asking where else they can deploy the thing they have, and all three answer that question, so two offers that each carry one are alternatives whether or not they carry the same one. Every other subtype in this category keeps the shared-member rule unchanged.",
    },
  ],
  Monitoring: [
    {
      subtypes: ["host_metrics", "apm_traces", "log_management", "metrics_backend", "dashboards"],
      rule: "A reader leaving one of these is asking where else to send telemetry, what will store it and what will show it, and all five answer some part of that, so two offers that each carry one are alternatives whether or not they carry the same one. error_tracking sits outside this group deliberately: a reader leaving Sentry wants exception grouping, and every platform that also offers it carries the error_tracking label itself. Every other subtype in this category keeps the shared-member rule unchanged.",
    },
  ],
  "AI / ML": [
    {
      subtypes: ["llm_api", "model_gateway"],
      rule: "A reader leaving one of these is asking where else to send a prompt and get a completion back. Whether the vendor runs the weights itself or routes the call to a provider that does is a procurement question, not a different product, so two offers that each carry one are alternatives whether or not they carry the same one. Every other subtype in this category keeps the shared-member rule unchanged.",
    },
  ],
};

export const SUBTYPE_MEMBERSHIP_RULE =
  "Two offers in the same category are alternatives when their subtype sets share at least one member, or when both carry a subtype from one of the membership groups below. A record we have not classified is offered no substitutes, and is offered as one only where a person wrote the pair down by name. It stays listed in its category, in search, and on best-of pages.";

export const SUBTYPE_MEMBERSHIP_GROUP_SCOPE =
  "A group answers whether a product could substitute at all. Which one is the better answer is ordering, and ordering is a separate, seeded, published concern that reads none of this.";

export function membershipGroupsFor(taxonomy: string): SubtypeMembershipGroup[] {
  return SUBTYPE_MEMBERSHIP_GROUPS[taxonomy] ?? [];
}

function sharesMembershipGroup(taxonomy: string, candidate: Set<string>, subject: Set<string>): boolean {
  for (const group of membershipGroupsFor(taxonomy)) {
    const members = new Set(group.subtypes);
    const candidateIn = [...candidate].some(s => members.has(s));
    const subjectIn = [...subject].some(s => members.has(s));
    if (candidateIn && subjectIn) return true;
  }
  return false;
}

export function subtypeDefinition(taxonomy: string, subtype: string): string | null {
  return SUBTYPE_TAXONOMIES[taxonomy]?.find(t => t.subtype === subtype)?.definition ?? null;
}

export interface SubtypeProfile {
  taxonomy: string;
  subtypes: Set<string>;
}

export function subtypesOf(offer: RoleCarrier): SubtypeProfile | null {
  const classified = offer.product_subtypes;
  if (!classified) return null;
  return { taxonomy: classified.taxonomy, subtypes: new Set(classified.labels.map(l => l.subtype)) };
}

export function subtypesAcross(subjects: RoleCarrier[]): SubtypeProfile[] {
  const byTaxonomy = new Map<string, Set<string>>();
  for (const subject of subjects) {
    const own = subtypesOf(subject);
    if (!own) continue;
    if (!byTaxonomy.has(own.taxonomy)) byTaxonomy.set(own.taxonomy, new Set());
    for (const subtype of own.subtypes) byTaxonomy.get(own.taxonomy)!.add(subtype);
  }
  return [...byTaxonomy.entries()].map(([taxonomy, subtypes]) => ({ taxonomy, subtypes }));
}

function classifiedSubjectProfile(taxonomy: string | undefined, subjectProfiles: SubtypeProfile[]): SubtypeProfile | null {
  if (!taxonomy) return null;
  const shared = subjectProfiles.find(p => p.taxonomy === taxonomy);
  return shared && shared.subtypes.size > 0 ? shared : null;
}

function subtypeGate(candidate: RoleCarrier, subjectProfiles: SubtypeProfile[]): MembershipGate | null {
  const own = subtypesOf(candidate);
  if (!own) return classifiedSubjectProfile(candidate.category, subjectProfiles) ? "not_yet_classified" : null;
  const shared = classifiedSubjectProfile(own.taxonomy, subjectProfiles);
  if (!shared) return null;
  for (const subtype of own.subtypes) {
    if (shared.subtypes.has(subtype)) return null;
  }
  if (own.subtypes.size === 0) return "not_in_taxonomy";
  if (sharesMembershipGroup(own.taxonomy, own.subtypes, shared.subtypes)) return null;
  return "subtype_mismatch";
}

export const MEMBERSHIP_GATE_SYMMETRY =
  "A gate removes an offer from an alternatives list only when the vendor the list is about does not carry the same gate. One local emulator is still an alternative to another; one add-on is still an alternative to another.";

export const MEMBERSHIP_GATE_SCOPE =
  "These gates decide membership of alternatives, related-vendor, risk and role-recommendation lists. They are not scores, they never change the order of anything, and they never filter a category page, a best-of page or a search result — those are inventory, and the caller asked for the category.";

export const MEMBERSHIP_GATE_CORRECTIONS =
  "Every gated offer publishes the URL on the vendor's own site that the classification was read from, and the sentence it was read from. A vendor who believes we have read it wrong can point at the same page.";

export function membershipGatesFor(offer: RoleCarrier): Set<MembershipGate> {
  const gates = new Set<MembershipGate>();
  const role = offer.product_role;
  if (!role) return gates;
  if (role.deployment_model === "local_dev_only") gates.add("local_dev_only");
  if (role.is_addon) gates.add("addon");
  return gates;
}

function gateAgainst(candidate: RoleCarrier, subjectGates: Set<MembershipGate>, subjectProfiles: SubtypeProfile[]): MembershipGate | null {
  const candidateGates = membershipGatesFor(candidate);
  const fromSubtypes = subtypeGate(candidate, subjectProfiles);
  if (fromSubtypes) candidateGates.add(fromSubtypes);
  for (const gate of MEMBERSHIP_GATE_ORDER) {
    if (candidateGates.has(gate) && !subjectGates.has(gate)) return gate;
  }
  return null;
}

export function alternativeMembershipGate(candidate: RoleCarrier, subject: RoleCarrier): MembershipGate | null {
  return gateAgainst(candidate, membershipGatesFor(subject), subtypesAcross([subject]));
}

export function membershipGatesAcross(subjects: RoleCarrier[]): Set<MembershipGate> {
  const union = new Set<MembershipGate>();
  for (const subject of subjects) {
    for (const gate of membershipGatesFor(subject)) union.add(gate);
  }
  return union;
}

export function roleMembershipGate(candidate: RoleCarrier): MembershipGate | null {
  const gates = membershipGatesFor(candidate);
  for (const gate of MEMBERSHIP_GATE_ORDER) {
    if (gates.has(gate)) return gate;
  }
  return null;
}

export interface AlternativesPartition<T extends RoleCarrier> {
  kept: T[];
  removed: Array<{ offer: T; gate: MembershipGate }>;
}

export interface MembershipOptions<T extends RoleCarrier = RoleCarrier> {
  applySubtypes?: boolean;
  subtypeExempt?: (candidate: T) => boolean;
}

export const CURATED_SUBTYPE_EXEMPTION =
  "A curated alternative is a pair a person wrote down for this vendor by name. That is a stronger claim than a subtype match, so subtypes never remove one; the product-role gates still do, because a local emulator does not replace a hosted service whoever names it.";

export function partitionAlternativesAcross<T extends RoleCarrier>(candidates: T[], subjects: RoleCarrier[], options: MembershipOptions<T> = {}): AlternativesPartition<T> {
  const subjectGates = membershipGatesAcross(subjects);
  const subjectProfiles = options.applySubtypes === false ? [] : subtypesAcross(subjects);
  const kept: T[] = [];
  const removed: Array<{ offer: T; gate: MembershipGate }> = [];
  for (const candidate of candidates) {
    const profiles = options.subtypeExempt?.(candidate) ? [] : subjectProfiles;
    const gate = gateAgainst(candidate, subjectGates, profiles);
    if (gate) removed.push({ offer: candidate, gate });
    else kept.push(candidate);
  }
  return { kept, removed };
}

export function partitionAlternatives<T extends RoleCarrier>(candidates: T[], subject: RoleCarrier): AlternativesPartition<T> {
  return partitionAlternativesAcross(candidates, [subject]);
}

export interface SubstitutesPartition<T extends RoleCarrier> extends AlternativesPartition<T> {
  unclassified: T[];
}

export function classifiedTaxonomies(subjects: RoleCarrier[]): Set<string> {
  return new Set(subtypesAcross(subjects).filter(p => p.subtypes.size > 0).map(p => p.taxonomy));
}

export function subtypeGateBinds(subjects: RoleCarrier[], category: string): boolean {
  return classifiedTaxonomies(subjects).has(category);
}

export function partitionSubstitutes<T extends RoleCarrier & { category: string }>(
  candidates: T[],
  subjects: RoleCarrier[],
  options: MembershipOptions<T> = {},
): SubstitutesPartition<T> {
  const binds = classifiedTaxonomies(subjects);
  const admissible: T[] = [];
  const unclassified: T[] = [];
  for (const candidate of candidates) {
    if (options.subtypeExempt?.(candidate) || binds.has(candidate.category)) admissible.push(candidate);
    else unclassified.push(candidate);
  }
  const partition = partitionAlternativesAcross(admissible, subjects, options);
  return { kept: partition.kept, removed: partition.removed, unclassified };
}

export type SubstituteCandidate = RoleCarrier & { vendor: string; category: string };

export function substitutesFor<T extends SubstituteCandidate>(all: T[], subject: SubstituteCandidate): T[] {
  return partitionSubstitutes(all.filter(o => o.category === subject.category && o.vendor !== subject.vendor), [subject]).kept;
}

export function filterAlternatives<T extends RoleCarrier>(candidates: T[], subject: RoleCarrier): T[] {
  return partitionAlternatives(candidates, subject).kept;
}

export function partitionRoleCandidates<T extends RoleCarrier>(candidates: T[]): AlternativesPartition<T> {
  const kept: T[] = [];
  const removed: Array<{ offer: T; gate: MembershipGate }> = [];
  for (const candidate of candidates) {
    const gate = roleMembershipGate(candidate);
    if (gate) removed.push({ offer: candidate, gate });
    else kept.push(candidate);
  }
  return { kept, removed };
}

export function deploymentModelLabel(role: ProductRole): string {
  if (role.deployment_model === "local_dev_only") return "Runs only on a developer machine";
  if (role.deployment_model === "self_hosted") return "Self-hosted";
  return "Hosted service";
}

export function productRoleSentence(offer: Offer): string | null {
  const role = offer.product_role;
  if (!role) return null;
  const parts = [deploymentModelLabel(role)];
  if (role.is_addon) {
    parts.push(role.augments ? `extends ${role.augments} rather than replacing one` : "extends another product rather than replacing it");
  }
  const gated = membershipGatesFor(offer).size > 0;
  const consequence = gated
    ? `${offer.vendor} is listed in ${offer.category} and searchable there, and is left out of alternatives lists for vendors it cannot stand in for.`
    : `${offer.vendor} is listed everywhere a ${offer.category} offer is listed.`;
  return `${parts.join(", ")}. ${consequence}`;
}
