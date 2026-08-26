# Subtype taxonomy — `Databases` and `Cloud Hosting`

Status: **proposed by PM, not yet applied to any record.** This is the document
[#1032](https://github.com/robhunter/agentdeals/issues/1032) Phase 2 is blocked on. It covers two of 66
categories on purpose — prove the shape here before anyone touches the other 64.

## What a subtype is for

Exactly one thing: deciding **membership** of an alternatives list. An "alternative" today means *same
category, minus this vendor*, and `Databases` is coarse enough that this puts a Redis, a spreadsheet UI
and a document store on Neon's page.

Subtypes are a finer version of the property `category` already is — a factual claim about what the
product *is*, checkable against the vendor's own copy. They are not a judgment about fit. We do not say
Turso suits your workload better than Neon does; that remains the caller's job.

Inherits every control from Phase 1 (`src/product-role.ts`), and should extend that module rather than
sit beside it — `/criteria` promises one shared module with no second scorer:

- Gates membership. **Never scores, never orders, never ranks.** Order stays with the rotation module.
- Gates alternatives / related / risk / role-recommendation surfaces only. **Never** `/category/X`,
  `/best/X` or search — those are inventory and the caller asked for the category.
- Published on the vendor page and in the API record.
- Every label carries the vendor's own `source_url` + `source_quote`, same as `product_role`.
- Symmetric, in the Coder's formulation from Phase 1: a gate removes a candidate only where the subject
  of the list does not carry the same gate.

## Rule 1 — assign from the vendor's primary self-description

**A subtype is what the vendor's own front page says the product *is*. A capability mentioned in passing
is not a subtype.**

This is the whole discipline, and without it multi-labelling explodes until every record carries every
label and the gate does nothing. The test is falsifiable: *could the vendor's own headline carry this
word?*

- Supabase's own copy leads with Postgres, auth, storage, realtime **and** vector. It legitimately
  carries several. That is the multi-label case working as intended.
- Neon's headline is "Serverless Postgres". It supports pgvector; so does every Postgres. Under this
  rule Neon is `relational` and not `vector`. **This is the rule biting on our most important vendor,
  and I am applying it anyway** — the published-and-correctable machinery exists for precisely this, and
  if Neon tells us their headline is an AI database, vendor copy wins.
- SeaTable says "spreadsheet-like database". One label, `spreadsheet-base`, and it does not get
  `relational` merely because it stores rows.

## Rule 2 — match on *shares at least one*, never exact match

Two offers are alternatives if their subtype sets intersect. Exact-set matching would delete Supabase
from half the lists it belongs on.

## Rule 3 — the thin-tier rule

**This is the finding that most changes the design, and it is the answer to the acceptance criterion
asking which categories drop below three alternatives.** Counting the proposed labels:

| Subtype | Records | Effect if gated naively |
|---|---:|---|
| `analytics-warehouse` | **1** (BigQuery) | `/vendor/google-cloud-bigquery` alternatives → **empty** |
| `time-series` | **2** (InfluxDB, CrateDB) | one entry |
| `spreadsheet-base` | **2** (SeaTable, StackBy) | one entry |
| `graph` | 3 (Neo4j, Gel, SurrealDB) | at the floor |
| `vm-vps` | **1** (OpenVPS) | **empty** |

An empty alternatives block is worse than an over-inclusive one, because the `FAQPage` JSON-LD turns it
into a machine-readable sentence in our voice: *there are no free alternatives to BigQuery.* That is
false, and AI search engines consume it.

**The rule: if subtype gating would leave fewer than 3 candidates, the gate is not applied to that page.
The page falls back to category membership and says so on the page.** Binary — no partial application, no
relevance gradient, nothing that could become a score by the back door.

The published notice matters as much as the fallback. It converts a silent degradation into a state a
vendor can see and contest, consistent with our three-states rule (verified / checked-and-failed /
could-not-check are three states, not two).

And note what a thin tier usually *means*: BigQuery has one warehouse peer because our catalogue has one
warehouse peer, not because we classified badly. **A thin tier is a catalogue-acquisition signal, not a
classification bug** — Snowflake, ClickHouse and DuckDB are absent. That belongs on the roadmap, not in
this gate.

## Rule 4 — a record with no subtype is never excluded

**No label means no gate applies to it.** It stays in category-level membership.

Exclusion-by-omission is the failure mode that would do real damage here: a vendor disappears from every
list because nobody got round to labelling them, and there is no gradient for anyone to notice. A
missing label is our debt, not a fact about the vendor.

Unlabelled records go on the [#1048](https://github.com/robhunter/agentdeals/issues/1048) category-review
queue instead — see below, where that turns out to be the more useful half of this exercise.

---

## `Databases` — 9 subtypes, 45 records

| Subtype | Test |
|---|---|
| `relational` | Tables and SQL as the primary model (incl. SQLite, distributed SQL) |
| `document` | Schemaless JSON/BSON documents as the primary model |
| `key-value` | Key-value or cache as the primary model |
| `vector` | Embeddings and similarity search as the primary model |
| `graph` | Nodes and edges as the primary model |
| `time-series` | Timestamped series as the primary model |
| `analytics-warehouse` | OLAP / columnar analytical query over large datasets |
| `spreadsheet-base` | A table UI for people; the interface is the product |
| `backend-platform` | Database bundled with auth / storage / functions and sold as one backend |

Provisional assignment (45 records):

- `relational` — Aiven, Amazon Aurora PostgreSQL, Cloudflare D1, CockroachDB, CrateDB, Gel, Neon, Nhost,
  Nile, PocketBase, Supabase, SurrealDB Cloud, Turso, Xata, filess.io
- `document` — Couchbase Capella, Convex, Firebase, MongoDB Atlas, SurrealDB Cloud, codehooks.io,
  filess.io, restdb.io
- `key-value` — Aiven, Cloudflare KV, Momento, Redis Cloud, Upstash
- `vector` — Chroma, Convex, LanceDB, MongoDB Atlas, Supabase, Turbopuffer, Upstash Vector, Weaviate,
  Zilliz Cloud
- `graph` — Gel, Neo4j AuraDB, SurrealDB Cloud
- `time-series` — CrateDB, InfluxDB Cloud
- `analytics-warehouse` — Google Cloud BigQuery
- `spreadsheet-base` — SeaTable, StackBy
- `backend-platform` — 8base.com, Appwrite Cloud, Convex, Firebase, Nhost, PocketBase, Supabase,
  codehooks.io
- Gated by Phase 1, no subtype needed — Hasura Cloud (`addon`), Prisma Accelerate (`addon`),
  DynamoDB Local (`local_dev_only`)
- **Fits none — category error, route to #1048 (4):** Databricks (Lakeflow Connect) and skyvia.com are
  data-integration/ETL products; MongoDB and ScaleGrid Startup Program are credit offers, not product
  listings — both read as `Startup Perks`.

## `Cloud Hosting` — 7 subtypes, 62 records

| Subtype | Test |
|---|---|
| `static-site` | Serves prebuilt files; no server process you deploy |
| `app-platform` | Push a repo, they run a long-lived server process (PaaS) |
| `serverless-functions` | Per-invocation compute, no process you manage |
| `container-runtime` | You supply the image, they run it |
| `vm-vps` | You get a machine and an OS |
| `backend-as-a-service` | Bundled backend primitives rather than "run my code" |
| `managed-app-hosting` | Hosting specialised to one application (WordPress, Flarum, docs) |

Provisional assignment (62 records):

- `static-site` — Cloudflare Pages, GitHub Pages, Neocities, Netlify, PandaStack, Sevalla, Vercel,
  dAppling Network, surge.sh
- `app-platform` — Alwaysdata, Apply.build, Awardspace.com, Choreo, Claw.cloud, Clever Cloud, Fly.io,
  Koyeb, MDB GO, Northflank, PythonAnywhere, Qoddi, Railway, Render, Serv00.com, PandaStack, ampt.dev,
  anvil.works, domcloud.co, encore.dev, flightcontrol.dev, gigalixir.com, leapcell
- `serverless-functions` — Cloudflare Durable Objects, Cloudflare Dynamic Workers, Cloudflare Workers,
  Deno Deploy, Google Cloud Run, Netlify, Val Town, Vercel
- `container-runtime` — Cloudflare Sandboxes, Fly.io, Google Cloud Run, Northflank
- `vm-vps` — OpenVPS
- `backend-as-a-service` — Back4App, LeanCloud, paraio.com, simperium.com
- `managed-app-hosting` — FreeFlarum, pantheon.io, readthedocs.org
- **Fits none — category error, route to #1048 (15 of 62, 24%):**
  - Workflow automation → `Workflow Automation` (exists, 7 records): Activepieces, ETLR, IFTTT,
    Integrately, YepCode
  - Site/app builders → `Low-Code Platforms` (exists, 15 records): Bubble, Flutter Flow, Oaysus,
    Versoly, tilda.cc
  - Other: bismuth.cloud → `Code Quality` (our own description says "AI-powered code review… *formerly*
    Python API hosting"), WunderGraph → `API Development`, codenameone.com → `Mobile Development`,
    connectycube.com → `Messaging`, SourceForge → `Source Control`
  - Borderline, needs a human call: Daestro (job runner — `Background Jobs`?)

## The finding I did not expect

**Category hygiene is not uniform, and that changes how #1048 should be worked.**

`Databases` is 91% coherent — 4 of 45 misfiled. `Cloud Hosting` is 76% — **15 of 62**. Every destination
category already exists; nothing here needs a new bucket.

Two consequences:

1. **#1048 and this document are one pipeline, not two queue items.** I have been sequencing them as
   separate work. Building the taxonomy *is* how you find the misfiled records — "fits no subtype" is a
   far better detector of a category error than anything you could grep for, because it is defined by
   what the record *is* rather than by keywords.
2. **#1048 should be worked category-by-category, worst first**, not swept uniformly. The 15 above are a
   ready-made first batch with named destinations.

## Validation — what `/vendor/neon` becomes

Neon is `relational`. Alternatives = records sharing ≥1 subtype, minus Phase 1 gates:

> Aiven · Amazon Aurora PostgreSQL · Cloudflare D1 · CockroachDB · CrateDB · Gel · Nhost · Nile ·
> PocketBase · Supabase · SurrealDB Cloud · Turso · Xata · filess.io

Fourteen genuine SQL alternatives, comfortably above the thin-tier floor. All five errors named in
#1032 are gone, each for a stated reason:

| Removed | Why |
|---|---|
| Upstash | `key-value` — shares no subtype |
| SeaTable | `spreadsheet-base` — shares no subtype |
| Couchbase Capella | `document` — shares no subtype |
| Convex | `backend-platform` + `document` + `vector` — shares no subtype |
| Prisma Accelerate | Phase 1 `addon` |
| DynamoDB Local | Phase 1 `local_dev_only` |

That is the falsifiable test for this document. If the implementation produces a different list, one of
us is wrong and I want to know which.

## Evidence quality — read this before applying anything

**The assignments above were read from our own catalogue descriptions, not from vendor pages.** That is
weaker evidence than #1032 requires, and I am not going to present a first pass over 107 records as
verified.

So the split: **the taxonomy and the four rules are the deliverable and I stand behind them. The
per-record assignment is a starting point.** Each label still needs its `source_url` + `source_quote`
confirmed against the vendor's own copy at assignment time, exactly as Phase 1 did for its 10 records.

**Where vendor copy contradicts my reading, vendor copy wins and I want to hear about it** — a
systematic disagreement means Rule 1 is wrong, which matters much more than any single record.
