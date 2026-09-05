#!/usr/bin/env bash
set -uo pipefail
cd "$(dirname "$0")/.."

TESTS="test/model-rates.test.ts test/assistants-provider-tables.test.ts"
KILLED=0
SURVIVED=0

run_mutation() {
  local label="$1" file="$2" from="$3" to="$4"
  cp "$file" /tmp/mutate-1372-backup
  python3 - "$file" "$from" "$to" <<'PY'
import sys
path, frm, to = sys.argv[1], sys.argv[2], sys.argv[3]
s = open(path, encoding="utf-8").read()
n = s.count(frm)
if n != 1:
    print(f"SKIP: pattern appears {n} times", file=sys.stderr)
    sys.exit(3)
open(path, "w", encoding="utf-8").write(s.replace(frm, to))
PY
  local applied=$?
  if [ $applied -ne 0 ]; then
    cp /tmp/mutate-1372-backup "$file"
    printf '  %-58s NOT APPLIED\n' "$label"
    return
  fi
  ./node_modules/.bin/tsc > /tmp/mutate-1372-tsc 2>&1
  if [ $? -ne 0 ]; then
    printf '  %-58s killed (does not compile)\n' "$label"
    KILLED=$((KILLED + 1))
  else
    node --test --test-concurrency 1 $TESTS > /tmp/mutate-1372-out 2>&1
    if [ $? -ne 0 ]; then
      printf '  %-58s killed by %s\n' "$label" "$(grep -oE '^  ✖ .*\(' /tmp/mutate-1372-out | head -1 | sed 's/^  ✖ //; s/ ($//')"
      KILLED=$((KILLED + 1))
    else
      printf '  %-58s SURVIVED\n' "$label"
      SURVIVED=$((SURVIVED + 1))
    fi
  fi
  cp /tmp/mutate-1372-backup "$file"
  ./node_modules/.bin/tsc > /dev/null 2>&1
}

echo "── mutations of the provider-table rendering ──"

run_mutation "retired row keeps its stability rating" src/serve.ts \
  'stability: retired ? ENDED_BADGE_LABEL : stability,' \
  'stability: stability,'

run_mutation "tier cell reverts to a literal" src/serve.ts \
  'tier: record ? record.tier : "Not in our index",' \
  'tier: "Free (rate-limited)",'

run_mutation "a rate literal returns to a row array" src/serve.ts \
  '{ name: "Anthropic Claude", slug: "anthropic-api", toolUse: "Native tool use", codeExec: "Computer use, code execution", bestFor: "Best reasoning, long context" },' \
  '{ name: "Anthropic Claude", slug: "anthropic-api", toolUse: "Native tool use", codeExec: "Computer use, code execution", bestFor: "Best reasoning, $3/$15 (Sonnet)" },'

run_mutation "rate cell prints a figure of its own" src/serve.ts \
  'rateCell: span ? escHtmlServer(`${span} per MTok`) : pricingLink,' \
  'rateCell: escHtmlServer("$3/$15 per MTok"),'

run_mutation "a retired record is still asked for rates" src/model-rates.ts \
  'if (!offer || offerRetired(offer)) return [];' \
  'if (!offer) return [];'

run_mutation "the free-tier count stops reading the tier class" src/serve.ts \
  'const tierClass = classifyTier(record.tier).class;
    return tierClass === "free" || tierClass === "time_limited";' \
  'return true;'

run_mutation "an input-only rate is published as a pair" src/model-rates.ts \
  'return rate.model ? `${rate.input} (${rate.model}, input only)` : `${rate.input} (input only)`;' \
  'return rate.model ? `${rate.input}/${rate.input} (${rate.model})` : `${rate.input}/${rate.input}`;'

echo "── mutations of the rate reader ──"

run_mutation "split input/output clauses stop being read" src/model-rates.ts \
  '  scan(SPLIT, m => ({ input: `$${m[1]}`, output: `$${m[2]}` }));' \
  '  void SPLIT;'

run_mutation "a span never reaches its dearest end" src/model-rates.ts \
  '  return [cheapest, dearest];' \
  '  return [cheapest];'

run_mutation "the amount swallows trailing punctuation" src/model-rates.ts \
  'const AMOUNT = String.raw`\$(\d{1,3}(?:,\d{3})*(?:\.\d+)?)`;' \
  'const AMOUNT = String.raw`\$(\d[\d.,]*)`;'

run_mutation "a version dot ends a trailing model name" src/model-rates.ts \
  '(?=\.(?!\d)|[,;:)]|\s*$)' \
  '(?=[.,;:)]|\s*$)'

run_mutation "the monthly bill drops the output tokens" src/model-rates.ts \
  'return amountValue(rate.input) * millionsIn + amountValue(rate.output) * millionsOut;' \
  'return amountValue(rate.input) * millionsIn;'

run_mutation "cheapest and dearest swap" src/model-rates.ts \
  'return amountValue(a.input) - amountValue(b.input);' \
  'return amountValue(b.input) - amountValue(a.input);'

run_mutation "a name is taken without checking it is one" src/model-rates.ts \
  '  return acceptableName(afterLastClauseBreak(stripTail(prefix)));' \
  '  return afterLastClauseBreak(stripTail(prefix)) || null;'

run_mutation "an ambiguous slug resolves to its first record" src/model-rates.ts \
  '  return matches.length === 1 ? matches[0] : null;' \
  '  return matches[0] ?? null;'

run_mutation "a retired offer's tier stops being consulted" src/model-rates.ts \
  'export function publishableRates(offer: Pick<Offer, "tier" | "description"> | null): ModelRate[] {' \
  'export function publishableRates(offer: Pick<Offer, "description"> | null): ModelRate[] {'

echo
echo "killed ${KILLED}, survived ${SURVIVED}"
