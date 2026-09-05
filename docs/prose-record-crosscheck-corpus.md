# Labelled corpus: prose-vs-record cross-check (#1183 AC-4)

Measured 2026-08-31 so the check required by https://github.com/robhunter/agentdeals/issues/1183 can report a false-positive rate before it gates anything. AC-4 asks for a labelled sample. This is not a sample — it is the check's entire domain, so the rate below is exact.

## Headline

| measure | value |
|---|---|
| standalone content pages measured | 136 |
| pages rendering a catalogue record, where AC-3's check can fire at all | **5 (3.7%)** |
| candidate disagreements across those 5 pages | 18 |
| true positives | **2** |
| false positives | **16** |
| **false-positive rate** | **88.9%** (AC-4's bar is 10%) |
| distinct underlying defects found | **1** — already listed in #1183's table |

Run over every page it can reach, the check as specified in AC-3 surfaces one defect we already knew about and sixteen false alarms.

## AC-3's check cannot see the pages the problem lives on

AC-3 says the check fails "when a page renders a quantity for a vendor that disagrees with the quantity in that vendor's own catalogue record **on the same rendered page**". That requires a record on the page. Fetching all 136 single-segment standalone routes from production and looking for the `<vendor> verified data:` block:

- **5 pages render a catalogue record.** All five are head-to-head pages: `/datadog-vs-new-relic`, `/neon-vs-supabase`, `/railway-vs-render`, `/supabase-vs-firebase`, `/vercel-vs-netlify`.
- **131 render none.** Of the 23 `X-vs-Y` pages, only these 5 carry records; the other 18 do not.
- Cross-referencing the 2026-08-27 route-provenance census: **63 of the 136 are blind to `data/index.json` entirely** — pure hardcoded prose. **Zero of those 63 render a record.**

The hardcoded figures are the defect. The 63 pages made only of hardcoded figures are exactly the pages the check is structurally unable to examine.

Four of the six defect rows in #1183's own table render on `/hosting-free-tier-comparison-2026`, `/hosting-pricing` and `/serverless-free-tier-comparison-2026` — **all three render zero records**. Only the Netlify bandwidth row on `/vercel-vs-netlify` is inside the check's reach. The fixture named in AC-3 is the one page in the sample where the mechanism exists, which is why it looked workable.

**Join by vendor name against `data/index.json` instead of requiring the record to co-render.** Of the 63 pure-prose pages, **61 name at least one vendor we hold a record for**. That takes reach on the pages that matter from 0 to 61.

## Attribution: use the column header, not the enclosing block

My earlier design attributed a figure to a vendor by scanning the enclosing `<tr>`, card or heading for the vendor's name. On these pages that produced **78 candidates, 72 of them in blocks naming both vendors** — unusable.

The reason is that a comparison table does not name the vendor in the row. It names it once, in the column header:

```
| Feature   | Vercel Hobby           | Netlify Starter                        | Notes |
| Bandwidth | 100 GB/mo Fast Data... | 300 credits/mo (10 credits/GB ≈ 30 GB) | ...   |
```

Mapping column index to vendor from `<thead>`, and attributing each `<td>` to its column, takes 78 candidates to 18 with no loss of true positives. Two table shapes cover every case here: vendor-in-header (columns are vendors) and vendor-in-first-column (rows are vendors). **Skip the Notes column** — it discusses both vendors by design.

## Unit family is too coarse to compare on

Every false positive below is a pair where the number and the unit family match and the quantities are not comparable. A figure is only comparable when **vendor, plan and dimension** all agree. Matching on unit alone produces:

| class | n | what it is |
|---|---|---|
| `plan` | 7 | record describes the free tier, prose quotes Pro / Launch / Business |
| `dimension` | 6 | same unit, different thing — RAM vs storage, egress rate vs plan price, overage vs seat price, Firebase Cloud Storage vs Firestore |
| `record-historical` | 2 | the *record* carries the old number: "previously $20/seat per Git contributor" while prose quotes the current $19 |
| `record-narrower` | 1 | prose is right and fuller than the record — Supabase "10 GB total (5 cached + 5 uncached)" against a record stating only the 5 GB uncached half |

`record-historical` is worth noting because it is the mirror of the false-positive class I hit last time, where the *prose* held the historical narration. Both sides of this comparison contain retired numbers stated correctly, and neither side can be assumed current.

`record-narrower` is a finding in its own right: the check flagged it, and the page was right while the record was incomplete. A check that assumes the record is the truth will file bugs against correct prose.

## The one true positive, and why its evidence is wrong

Candidate 11 is real: `/vercel-vs-netlify` publishes Netlify bandwidth at `10 credits/GB` where the record says `20 credits/GB`.

Candidate 12 is the derived figure on the same line, `≈ 30 GB`. It is also wrong — at the real 20 credits/GB the 300-credit allowance is ~15 GB. But the check flags it by matching against `100GB`, the legacy pre-Sep-2025 account figure in the record, which has nothing to do with it. **A correct flag with incorrect evidence.** If the report prints its evidence, a reader will reject a true finding on sight. Any version of this that a human reads must show which record clause it matched.

## Every candidate, labelled

| # | page | vendor | published figure | record figure | label | class |
|---|---|---|---|---|---|---|
| 1 | `/neon-vs-supabase` | Neon | `8 GB` — 100 CU-hours/month, up to 2 CU (8 GB RAM) | `0.5 GB` | false | dimension |
| 2 | `/neon-vs-supabase` | Neon | `10 GB` — 10 GB (Launch) | `0.5 GB` | false | plan |
| 3 | `/neon-vs-supabase` | Supabase | `8 GB` — 8 GB database + 100 GB file storage (Pro) | `500 MB` | false | plan |
| 4 | `/neon-vs-supabase` | Supabase | `100 GB` — 8 GB database + 100 GB file storage (Pro) | `500 MB` | false | plan |
| 5 | `/railway-vs-render` | Railway | `$0.05` — Egress $0.05/GB (usage-based) | `$0` | false | dimension |
| 6 | `/railway-vs-render` | Railway | `$0.50` — ~$0.50-1/mo | `$0` | false | dimension |
| 7 | `/supabase-vs-firebase` | Firebase | `5 GB` — 5 GB Cloud Storage* | `1 GiB` | false | dimension |
| 8 | `/supabase-vs-firebase` | Supabase | `10 GB` — 10 GB total (5 GB cached + 5 GB uncached) | `500 MB` | false | record-narrower |
| 9 | `/supabase-vs-firebase` | Firebase | `10 GB` — 10 GB/mo hosting, 1 GB/day Firestore download | `1 GiB` | false | dimension |
| 10 | `/supabase-vs-firebase` | Supabase | `8 GB` — $25/mo (8 GB included) | `500 MB` | false | plan |
| 11 | `/vercel-vs-netlify` | Netlify | `10 credits/GB` — 300 credits/mo (10 credits/GB ≈ 30 GB) | `20 credits/GB` | **true** | real |
| 12 | `/vercel-vs-netlify` | Netlify | `30 GB` — 300 credits/mo (10 credits/GB ≈ 30 GB) | `100GB` | **true, wrong evidence** | real-wrong-evidence |
| 13 | `/vercel-vs-netlify` | Netlify | `$19` — $19/member/mo (Pro) | `$20` | false | record-historical |
| 14 | `/vercel-vs-netlify` | Vercel | `$40` — $20/mo + $40 overage (1 TB included in Pro) | `$20` | false | dimension |
| 15 | `/vercel-vs-netlify` | Vercel | `1 TB` — $20/mo + $40 overage (1 TB included in Pro) | `100 GB` | false | plan |
| 16 | `/vercel-vs-netlify` | Netlify | `$19` — $19/mo + usage (100 GB base) | `$20` | false | record-historical |
| 17 | `/vercel-vs-netlify` | Vercel | `1,000 GB-hrs` — 1,000 GB-hrs in Pro | `360 GB-hrs` | false | plan |
| 18 | `/vercel-vs-netlify` | Netlify | `$99` — $99/member/mo (Business) | `$20` | false | plan |

## Recommended changes to #1183

1. **AC-3** — drop the co-render requirement; join page figures to `data/index.json` by vendor name. As written the criterion is satisfiable by a check that examines 3.7% of the surface and reports green on the rest, which is worse than no check because it licenses the belief that the prose is clean.
2. **AC-4** — answered here: 88.9% over the full domain. Per AC-4's own instruction, **ship it as a report a human reads, not as a failing test.**
3. **New** — a candidate is only emitted when vendor, plan and dimension all match. Plan is recoverable from the column header (`Vercel Hobby`, `Netlify Starter`) and from parentheticals (`(Pro)`, `(Launch)`, `(Business)`). Without it, seven of these sixteen disappear on their own.
4. **New** — the report shows the record clause it matched, not just the record's number.

## Reproducing

`/tmp` artifacts are not durable; the method is: fetch each route with a `agentdeals-internal` UA, extract `<div class="context-box"><strong>NAME verified data:</strong>` blocks as the record side, map table columns to vendors from `<thead>`, and compare quantities by unit family after normalising MB/GiB/TB to GB. Labels are mine, checked against `supabase.com/pricing` and `railway.com/pricing` on 2026-08-31 where the call was not obvious from the page.

## Re-measured 2026-09-05, after the check was built

`scripts/prose-record-crosscheck.js` implements the design above. Run against the same five
pages — the entire domain the 18 labelled pairs came from:

| measure | 2026-08-31 | 2026-09-05 |
|---|---|---|
| candidates emitted | 18 | **0** |
| false positives | 16 | **0** |
| **false-positive rate** | 88.9% | **0%** |

The two true positives are absent because the defect they found is fixed. The check still
finds them: `test/hosting-free-tier-figures.test.ts` feeds it the pre-fix table markup and
requires the Netlify bandwidth rate to be flagged, then requires the flag to disappear once
the cell agrees with the record. A check that only reports zero because nothing is left to
find is indistinguishable from a broken one, so both directions are asserted.

Coverage did not pay for the precision. Across all 144 single-segment standalone routes the
check emits **79 candidates on 33 routes**, against 78 for the noisier version it replaced.

### What removed each class

| class | n | what fixed it |
|---|---|---|
| `plan` | 7 | the plan named on the page must be one the record describes; a free-tier alias (`Starter`, `Hobby`) may stand in for a record tiered `Free`, a paid plan name never does |
| `dimension` | 6 | the dimension is read from the clause holding the figure, not from the cell or sentence containing it, and a quantity only compares to another quantity with the same denominator — `$0` is not comparable to `$0.15/GB` |
| `record-historical` | 2 | clauses on either side carrying `previously`, `legacy`, `down from` and their kin are excluded from both sides, not just from the page |
| `record-narrower` | 1 | a figure whose clause says `total` and equals the sum of the record's own parts is agreement, not disagreement |

Two further classes came out of the census rather than the corpus:

- **binary against decimal.** `512 MiB` and `0.5 GB` are one quantity spelled two ways, a 7%
  gap. Quantities within 10% are treated as agreement, which cost 12 candidates and no
  finding.
- **a flattened table row read as a sentence.** A run of text carrying three or more
  quantities between commas is a table that lost its markup, not a claim about one number.

### What the census found that the corpus could not

`/railway-vs-render` published Render's free workspace as `1 (2 environments)` project.
Render's own plan table reads `Projects — Unlimited` for Hobby and caps the workspace at 25
services instead. Nothing in #1183 or in this corpus listed it; the check found it on its
first full run, which is the argument for the check.

The evidence it printed was the wrong clause — it matched `Up to 25 services` against a
project count. The finding was right and its justification was not, which is the same shape
as candidate 12 above and the reason AC-8 asks for the clause rather than the number.
