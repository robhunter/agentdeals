# Change-direction census: 180 withholding records read against their own tier

Every offer whose stored terms are withheld under `supersedesTheStoredTerms()`, read one at a time against the tier the offer lists. Measured 2026-09-10 on `main` after #1523 and #1527. Supports #1526 (closed) and #1528 (open).

The question asked of each record is one thing only: **does this record describe a narrowing of the tier this offer lists?** Not whether the record is accurate about the page — most are — and not whether the vendor is good.

## Result

| `change_type` | in set | describes no narrowing |
|---|---|---|
| `limits_reduced` | 88 | 22 |
| `pricing_restructured` | 56 | 21 |
| `pricing_model_change` | 15 | 6 |
| `free_tier_removed` | 13 | 1 |
| `restriction` | 4 | 0 |
| `product_deprecated` | 4 | 0 |
| **total** | **180** | **50** |

`free_tier_removed` and `product_deprecated` are 16 of 17 correct. A coarse judgement is hard to get backwards. Every type that compares a quantity to a quantity is where the errors are.

## The 50

### `limits_reduced` — the listed tier improved (7)

| vendor | the record's own reading |
|---|---|
| Buildkite | 500 → 2,000 vCPU minutes/month; 50k → 250k test executions |
| PromoProxy | *"3 GB of data per day, down from 1 GB"* |
| Hex | Small compute 2 GB / 0.25 CPU → 4 GB / 0.5 CPU |
| Liveblocks | 500 monthly active rooms → unlimited; 256 MB realtime data → 1 GB |
| OneSignal | 100 emails/day → 10,000 emails/month |
| staticforms.xyz | *"500 submissions per month instead of 250"* |
| UniRateAPI | 200 requests/day unchanged; currencies 590+ → 870+ |

### `limits_reduced` — the reading restates the stored terms (15)

| vendor | why |
|---|---|
| Vercel | both states carry the same seven figures — 1M edge requests, 100 GB transfer, 1 GB blob, 5K image transformations, 1M invocations, 4 hrs active CPU, 360 GB-hrs memory |
| Railway | *"$1/month minimum after the trial"* and *"1 project"* are both already in our stored terms; the third claim, *"2 replicas instead of 1"*, is an increase |
| BetterStack | every figure matches; the reading adds 3 GB traces and 3 GB web events |
| CloudAMQP | 1M message quota, 20 connections, 100 queues all match; *"10,000 queued messages"* is queue depth, a different axis |
| Cloudflare KV | 100K reads/day, 1K writes/day, 1 GB — all match. Summary says *"the limits are daily instead of monthly"*; ours already say `/day` |
| Figma | every figure matches. The claim is that the page no longer *states* the team-project limit |
| Gel | *"1/4 compute unit (0.5 GiB RAM)"* → *"1/4 compute unit (1/2 GiB RAM, 1/16 vCPU)"* |
| Grapedrop | 5 pages and unlimited custom domains both already ours; only 100 form submissions is new |
| LiveKit | the summary restates our five stored figures verbatim |
| Microsoft Founders Hub | *"up to $150,000 in credits"* is our own upper figure |
| Qdrant | *"down from 1GB cluster (which likely meant storage)"* — the record hedges its own comparison |
| TeleportHQ | *"no longer explicitly mentions a limit of 'three free projects'"* — an absence, not a reduction |
| Terrateam | the entire summary is *"Doesn't confirm the original unlimited usage claim."* |
| Zoho Docs | 5 GB storage unchanged; *"previously 1GB upload limit"* is a different axis |
| zilore.com | 5 domains unchanged; records-per-domain and query cap are new detail |

### `pricing_model_change` (6)

| vendor | why |
|---|---|
| xAI | we list `Free Credits` ($25 sign-up, $150/mo via data sharing); the reading is Grok 4.6 token prices and says nothing about the credits |
| Cloudflare Queues | 10K ops/day free, 24-hour non-configurable retention, 1M/month paid — all three already ours |
| imgix | our description opens *"no permanent free tier. 30-day free trial with 100 credits"*; the summary's finding is the same sentence |
| Chroma | tier is `Open Source` (self-hosted, no limits); the reading prices Chroma Cloud's Starter plan |
| Shadcn Studio | *"features … that are **likely** part of paid plans"* |
| Mockerito | `current_state` states a free tier exists in the same record whose summary says the free tier now costs $10/month |

### `free_tier_removed` (1)

**Plausible Analytics** — tier `Free OSS` (AGPLv3), stored terms *"Self-hosted with no limits. Cloud plans start at $9/mo."* The reading is *"paid plans starting at $9/month"*, which our own description already carries.

### `pricing_restructured` (21)

The 24 recorded on #1526, less Grafana, SigNoz and Tyk, which #1527 fixed. Four shapes: the listed product is open source and the vendor's SaaS moved; the change moved a paid tier (Codecov, LambdaTest, MockAPI, LocalStack, Virgil Security, Airtable, WorkOS); the tier improved (formlets 100 → unlimited, OCR.Space 1 MB → 5 MB, SuperTokens, Replit); nothing changed (leiga.com, Amplitude, Pinecone, GitHub Actions, Invantive Cloud).

## Excluded deliberately: 27 records that discover a limit

A further 27 `limits_reduced` records state a limit our stored description never stated — addy.io, Aionda Mail, AppFit, BugBug, CatchJS.com, dnspod.com, Expo, forwardemail.net, FreeIPAPI, GitBook, Harness CI, Icon Horse, mockaroo, Mocklets, Nango, packagecloud.io, Permit.io, Pinata IPFS, ploi.io, Postman, Pullflow, RightFeature, transfernow, Vaadin, webhookrelay.com, Whitespace, Zenable.

Here the stored terms are incomplete rather than contradicted. The **withholding** is defensible — the substitute reading we publish is better information. The **rating** is not: we publish a caution because we learned more about a tier, not because the tier moved. They are not in the 50 and any rule that fixes the 50 should be measured against them.

## Three ways to derive direction from the stored text, all measured, all inadequate

Against these 88 `limits_reduced` records with the hand reading above as ground truth.

| approach | fires on | precision |
|---|---|---|
| direction words in `summary` (`up from`, `instead of`) | 4 of 88 | 2 of 4 |
| identical numeric multiset across the two states | 1 of 88 | — |
| unit-paired comparison (number + head noun, matched on noun) | 28 of 88 | ~55% |

The prose is unreliable in both directions at once: PromoProxy says *"down from"* about an increase, Zipcodestack says *"300 requests/month, up from 10,000"* about a 97% cut. The unit-paired comparison reads *"1/2 GiB"* as 2 GiB, so Gel comes out as an increase when it is unchanged; it matches Semgrep's contributors 10 → 10 and calls the record flat while missing 50 private repos → 10 repositories. Requiring full coverage of `previous_state` raises precision, drops Vercel, Railway, BetterStack, Cloudflare KV and Figma, and admits Scalr, where unlimited runs became 50/month.

A narrowing usually appears as a quantity present in one state and absent from the other, or expressed on a different axis — 60/minute against 500/day. Text comparison cannot see either.
