import subprocess
import sys

MUTATIONS = {
    "filter-narrowed-to-exact-name": (
        "src/data.ts",
        "    results = results.filter((c) => c.vendor.toLowerCase().includes(lowerVendor));",
        "    results = results.filter((c) => c.vendor.toLowerCase() === lowerVendor);",
    ),
    "category-filter-left-undeclared": (
        "src/data.ts",
        '    askedByName.push({ parameter: "categories", field: "category", terms: catList });\n',
        "",
    ),
    "personalized-drops-the-declaration": (
        "src/data.ts",
        "    name_match: stackResult.name_match,\n",
        "",
    ),
    "counts-taken-over-the-whole-log": (
        "src/data.ts",
        "    name_match: nameMatchDisclosure(askedByName, served),",
        "    name_match: nameMatchDisclosure(askedByName, loadDealChanges()),",
    ),
    "rest-door-drops-the-declaration": (
        "src/serve.ts",
        "      name_match: result.name_match,\n",
        "",
    ),
    "every-match-called-exact": (
        "src/name-match.ts",
        '      how: (wanted.has(name.toLowerCase()) ? "exact" : "contains") as NameMatchHow,',
        '      how: "exact" as NameMatchHow,',
    ),
    "silent-when-nothing-else-matched": (
        "src/name-match.ts",
        "    filters: asked.map((a) => describeFilter(a, records)),",
        "    filters: asked.map((a) => describeFilter(a, records)).filter((f) => f.records_under_another_name > 0),",
    ),
    "note-withholds-the-other-names": (
        "src/name-match.ts",
        "  return rest > 0 ? `${joined} and ${rest} more` : joined;",
        "  return rest > 0 ? `${names.length} other names` : `${names.length} other names`;",
    ),
    "exact-match-dropped-to-make-room": (
        "src/name-match.ts",
        '        Number(b.how === "exact") - Number(a.how === "exact")\n        || b.records - a.records',
        "        b.records - a.records",
    ),
    "omitted-names-reported-as-none": (
        "src/name-match.ts",
        "    matched_names_omitted: Math.max(0, ranked.length - MAX_MATCHED_NAMES),",
        "    matched_names_omitted: 0,",
    ),
    "declared-rule-restated-by-hand": (
        "src/server.ts",
        "        vendor: z.string().optional().describe(`Filter to one vendor. ${NAME_MATCH_SENTENCE}`),",
        '        vendor: z.string().optional().describe("Filter to one vendor (case-insensitive)"),',
    ),
}

if len(sys.argv) < 2 or sys.argv[1] not in MUTATIONS:
    raise SystemExit("usage: mutate-1688.py <%s>" % "|".join(MUTATIONS))

name = sys.argv[1]
path, before, after = MUTATIONS[name]
source = open(path, encoding="utf-8").read()
hits = source.count(before)
if hits != 1:
    raise SystemExit("REFUSED %s: %d matches in %s, expected exactly 1" % (name, hits, path))
open(path, "w", encoding="utf-8").write(source.replace(before, after))
print("applied %s to %s" % (name, path))
print(subprocess.run(["git", "diff", "--stat", path], capture_output=True, text=True).stdout.strip())
