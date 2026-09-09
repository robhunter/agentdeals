import { SUBTYPE_TAXONOMIES, subtypeDefinition, canonicalEntryFor, governingDefinition, subtypeEntry } from "./product-role.js";
import { toSlug } from "./slug.js";
import type { SubtypeLabel } from "./types.js";

export interface ProductFunction {
  slug: string;
  title: string;
  listNoun: string;
  categories: string[];
  subtypes: string[];
  taxonomies: string[];
}

export interface FunctionCarrier {
  category: string;
  product_subtypes?: { taxonomy: string; labels: SubtypeLabel[]; reviewed: string };
}

export const FUNCTION_NAMING_RULE =
  "A page is named after a product function. A function is named by a category, by a subtype label, or by both — two names are the same function when their slugs match once a trailing plural is dropped, or when a published ruling says two labels under different parents name one thing, and by nothing weaker. Substring overlap is not a match: container_app is not the container registry category, host_metrics is not cloud hosting, and the document database subtype is not documentation.";

export const FUNCTION_TITLE_RULE =
  "A page's title names a class of product. A category already names one, so the category name is the title. A subtype names an attribute of the class its parent names, so where the attribute alone would not name a product the title is declared beside the definition instead of derived from the label.";

export const FUNCTION_PICK_RULE =
  "A page is published when the function reaches enough records to compare and the list it will publish holds more than one of them. A page carrying a single pick is not a comparison, so the threshold counts what the page shows rather than what it could reach.";

export const FUNCTION_MEMBERSHIP_RULE =
  "A record reaches a function page when its category names the function or when it carries a subtype label that names the function. Adding a label to a record publishes it here; removing one withdraws it. No page holds a list of vendors.";

export const FUNCTION_SPLIT_RULE =
  "They are listed under the function each is labelled with. An offer labelled with more than one is listed under each, with the words we read for that label; an offer we have not labelled is listed too, at the end.";

export const FUNCTION_UNCLASSIFIED_RULE =
  "These offers reach this page through their category and we have not read them against its subtypes yet. They are listed in full; what is missing is our reading, not their eligibility.";

export const FUNCTION_NOT_IN_TAXONOMY_RULE =
  "We have read these offers against this category's subtypes and none of them applies. They are listed in full: the category is what they were filed under, and this states what our labels do not cover rather than a finding about the products.";

export function functionKey(slug: string): string {
  return slug.replace(/s$/, "");
}

export function subtypeTitle(subtype: string): string {
  return subtype
    .split("_")
    .map(word => (word === "llm" || word === "apm" || word === "api" || word === "gpu" ? word.toUpperCase() : word.charAt(0).toUpperCase() + word.slice(1)))
    .join(" ");
}

export function functionNaming(taxonomy: string, subtype: string): { title: string; listNoun: string } {
  const canonical = canonicalEntryFor({ taxonomy, subtype });
  const declared = subtypeEntry(canonical.taxonomy, canonical.subtype)?.name;
  const title = declared ?? subtypeTitle(canonical.subtype);
  return { title, listNoun: declared ?? `${title} Tools` };
}

export function buildProductFunctions(categoryNames: readonly string[]): ProductFunction[] {
  const byKey = new Map<string, ProductFunction>();

  for (const name of categoryNames) {
    const slug = toSlug(name);
    const key = functionKey(slug);
    const held = byKey.get(key);
    if (held) {
      if (!held.categories.includes(name)) held.categories.push(name);
      continue;
    }
    byKey.set(key, { slug, title: name, listNoun: `${name} Tools`, categories: [name], subtypes: [], taxonomies: [] });
  }

  for (const [taxonomy, entries] of Object.entries(SUBTYPE_TAXONOMIES)) {
    for (const { subtype } of entries) {
      const canonical = canonicalEntryFor({ taxonomy, subtype });
      const key = functionKey(toSlug(canonical.subtype));
      const held = byKey.get(key);
      if (held) {
        if (!held.subtypes.includes(subtype)) held.subtypes.push(subtype);
        if (!held.taxonomies.includes(taxonomy)) held.taxonomies.push(taxonomy);
        continue;
      }
      byKey.set(key, {
        slug: toSlug(canonical.subtype),
        ...functionNaming(taxonomy, subtype),
        categories: [],
        subtypes: [subtype],
        taxonomies: [taxonomy],
      });
    }
  }

  for (const fn of byKey.values()) {
    fn.subtypes.sort((a, b) => Number(toSlug(b) === fn.slug) - Number(toSlug(a) === fn.slug));
  }

  return [...byKey.values()];
}

