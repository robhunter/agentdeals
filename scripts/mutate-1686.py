import subprocess
import sys

MUTATIONS = {
    "window-inherited-by-every-filter": (
        "src/data.ts",
        "  const namesWhatItWants = Boolean(changeType || vendor || vendors || categories);",
        "  const namesWhatItWants = false;",
    ),
    "window-escaped-by-vendor-only": (
        "src/data.ts",
        "  const namesWhatItWants = Boolean(changeType || vendor || vendors || categories);",
        "  const namesWhatItWants = Boolean(vendor);",
    ),
    "window-never-applied": (
        "src/data.ts",
        "  const namesWhatItWants = Boolean(changeType || vendor || vendors || categories);",
        "  const namesWhatItWants = true;",
    ),
    "window-not-reported-by-rest": (
        "src/serve.ts",
        "      date_window: result.date_window,\n",
        "",
    ),
    "window-reported-as-none-when-applied": (
        "src/change-window.ts",
        "  const from = servedWindowOpens(nowMs);\n  return {\n    applied: true,",
        "  const from = servedWindowOpens(nowMs);\n  return {\n    applied: false,",
    ),
    "window-names-no-date": (
        "src/change-window.ts",
        "export function windowFromSinceParameter(from: string): ChangeWindow {\n  return {\n    applied: true,\n    from,",
        "export function windowFromSinceParameter(from: string): ChangeWindow {\n  return {\n    applied: true,\n    from: null,",
    ),
    "advisory-inherits-the-query": (
        "src/data.ts",
        "  const allResult = getDealChanges(since ?? servedWindowOpens(), changeType);",
        "  const allResult = getDealChanges(since, changeType);",
    ),
    "personalized-drops-the-window": (
        "src/data.ts",
        "    date_window: stackResult.date_window,\n",
        "",
    ),
    "declared-default-restated-by-hand": (
        "src/server.ts",
        "since: z.string().optional().describe(`ISO date (YYYY-MM-DD). ${SINCE_DEFAULT_SENTENCE}`),",
        'since: z.string().optional().describe("ISO date (YYYY-MM-DD). Default: 7 days ago."),',
    ),
}

if len(sys.argv) < 2 or sys.argv[1] not in MUTATIONS:
    raise SystemExit("usage: mutate-1686.py <%s>" % "|".join(MUTATIONS))

name = sys.argv[1]
path, before, after = MUTATIONS[name]
source = open(path, encoding="utf-8").read()
hits = source.count(before)
if hits != 1:
    raise SystemExit("REFUSED %s: %d matches in %s, expected exactly 1" % (name, hits, path))
open(path, "w", encoding="utf-8").write(source.replace(before, after))
print("applied %s to %s" % (name, path))
print(subprocess.run(["git", "diff", "--stat", path], capture_output=True, text=True).stdout.strip())
