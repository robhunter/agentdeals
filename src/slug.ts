export function toSlug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

export function isSubSlug(needle: string, haystack: string): boolean {
  if (needle === haystack) return true;
  if (haystack.startsWith(needle + "-")) return true;
  if (haystack.endsWith("-" + needle)) return true;
  return haystack.includes("-" + needle + "-");
}
