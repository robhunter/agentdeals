# We Tracked 82 Developer Tool Pricing Changes in 2026 — Here's What's Really Happening to Free Tiers

> **Target platform:** DEV.to
> **Status:** DRAFT — Awaiting Rob's approval (April 14 decision point)
> **Tags:** devtools, pricing, free, startup
> **Canonical URL:** https://agentdeals.dev/deal-changes

---

Every developer relies on free tiers. They're how we prototype, learn, and ship side projects without spending a dime. But free tiers aren't static — vendors quietly change them all the time.

We've been tracking every developer tool pricing change we can find. So far in 2026, we've documented **82 changes across 60+ vendors**. The pattern is clear: **free tiers are eroding faster than they're expanding.**

## The Numbers

| Change Type | Count |
|---|---|
| Pricing restructured | 28 |
| Free tier removed entirely | 13 |
| Limits reduced | 9 |
| Limits increased | 8 |
| New restrictions added | 7 |
| New free tier launched | 7 |
| Product deprecated | 4 |
| Other (model changes, expansions) | 6 |

**57 of 82 changes (70%) made things worse for developers.** Only 17 were clearly positive.

## The Biggest Losses

These hit real developer workflows:

**SendGrid** killed its perpetual free tier (100 emails/day) and replaced it with a 60-day trial. If you had a side project sending transactional emails, you now need $19.95/month or a new provider.

**PlanetScale** removed its free Hobby plan entirely. Databases on the free tier were deleted after a 30-day grace period. The Postgres-compatible serverless database that thousands of tutorials recommended? Gone.

**LocalStack** dropped its open-source Community Edition. The single unified image now requires an auth token. "Free" became "free with registration and reduced functionality."

**Brave Search API** replaced its 5,000 queries/month free plan with metered billing. You get a $5 monthly credit as an offset, but the unlimited-for-small-projects model is dead.

**Firebase** removed Cloud Storage from the Spark (free) plan. Projects using the default `appspot.com` bucket lost console access and needed to migrate.

## The Credit-Based Pricing Wave

The most significant pattern isn't removal — it's **restructuring toward credit-based models**:

- **Netlify** moved to credit-based pricing; sites pause when credits run out
- **Vercel** Pro plan became a $20/month credit pool with usage metering
- **Cursor** moved from flat subscriptions to credit-based pricing with a new $200/month Ultra tier
- **Augment Code** shifted from per-seat subscriptions to consumption-based credits
- **Docker Hub** restructured everything: Pro +80%, Team +67%, Build Cloud minutes removed from free

The shift is consistent: vendors want metered, predictable revenue. Flat-rate free tiers are expensive to maintain at scale, and credit-based models let vendors capture more value from power users while keeping a nominal "free" option that's harder to compare across vendors.

## The Bright Spots

Not everything is getting worse:

**Auth0** expanded its free tier from 7,500 to 25,000 monthly active users — the biggest expansion since the Okta acquisition. That's a 3.3x increase.

**GitHub Copilot** launched a free tier: 2,000 completions and 50 chat messages per month. The most significant new free tier in AI coding.

**Railway** expanded its free tier after a $100M Series B, adding $5 in monthly credits.

**Cloudflare** added message queuing (Queues) to the Workers free plan and revamped its startup program to offer up to $250,000 in credits.

**Anthropic** cut Claude Opus API pricing by 67% — from $15/$75 to $5/$25 per million tokens.

## What This Means for Your Stack

If you're building on free tiers, here's the practical takeaway:

1. **Assume your free tier will change.** Build with migration in mind. Don't hardcode vendor-specific APIs without an abstraction layer.

2. **Watch for the credit model shift.** When your vendor announces "exciting new pricing," it usually means your free usage is about to get metered.

3. **Vendor-funded expansions follow funding rounds.** Railway expanded after Series B. Auth0 expanded post-Okta. These expansions are subsidized growth — enjoy them, but know they're temporary.

4. **Open-source alternatives exist for most categories.** When LocalStack went closed-source, Terragrunt Scale launched a free tier as a direct alternative. The ecosystem adapts.

## Stay Informed

We maintain a [live tracker of all 82+ pricing changes](https://agentdeals.dev/deal-changes) with dates, previous states, and current states for each vendor. The full dataset covers [1,641 developer tool offers](https://agentdeals.dev) across 67 categories — searchable by category, vendor, or deal type.

There's also a [free REST API](https://agentdeals.dev/api-docs) if you want to build on the data, and an [MCP server](https://agentdeals.dev/mcp) for AI-assisted infrastructure planning.

---

*What pricing changes have hit your workflow hardest? Drop a comment — we'll add anything we're missing to the tracker.*