export function functionDefinitions(fn: ProductFunction): string[] {
  const definitions = new Set<string>();
  for (const taxonomy of fn.taxonomies) {
    for (const subtype of fn.subtypes) {
      if (!subtypeDefinition(taxonomy, subtype)) continue;
      const governing = governingDefinition(taxonomy, subtype);
      if (governing) definitions.add(governing);
    }
  }
  return [...definitions];
}

export function functionMeaningSentence(definitions: readonly string[]): string {
  return definitions.length === 0 ? "" : `Our membership test: ${definitions.join("; or ")}.`;
}

export interface FunctionAdmission {
  byCategory: boolean;
  labels: SubtypeLabel[];
}

export function admissionFor(offer: FunctionCarrier, fn: ProductFunction): FunctionAdmission | null {
  const byCategory = fn.categories.includes(offer.category);
  const labels = (offer.product_subtypes?.labels ?? []).filter(l => fn.subtypes.includes(l.subtype));
  if (!byCategory && labels.length === 0) return null;
  return { byCategory, labels };
}

export function functionMembers<T extends FunctionCarrier>(offers: readonly T[], fn: ProductFunction): T[] {
  return offers.filter(o => admissionFor(o, fn) !== null);
}

export function admittedByLabelAlone(offer: FunctionCarrier, fn: ProductFunction): boolean {
  const admission = admissionFor(offer, fn);
  return admission !== null && !admission.byCategory && admission.labels.length > 0;
}

export function functionSplits(fn: ProductFunction): boolean {
  return fn.subtypes.length === 0;
}

export type FunctionResidue = "not_yet_classified" | "not_in_taxonomy";

export interface FunctionGroup<T> {
  subtype: string | null;
  residue: FunctionResidue | null;
  taxonomy: string | null;
  definition: string | null;
  title: string;
  members: T[];
}

export const FUNCTION_RESIDUE_COPY: Record<FunctionResidue, { title: string; rule: string }> = {
  not_yet_classified: { title: "Not read against this category's subtypes yet", rule: FUNCTION_UNCLASSIFIED_RULE },
  not_in_taxonomy: { title: "None of this category's subtypes applies", rule: FUNCTION_NOT_IN_TAXONOMY_RULE },
};

export function splitByFunction<T extends FunctionCarrier>(members: readonly T[], fn: ProductFunction): FunctionGroup<T>[] | null {
  if (!functionSplits(fn)) return null;
  const labelled = new Map<string, FunctionGroup<T>>();
  const residual = new Map<FunctionResidue, T[]>();
  for (const member of members) {
    const classified = member.product_subtypes;
    const labels = classified?.labels ?? [];
    if (labels.length === 0) {
      const residue: FunctionResidue = classified ? "not_in_taxonomy" : "not_yet_classified";
      const held = residual.get(residue);
      if (held) held.push(member);
      else residual.set(residue, [member]);
      continue;
    }
    for (const label of labels) {
      const taxonomy = classified!.taxonomy;
      const held = labelled.get(label.subtype);
      if (held) {
        held.members.push(member);
        continue;
      }
      labelled.set(label.subtype, {
        subtype: label.subtype,
        residue: null,
        taxonomy,
        definition: subtypeDefinition(taxonomy, label.subtype),
        title: subtypeTitle(label.subtype),
        members: [member],
      });
    }
  }
  if (labelled.size < 2) return null;
  const groups = [...labelled.values()];
  for (const residue of ["not_in_taxonomy", "not_yet_classified"] as FunctionResidue[]) {
    const held = residual.get(residue);
    if (!held) continue;
    groups.push({ subtype: null, residue, taxonomy: null, definition: null, title: FUNCTION_RESIDUE_COPY[residue].title, members: held });
  }
  return groups;
}

export function labelsNaming(offer: FunctionCarrier, subtype: string): SubtypeLabel[] {
  return (offer.product_subtypes?.labels ?? []).filter(l => l.subtype === subtype);
}
