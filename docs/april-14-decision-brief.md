# April 14 Decision Brief: AgentDeals Strategic Direction

_Prepared by PM | April 9, 2026_

## TL;DR

AgentDeals has product-market fit as a **developer pricing intelligence platform**, not as an MCP-first tool. The data confirms this conclusively. I'm recommending we formalize the content-first, multi-channel strategy and greenlight the DEV.to article as our first external content play.

## Where We Are (Metrics)

| Metric | Value | Trend |
|--------|-------|-------|
| Cumulative MCP Sessions | 4,064 | Growing slowly (+8/cycle) |
| MCP Tool Calls | 20 | Flat since March — **0.5% activation** |
| REST API Hits | 2,730 | Growing steadily |
| Content Pages | 113+ | Growing (was 0 in Feb) |
| Offers in Index | 1,641 | Stable |
| Deal Changes Tracked | 82 | Growing |
| Distribution Channels | 16 live | Saturated |
| Google Indexed Pages | 652 of 3,616 | 18% — domain age ~2 months |
| Organic Mentions | 0 | 75th consecutive scan |
| Vulnerabilities | 0 | Clean (PR #686) |
| Tests | 467 pass, 0 fail | Solid |

## What's Working

1. **REST API** (2,730 hits, steady growth) — our best-performing channel. Real programmatic consumers.
2. **Content pages** (113 live, 652 indexed) — SEO is working, just slowly. Domain age is the bottleneck, not content quality.
3. **Data depth** — 82 tracked pricing changes across 60+ vendors is a unique asset. No one else publishes systematic developer tool pricing mutations.
4. **Product completeness** — 4 MCP tools, interactive widgets, badges, GitHub Action, developer hub. The product is built.

## What's Not Working

1. **MCP activation** (0.5%) — structural, not fixable. Data aggregators are low-frequency in MCP workflows. 8+ "Best MCP Servers" roundup articles exist; none include data/reference tools.
2. **Organic discovery** — 75 consecutive scans with zero mentions. Domain authority too low to compete with PE Collective, NxCode, Grizzly Peak, etc.
3. **MCP registry distribution** — 16 channels saturated. Registry discovery is hopeless at 20K+ servers.
4. **public-apis PR #5802** (420K stars) — dormant. Repo effectively dead (last merge April 2024).

## The Evidence for Content-First

The case has been building for weeks. Here's the summary:

- **REST API > MCP** for user value delivery (2,730 API hits vs 20 tool calls)
- **Content pages are indexing** — 652 pages in Google after 2 months. This is normal for a new domain.
- **Our unique data** (82 pricing changes, removal timelines, risk scores) is more valuable as content than as MCP tool responses
- **Content competition is intense but differentiated** — competitors publish curated lists; we have structured, time-series pricing data
- **MCP roundups structurally exclude us** — we can't change the category mental model

## Recommendation

**Formalize the pivot:** AgentDeals is a developer pricing intelligence platform. MCP remains a delivery channel, not the strategy.

### Immediate Actions (need your approval)

1. **Publish the DEV.to article** — Draft is ready at `docs/dev-article-draft.md`. Data-driven analysis of 82 pricing changes. Links back to agentdeals.dev 4x. Our first external content play. This is the single highest-leverage distribution action available.

2. **Consider an MCP roundup article** — "Best Free Tier MCP Servers for 2026" published on DEV.to. Targets roundup-search traffic (proven demand from 8+ existing articles) using our unique domain knowledge.

### Blocked on Rob

- **npm v0.3.1 publish** — auth token needed. Unlocks npx install flow.
- **GitHub Marketplace publish** — Free Tier Monitor Action needs web UI action. Makes Track B discoverable.

### No Approval Needed (PM will execute)

- Continue content page creation (Phase 19+)
- Monitor SEO indexing progress
- Track new pricing changes (Gemini API April 1 paywall, Windsurf March 19 quota overhaul)
- Data freshness sweep (~April 20)

## What I'm NOT Recommending

- **Killing MCP** — it still generates sessions and is a differentiator. Just not the primary growth vector.
- **Aggressive paid distribution** — premature. Let SEO mature (6-month window for new domains).
- **Pivoting the product** — the product is right. The distribution strategy needed adjustment, and we've made it.

## Decision Needed

1. ✅ or ❌ — Approve DEV.to article publication?
2. ✅ or ❌ — Approve MCP roundup article concept?
3. Any strategic direction you want to add or change?

## Timeline

If approved April 14:
- DEV.to article published that week
- MCP roundup article drafted and published within a week after
- Phase 19 resumes with content-distribution focus
- April 20: data freshness sweep
- May: evaluate SEO progress, consider additional content channels (Medium, Hashnode)
