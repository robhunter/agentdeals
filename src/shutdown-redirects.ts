export function reconcileShutdownRedirects(
  previousPaths: Iterable<string>,
  currentPaths: Iterable<string>,
  redirects: Readonly<Record<string, string>>,
): Map<string, string> {
  const current = new Set(currentPaths);
  const resolved = new Map<string, string>();
  for (const [oldPath, target] of Object.entries(redirects)) {
    if (!oldPath.startsWith("/shutdowns/") || !target.startsWith("/shutdowns/")) {
      throw new Error(`Invalid shutdown redirect: ${oldPath} -> ${target}`);
    }
    if (current.has(oldPath)) throw new Error(`Shutdown redirect shadows a page: ${oldPath}`);
    if (!current.has(target)) throw new Error(`Shutdown redirect target is not a page: ${oldPath} -> ${target}`);
    resolved.set(oldPath, target);
  }
  for (const oldPath of previousPaths) {
    if (oldPath.startsWith("/shutdowns/") && !current.has(oldPath) && !resolved.has(oldPath)) {
      throw new Error(`Shutdown page needs a redirect: ${oldPath}`);
    }
  }
  return resolved;
}
