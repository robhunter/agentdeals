import sys

SHUTDOWN_BEFORE = '''        ${servedVendorSlug(s.vendorSlug) === null ? "" : `<a href="/vendor/${escHtmlServer(s.vendorSlug)}">Vendor profile \\u2192</a>`}'''
SHUTDOWN_AFTER = '''        <a href="/vendor/${escHtmlServer(s.vendorSlug)}">Vendor profile \\u2192</a>'''

SLUGIFY_BEFORE = '''<td style="font-weight:600">${handwrittenVendorLinkHtml(toSlug(p.name), p.name, ' style="color:var(--text)"')}</td>'''
SLUGIFY_AFTER = '''<td style="font-weight:600"><a href="/vendor/${p.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/-+$/, "")}" style="color:var(--text)">${escHtmlServer(p.name)}</a></td>'''

MERGE_LINE = '''    { "retired": "Anthropic Claude API", "survivor": "Anthropic API" },\n'''

SCRIPT_BEFORE = '''  const rendered = html.replace(SCRIPT_BLOCK, "");'''
SCRIPT_AFTER = '''  const rendered = html;'''

ROUTES_BEFORE = '''      routesRead++;'''
ROUTES_AFTER = '''      if (route.startsWith("/vendor/")) return;\n      routesRead++;'''

MUTATIONS = {
    "shutdown-link": ("src/serve.ts", SHUTDOWN_BEFORE, SHUTDOWN_AFTER),
    "display-name-slugify": ("src/serve.ts", SLUGIFY_BEFORE, SLUGIFY_AFTER),
    "merge-anthropic": ("data/vendor_merges.json", MERGE_LINE, ""),
    "read-script-source": ("test/rendered-vendor-links-resolve.test.ts", SCRIPT_BEFORE, SCRIPT_AFTER),
    "skip-routes": ("test/rendered-vendor-links-resolve.test.ts", ROUTES_BEFORE, ROUTES_AFTER),
}

for name in sys.argv[1:]:
    path, before, after = MUTATIONS[name]
    source = open(path, encoding="utf-8").read()
    if source.count(before) != 1:
        raise SystemExit("%s: %d matches for %s, expected 1" % (name, source.count(before), path))
    open(path, "w", encoding="utf-8").write(source.replace(before, after))
