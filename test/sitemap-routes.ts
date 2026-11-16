import assert from "node:assert";

const A_ROUTE_IN_A_SITEMAP = /<loc>([^<]+)<\/loc>/g;

export async function everyRouteTheSitemapPublishes(base: string, request: typeof fetch = fetch): Promise<string[]> {
  const index = await (await request(`${base}/sitemap.xml`)).text();
  const sitemaps = [...index.matchAll(A_ROUTE_IN_A_SITEMAP)].map((found) => new URL(found[1]!).pathname);
  assert.ok(sitemaps.length > 0, "the sitemap index lists no sitemap for this population to be read from");
  const routes: string[] = [];
  for (const sitemap of sitemaps) {
    const listed = await (await request(`${base}${sitemap}`)).text();
    for (const found of listed.matchAll(A_ROUTE_IN_A_SITEMAP)) routes.push(new URL(found[1]!).pathname);
  }
  return [...new Set(routes)];
}
