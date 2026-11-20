export async function guardShutdownLedger(previousPaths, currentPaths, base) {
  const current = new Set(currentPaths);
  for (const path of previousPaths) {
    if (!path.startsWith('/shutdowns/') || current.has(path)) continue;
    const response = await fetch(base + path, { redirect: 'manual' });
    const target = response.headers.get('location');
    if (response.status !== 301 || !target || !current.has(target)) {
      throw new Error(`Shutdown page needs a direct redirect to a current page: ${path}`);
    }
  }
}
