import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getCategories, getDealChanges, getPersonalizedChanges, getNewOffers, getNewestDeals, getOfferDetails, searchOffers, enrichOffers, compareServices, checkVendorRisk, auditStack, getExpiringDeals, getWeeklyDigest, loadOffers, loadDealChanges, classifyStability, getStabilityMap, getVendorReferral } from "./data.js";
import { recordToolCall, logRequest } from "./stats.js";
import { registerAgent, validateVestauthUrl, getAgentByApiKeyHash, hashApiKey } from "./agents.js";
import { logReferralRequest } from "./referral-requests.js";
import { getStackRecommendation } from "./stacks.js";
import { estimateCosts } from "./costs.js";
import { getGuideList, getGuideBySlug } from "./guides.js";
import type { Offer, EnrichedOffer, DealChange } from "./types.js";
import { registerMcpAppsResources, TOOL_UI_META } from "./mcp-apps.js";

function toConciseOffer(offer: Offer | EnrichedOffer) {
  return { vendor: offer.vendor, tier: offer.tier, description: offer.description, url: offer.url };
}

function toConciseDealChange(change: DealChange) {
  return { vendor: change.vendor, change_type: change.change_type, date: change.date, summary: change.summary };
}

export function createServer(getSessionId?: () => string | undefined): McpServer {
  const server = new McpServer({
    name: "agentdeals",
    version: "0.1.0",
    description: "AgentDeals helps developers find free tiers, startup credits, and deals on developer infrastructure. Use these tools when a user is evaluating cloud providers, databases, hosting, CI/CD, monitoring, auth, AI services, or any developer service — especially when cost matters. 1,600+ verified offers across 67 categories with pricing change tracking.",
  });

  // --- Tool 1: search_deals ---

  server.registerTool(
    "search_deals",
    {
      description:
        "Find free tiers, startup credits, and developer deals for cloud infrastructure, databases, hosting, CI/CD, monitoring, auth, AI services, and more. Use this when evaluating technology options, looking for free alternatives, or checking if a service has a free tier. Returns verified deal details including specific limits, eligibility requirements, and verification dates. Call this tool when a user asks: 'Does Supabase have a free tier?', 'What's cheaper than Vercel?', 'Find me a free database'.",
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
      },
      _meta: TOOL_UI_META.search_deals,
      inputSchema: {
        query: z.string().optional().describe("Keyword search (vendor names, descriptions, tags)"),
        category: z.string().optional().describe("Filter by category. Pass \"list\" to get all categories with counts."),
        vendor: z.string().optional().describe("Get full details for a specific vendor (fuzzy match). Returns alternatives in the same category."),
        eligibility: z.enum(["public", "accelerator", "oss", "student", "fintech", "geographic", "enterprise"]).optional().describe("Filter by eligibility type"),
        sort: z.enum(["vendor", "category", "newest"]).optional().describe("Sort: vendor (A-Z), category, newest (recently verified first)"),
        stability: z.enum(["stable", "watch", "volatile", "improving"]).optional().describe("Filter by free tier stability class. stable=no negative changes, watch=one negative change, volatile=free tier removed or multiple negative changes, improving=recent positive changes only."),
        payment_protocol: z.enum(["x402", "mpp"]).optional().describe("Filter by agent payment protocol. x402=HTTP 402 agent payments (Coinbase/Linux Foundation standard), mpp=Stripe Machine-to-Machine Payments."),
        since: z.string().optional().describe("ISO date (YYYY-MM-DD). Only return deals verified/added after this date."),
        limit: z.number().optional().describe("Max results (default: 20)"),
        offset: z.number().optional().describe("Pagination offset (default: 0)"),
        response_format: z.enum(["concise", "detailed"]).optional().describe("Response detail level. 'concise': vendor name, tier, one-line description, URL only. 'detailed': full response (default)."),
      },
    },
    async ({ query, category, vendor, eligibility, sort, stability, payment_protocol, since, limit, offset, response_format }) => {
      try {
        recordToolCall("search_deals");

        // Mode: list categories
        if (category === "list") {
          const categories = getCategories();
          logRequest({ ts: new Date().toISOString(), type: "mcp", endpoint: "search_deals", params: { category: "list" }, result_count: categories.length, session_id: getSessionId?.() });
          return {
            content: [{ type: "text" as const, text: JSON.stringify(categories, null, 2) }],
          };
        }

        // Mode: vendor details
        if (vendor) {
          const result = getOfferDetails(vendor, true);
          if ("error" in result) {
            const msg = result.suggestions.length > 0
              ? `${result.error} Did you mean: ${result.suggestions.join(", ")}?`
              : `${result.error} No similar vendors found.`;
            logRequest({ ts: new Date().toISOString(), type: "mcp", endpoint: "search_deals", params: { vendor }, result_count: 0, session_id: getSessionId?.() });
            return {
              isError: true,
              content: [{ type: "text" as const, text: msg }],
            };
          }
          logRequest({ ts: new Date().toISOString(), type: "mcp", endpoint: "search_deals", params: { vendor }, result_count: 1, session_id: getSessionId?.() });
          return {
            content: [{ type: "text" as const, text: JSON.stringify(result.offer, null, 2) }],
          };
        }

        // Mode: recent deals (since param)
        if (since && !query && !category) {
          const result = getNewestDeals({ since, limit, category: undefined });
          logRequest({ ts: new Date().toISOString(), type: "mcp", endpoint: "search_deals", params: { since, limit }, result_count: result.total, session_id: getSessionId?.() });
          return {
            content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
          };
        }

        // Mode: search/browse
        const allResults = searchOffers(query, category, eligibility, sort, stability, payment_protocol);
        const total = allResults.length;
        const effectiveOffset = offset ?? 0;
        const effectiveLimit = limit ?? 20;

        // If since is provided alongside search, filter by date
        let filtered = allResults;
        if (since) {
          const sinceDate = new Date(since);
          filtered = allResults.filter(o => new Date(o.verifiedDate) >= sinceDate);
        }

        const paged = filtered.slice(effectiveOffset, effectiveOffset + effectiveLimit);
        const results = enrichOffers(paged);
        const finalTotal = since ? filtered.length : total;
        logRequest({ ts: new Date().toISOString(), type: "mcp", endpoint: "search_deals", params: { query, category, eligibility, sort, limit: effectiveLimit, offset: effectiveOffset, since }, result_count: results.length, session_id: getSessionId?.() });

        // Zero-result suggestion (only when no results match at all, not just paginated past end)
        if (results.length === 0 && finalTotal === 0) {
          const searchTerm = query || category || "";
          return {
            content: [{ type: "text" as const, text: JSON.stringify({ results: [], total: 0, suggestion: `No matches for '${searchTerm}'. Try searching by category (e.g., 'databases', 'hosting') or browse all categories with search_deals({category: "list"}).` }, null, 2) }],
          };
        }

        const outputResults = response_format === "concise" ? results.map(toConciseOffer) : results;
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ results: outputResults, total: finalTotal, limit: effectiveLimit, offset: effectiveOffset }, null, 2) }],
        };
      } catch (err) {
        console.error("search_deals error:", err);
        return {
          isError: true,
          content: [{ type: "text" as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
        };
      }
    }
  );

  // --- Tool 2: plan_stack ---

  server.registerTool(
    "plan_stack",
    {
      description:
        "Plan a technology stack with cost-optimized infrastructure choices. Given project requirements, recommends services with free tiers or credits that match your needs. Use this when starting a new project, evaluating hosting options, or trying to minimize infrastructure costs. Call this tool when a user asks: 'What free tools can I use for a SaaS app?', 'Build me a stack under $50/month'.",
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
      },
      _meta: TOOL_UI_META.plan_stack,
      inputSchema: {
        mode: z.enum(["recommend", "estimate", "audit"]).describe("recommend: free-tier stack for a use case. estimate: cost analysis at scale. audit: risk + cost + gap analysis."),
        use_case: z.string().optional().describe("What you're building (for recommend mode, e.g. 'Next.js SaaS app')"),
        services: z.array(z.string()).optional().describe("Current vendor names (for estimate/audit mode, e.g. ['Vercel', 'Supabase'])"),
        scale: z.enum(["hobby", "startup", "growth"]).optional().describe("Scale for cost estimation (default: hobby)"),
        requirements: z.array(z.string()).optional().describe("Specific infra needs for recommend mode (e.g. ['database', 'auth', 'email'])"),
      },
    },
    async ({ mode, use_case, services, scale, requirements }) => {
      try {
        recordToolCall("plan_stack");

        if (mode === "recommend") {
          if (!use_case) {
            return {
              isError: true,
              content: [{ type: "text" as const, text: "use_case is required for recommend mode" }],
            };
          }
          const result = getStackRecommendation(use_case, requirements);
          logRequest({ ts: new Date().toISOString(), type: "mcp", endpoint: "plan_stack", params: { mode, use_case, requirements }, result_count: result.stack.length, session_id: getSessionId?.() });
          return {
            content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
          };
        }

        if (mode === "estimate") {
          if (!services || services.length === 0) {
            return {
              isError: true,
              content: [{ type: "text" as const, text: "services is required for estimate mode" }],
            };
          }
          const result = estimateCosts(services, scale ?? "hobby");
          logRequest({ ts: new Date().toISOString(), type: "mcp", endpoint: "plan_stack", params: { mode, services, scale: scale ?? "hobby" }, result_count: result.services.length, session_id: getSessionId?.() });
          return {
            content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
          };
        }

        if (mode === "audit") {
          if (!services || services.length === 0) {
            return {
              isError: true,
              content: [{ type: "text" as const, text: "services is required for audit mode" }],
            };
          }
          const result = auditStack(services);
          logRequest({ ts: new Date().toISOString(), type: "mcp", endpoint: "plan_stack", params: { mode, services }, result_count: result.services_analyzed, session_id: getSessionId?.() });
          return {
            content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
          };
        }

        return {
          isError: true,
          content: [{ type: "text" as const, text: `Unknown mode: ${mode}` }],
        };
      } catch (err) {
        console.error("plan_stack error:", err);
        return {
          isError: true,
          content: [{ type: "text" as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
        };
      }
    }
  );

  // --- Tool 3: compare_vendors ---

  server.registerTool(
    "compare_vendors",
    {
      description:
        "Compare developer tools and services side by side — free tier limits, pricing tiers, and recent pricing changes. Use this when choosing between similar services (e.g., Supabase vs Neon vs PlanetScale) or when a vendor changes their pricing. Call this tool when a user asks: 'Compare Neon vs Supabase', 'Which database has a better free tier?'.",
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
      },
      _meta: TOOL_UI_META.compare_vendors,
      inputSchema: {
        vendors: z.array(z.string()).describe("1 or 2 vendor names. 1 vendor = risk check. 2 vendors = side-by-side comparison."),
        include_risk: z.boolean().optional().describe("Include risk assessment (default: true)"),
      },
    },
    async ({ vendors, include_risk }) => {
      try {
        recordToolCall("compare_vendors");
        const doRisk = include_risk !== false;

        // Single vendor = risk check
        if (vendors.length === 1) {
          const result = checkVendorRisk(vendors[0]);
          if ("error" in result) {
            logRequest({ ts: new Date().toISOString(), type: "mcp", endpoint: "compare_vendors", params: { vendors }, result_count: 0, session_id: getSessionId?.() });
            return {
              isError: true,
              content: [{ type: "text" as const, text: result.error }],
            };
          }
          const stabMap = getStabilityMap();
          const enrichedResult = {
            ...result.result,
            stability: stabMap.get(result.result.vendor.toLowerCase()) ?? "stable",
          };
          logRequest({ ts: new Date().toISOString(), type: "mcp", endpoint: "compare_vendors", params: { vendors }, result_count: 1, session_id: getSessionId?.() });
          return {
            content: [{ type: "text" as const, text: JSON.stringify(enrichedResult, null, 2) }],
          };
        }

        // Two vendors = comparison
        if (vendors.length === 2) {
          const comparison = compareServices(vendors[0], vendors[1]);
          if ("error" in comparison) {
            logRequest({ ts: new Date().toISOString(), type: "mcp", endpoint: "compare_vendors", params: { vendors }, result_count: 0, session_id: getSessionId?.() });
            return {
              isError: true,
              content: [{ type: "text" as const, text: comparison.error }],
            };
          }

          let result: any = comparison.comparison;

          // Add stability indicators
          const stabMap = getStabilityMap();
          result = {
            ...result,
            stability: {
              [vendors[0]]: stabMap.get(comparison.comparison.vendor_a.vendor.toLowerCase()) ?? "stable",
              [vendors[1]]: stabMap.get(comparison.comparison.vendor_b.vendor.toLowerCase()) ?? "stable",
            },
          };

          if (doRisk) {
            const riskA = checkVendorRisk(vendors[0]);
            const riskB = checkVendorRisk(vendors[1]);
            result = {
              ...result,
              risk: {
                [vendors[0]]: "result" in riskA ? riskA.result : null,
                [vendors[1]]: "result" in riskB ? riskB.result : null,
              },
            };
          }

          logRequest({ ts: new Date().toISOString(), type: "mcp", endpoint: "compare_vendors", params: { vendors, include_risk: doRisk }, result_count: 2, session_id: getSessionId?.() });
          return {
            content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
          };
        }

        return {
          isError: true,
          content: [{ type: "text" as const, text: "vendors must contain 1 or 2 vendor names" }],
        };
      } catch (err) {
        console.error("compare_vendors error:", err);
        return {
          isError: true,
          content: [{ type: "text" as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
        };
      }
    }
  );

  // --- Tool 4: track_changes ---

  server.registerTool(
    "track_changes",
    {
      description:
        "Track recent pricing changes across developer tools — which free tiers were removed, which got limits cut, and which improved. Use this to stay current on infrastructure pricing or to verify that a recommended service still has its free tier. Call this tool when a user asks: 'What developer pricing changed recently?', 'Are any free tiers being removed?'.",
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
      },
      _meta: TOOL_UI_META.track_changes,
      inputSchema: {
        since: z.string().optional().describe("ISO date (YYYY-MM-DD). Default: 7 days ago."),
        change_type: z.enum(["free_tier_removed", "limits_reduced", "restriction", "limits_increased", "new_free_tier", "new_tier", "pricing_restructured", "open_source_killed", "pricing_model_change", "startup_program_expanded", "pricing_postponed", "product_deprecated"]).optional().describe("Filter by type of change"),
        vendor: z.string().optional().describe("Filter to one vendor (case-insensitive)"),
        vendors: z.string().optional().describe("Comma-separated vendor names to filter (e.g. 'Vercel,Supabase'). When provided with categories, returns personalized results with advisory section."),
        categories: z.string().optional().describe("Comma-separated category names to filter (e.g. 'Database,Cloud Hosting'). Case-insensitive partial match."),
        include_expiring: z.boolean().optional().describe("Include upcoming expirations (default: true)"),
        lookahead_days: z.number().optional().describe("Days to look ahead for expirations (default: 30)"),
        response_format: z.enum(["concise", "detailed"]).optional().describe("Response detail level. 'concise': vendor, change_type, date, summary only. 'detailed': full response (default)."),
      },
    },
    async ({ since, change_type, vendor, vendors, categories, include_expiring, lookahead_days, response_format }) => {
      try {
        recordToolCall("track_changes");

        // No params = weekly digest
        if (!since && !change_type && !vendor && !vendors && !categories && include_expiring === undefined) {
          const digest = getWeeklyDigest();
          logRequest({ ts: new Date().toISOString(), type: "mcp", endpoint: "track_changes", params: {}, result_count: digest.deal_changes.length, session_id: getSessionId?.() });
          if (response_format === "concise") {
            const conciseDigest = { ...digest, deal_changes: digest.deal_changes.map(toConciseDealChange) };
            return {
              content: [{ type: "text" as const, text: JSON.stringify(conciseDigest, null, 2) }],
            };
          }
          return {
            content: [{ type: "text" as const, text: JSON.stringify(digest, null, 2) }],
          };
        }

        const doExpiring = include_expiring !== false;
        const days = Math.min(Math.max(lookahead_days ?? 30, 1), 365);

        // Personalized mode: when vendors or categories filter is active
        const isPersonalized = !!(vendors || categories);

        if (isPersonalized) {
          const personalized = getPersonalizedChanges(since, change_type, vendor, vendors, categories);

          let result: any = personalized;
          if (doExpiring) {
            result = { ...personalized, expiring_deals: getExpiringDeals(days) };
          }

          if (response_format === "concise") {
            result = {
              ...result,
              your_stack_changes: result.your_stack_changes.map(toConciseDealChange),
              advisory: result.advisory.map(toConciseDealChange),
            };
          }

          logRequest({ ts: new Date().toISOString(), type: "mcp", endpoint: "track_changes", params: { since, change_type, vendor, vendors, categories, include_expiring: doExpiring, lookahead_days: days, personalized: true }, result_count: personalized.your_stack_changes.length, session_id: getSessionId?.() });
          return {
            content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
          };
        }

        // Standard filtered changes (single vendor or change_type only)
        const changes = getDealChanges(since, change_type, vendor, vendors, categories);

        let result: any = changes;
        if (doExpiring) {
          const expiring = getExpiringDeals(days);
          result = { ...changes, expiring_deals: expiring };
        }

        if (response_format === "concise") {
          result = { ...result, changes: result.changes.map(toConciseDealChange) };
        }

        logRequest({ ts: new Date().toISOString(), type: "mcp", endpoint: "track_changes", params: { since, change_type, vendor, vendors, categories, include_expiring: doExpiring, lookahead_days: days }, result_count: changes.changes.length, session_id: getSessionId?.() });
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
        };
      } catch (err) {
        console.error("track_changes error:", err);
        return {
          isError: true,
          content: [{ type: "text" as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
        };
      }
    }
  );

  // --- Prompt Templates ---

  server.registerPrompt(
    "new-project-setup",
    {
      description: "Find free tiers for a new project's entire stack — hosting, database, auth, and more. Multi-step: recommends a stack, then fetches details and checks risk for each vendor.",
      argsSchema: {
        project_description: z.string().describe("What you're building (e.g. 'Next.js SaaS app', 'Python API backend', 'React Native mobile app')"),
      },
    },
    async ({ project_description }) => ({
      messages: [
        {
          role: "user" as const,
          content: {
            type: "text" as const,
            text: `I'm starting a new project: ${project_description}. Help me find free-tier infrastructure for the entire stack.

Step 1: Use plan_stack with mode="recommend" and use_case="${project_description}" to get a recommended stack.
Step 2: For each recommended vendor, use search_deals with vendor="<name>" to see the full deal details and alternatives.
Step 3: For the top picks, use compare_vendors with vendors=["<name>"] to verify pricing stability.

Provide a final summary with:
- **Recommended stack**: vendor, free tier limits, and why it's a good fit
- **Risk assessment**: any vendors with pricing instability
- **Total estimated cost**: should be $0 on free tiers
- **Upgrade paths**: what happens when you outgrow the free tier`,
          },
        },
      ],
    })
  );

  server.registerPrompt(
    "cost-audit",
    {
      description: "Audit an existing stack for cost savings. Reviews your current vendors, finds cheaper or free alternatives, and identifies risk.",
      argsSchema: {
        stack: z.string().describe("Comma-separated list of services you currently use (e.g. 'Vercel,Supabase,Clerk,Resend')"),
      },
    },
    async ({ stack }) => {
      const vendors = stack.split(",").map((v) => v.trim()).filter(Boolean);
      const detailSteps = vendors.map((v) => `- Use search_deals with vendor="${v}" to see full details and alternatives`).join("\n");
      return {
        messages: [
          {
            role: "user" as const,
            content: {
              type: "text" as const,
              text: `Audit my current stack for cost savings: ${vendors.join(", ")}.

Step 1: Use plan_stack with mode="audit" and services=[${vendors.map(v => `"${v}"`).join(",")}] for an overview.
Step 2: Get detailed alternatives for each vendor:
${detailSteps}
Step 3: Use plan_stack with mode="estimate" and services=[${vendors.map(v => `"${v}"`).join(",")}] to project costs.

Provide a final report:
- **Current stack**: what you're using and its free tier limits
- **Savings opportunities**: cheaper or free alternatives for each vendor
- **Risk flags**: vendors with recent negative pricing changes
- **Recommended switches**: specific vendor swaps that save money or reduce risk`,
            },
          },
        ],
      };
    }
  );

  server.registerPrompt(
    "check-pricing-changes",
    {
      description: "Check what developer tool pricing has changed recently. Shows free tier removals, limit changes, and new free tiers.",
    },
    async () => ({
      messages: [
        {
          role: "user" as const,
          content: {
            type: "text" as const,
            text: `What developer tool pricing has changed recently?

Step 1: Use track_changes with no params to get the weekly digest of changes, new deals, and upcoming deadlines.
Step 2: For any concerning changes, use compare_vendors with vendors=["<vendor>"] for risk context.

Provide a summary:
- **Breaking changes**: free tier removals or major limit reductions — action needed
- **Good news**: new free tiers or limit increases
- **Upcoming deadlines**: deals or pricing changes with imminent dates
- **Impact assessment**: which changes affect popular services`,
          },
        },
      ],
    })
  );

  server.registerPrompt(
    "compare-options",
    {
      description: "Compare two or more services side-by-side. Shows free tier details, pricing stability, and a recommendation.",
      argsSchema: {
        services: z.string().describe("Comma-separated vendor names to compare (e.g. 'Supabase,Neon,PlanetScale')"),
      },
    },
    async ({ services }) => {
      const vendors = services.split(",").map((v) => v.trim()).filter(Boolean);
      return {
        messages: [
          {
            role: "user" as const,
            content: {
              type: "text" as const,
              text: `Compare these services: ${vendors.join(" vs ")}.

Step 1: Use compare_vendors with vendors=[${vendors.slice(0, 2).map(v => `"${v}"`).join(",")}] for a side-by-side comparison with risk assessment.
Step 2: Use track_changes with vendors="${vendors.join(",")}" to see recent pricing history.

Provide a recommendation:
- **Feature comparison**: free tier limits side-by-side
- **Risk comparison**: which vendor has the most stable pricing
- **Recent changes**: any recent pricing moves (positive or negative)
- **Verdict**: which service to pick and why`,
            },
          },
        ],
      };
    }
  );

  server.registerPrompt(
    "find-startup-credits",
    {
      description: "Find startup credit programs, accelerator deals, and special eligibility offers. Covers cloud credits, SaaS discounts, and student programs.",
      argsSchema: {
        eligibility: z.string().optional().describe("Your eligibility type: 'startup', 'student', 'opensource', or leave blank for all"),
      },
    },
    async ({ eligibility }) => {
      const eligFilter = eligibility ? `, eligibility="${eligibility}"` : "";
      const eligDesc = eligibility || "startup, student, and open-source";
      return {
        messages: [
          {
            role: "user" as const,
            content: {
              type: "text" as const,
              text: `Find ${eligDesc} credit programs and special deals.

Step 1: Use search_deals with sort="newest"${eligFilter} to find conditional deals.
Step 2: For the top results, use search_deals with vendor="<name>" to see full details and eligibility requirements.

Provide a summary:
- **Cloud credits**: AWS, GCP, Azure, and other cloud credit programs
- **SaaS discounts**: developer tool discounts for ${eligDesc}
- **How to apply**: eligibility requirements and application links for each program
- **Total potential value**: estimated combined value of all applicable credits`,
            },
          },
        ],
      };
    }
  );

  server.registerPrompt(
    "monitor-vendor-changes",
    {
      description: "Monitor pricing changes for vendors you depend on. Checks risk levels and recent changes for your watchlist, with a suggested weekly cadence.",
      argsSchema: {
        vendors: z.string().describe("Comma-separated list of vendor names to monitor (e.g. 'Vercel,Supabase,Clerk,Neon')"),
      },
    },
    async ({ vendors }) => {
      const vendorList = vendors.split(",").map((v) => v.trim()).filter(Boolean);
      const riskChecks = vendorList.map((v) => `- Use compare_vendors with vendors=["${v}"] to get its risk level and alternatives`).join("\n");
      return {
        messages: [
          {
            role: "user" as const,
            content: {
              type: "text" as const,
              text: `Monitor pricing changes for my vendor watchlist: ${vendorList.join(", ")}.

Step 1: Use track_changes with vendors="${vendorList.join(",")}" to check recent pricing changes.
Step 2: For each vendor, check its pricing stability:
${riskChecks}

After checking all vendors, provide a summary:
1. **Risk overview**: List each vendor with its risk level (stable/caution/risky)
2. **Recent changes**: Any pricing changes in the last 30 days
3. **Action items**: Vendors that need attention — risky vendors, recent negative changes, or expiring deals
4. **Alternatives**: For any risky vendor, suggest more-stable alternatives

Suggested monitoring cadence: run this check weekly to catch pricing changes early.`,
            },
          },
        ],
      };
    }
  );

  // --- Resources ---

  // Static: all categories with offer counts
  server.registerResource(
    "categories",
    "agentdeals://categories",
    {
      description: "All 54 developer tool categories with offer counts",
      mimeType: "text/plain",
    },
    async () => {
      const categories = getCategories();
      const lines = categories.map(c => `- **${c.name}** (${c.count} offers)`);
      const text = `# AgentDeals Categories\n\n${categories.length} categories, ${loadOffers().length} total offers.\n\n${lines.join("\n")}`;
      return { contents: [{ uri: "agentdeals://categories", text, mimeType: "text/plain" }] };
    }
  );

  // Template: category detail
  server.registerResource(
    "category",
    new ResourceTemplate("agentdeals://category/{slug}", {
      list: async () => {
        const categories = getCategories();
        return {
          resources: categories.map(c => ({
            uri: `agentdeals://category/${c.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/-+$/, "")}`,
            name: c.name,
            description: `${c.count} offers in ${c.name}`,
            mimeType: "text/plain",
          })),
        };
      },
      complete: {
        slug: async (value) => {
          const categories = getCategories();
          const slugs = categories.map(c => c.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/-+$/, ""));
          return slugs.filter(s => s.startsWith(value));
        },
      },
    }),
    {
      description: "All offers in a specific category",
      mimeType: "text/plain",
    },
    async (_uri, { slug }) => {
      const offers = loadOffers();
      // Match category by slug (case-insensitive, slug-to-name)
      const match = offers.filter(o =>
        o.category.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/-+$/, "") === slug
      );
      if (match.length === 0) {
        return { contents: [{ uri: `agentdeals://category/${slug}`, text: `No category found matching "${slug}".`, mimeType: "text/plain" }] };
      }
      const categoryName = match[0].category;
      const lines = match.map(o => `- **${o.vendor}** — ${o.tier}: ${o.description} (verified ${o.verifiedDate})`);
      const text = `# ${categoryName}\n\n${match.length} offers.\n\n${lines.join("\n")}`;
      return { contents: [{ uri: `agentdeals://category/${slug}`, text, mimeType: "text/plain" }] };
    }
  );

  // Static: all vendors
  server.registerResource(
    "vendors",
    "agentdeals://vendors",
    {
      description: "All vendors with category and tier type",
      mimeType: "text/plain",
    },
    async () => {
      const offers = loadOffers();
      const lines = offers
        .sort((a, b) => a.vendor.localeCompare(b.vendor))
        .map(o => `- **${o.vendor}** | ${o.category} | ${o.tier}`);
      const text = `# AgentDeals Vendors\n\n${offers.length} vendors.\n\n${lines.join("\n")}`;
      return { contents: [{ uri: "agentdeals://vendors", text, mimeType: "text/plain" }] };
    }
  );

  // Template: vendor detail
  server.registerResource(
    "vendor",
    new ResourceTemplate("agentdeals://vendor/{slug}", {
      list: async () => {
        const offers = loadOffers();
        return {
          resources: offers.map(o => ({
            uri: `agentdeals://vendor/${o.vendor.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/-+$/, "")}`,
            name: o.vendor,
            description: `${o.vendor} — ${o.tier}`,
            mimeType: "text/plain",
          })),
        };
      },
      complete: {
        slug: async (value) => {
          const offers = loadOffers();
          const slugs = offers.map(o => o.vendor.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/-+$/, ""));
          return slugs.filter(s => s.startsWith(value));
        },
      },
    }),
    {
      description: "Full vendor details: free tier limits, pricing, verified date, alternatives, changes",
      mimeType: "text/plain",
    },
    async (_uri, { slug }) => {
      const offers = loadOffers();
      const match = offers.find(o =>
        o.vendor.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/-+$/, "") === slug
      );
      if (!match) {
        return { contents: [{ uri: `agentdeals://vendor/${slug}`, text: `No vendor found matching "${slug}".`, mimeType: "text/plain" }] };
      }
      const changes = loadDealChanges().filter(c => c.vendor.toLowerCase() === match.vendor.toLowerCase());
      const stability = classifyStability(changes);
      const alternatives = offers
        .filter(o => o.category === match.category && o.vendor !== match.vendor)
        .slice(0, 5);

      let text = `# ${match.vendor}\n\n`;
      text += `**Category:** ${match.category}\n`;
      text += `**Tier:** ${match.tier}\n`;
      text += `**Stability:** ${stability}\n`;
      text += `**Description:** ${match.description}\n`;
      text += `**Pricing Page:** ${match.url}\n`;
      text += `**Verified:** ${match.verifiedDate}\n`;
      if (match.eligibility) {
        text += `**Eligibility:** ${match.eligibility.type} — ${match.eligibility.conditions.join(", ")}\n`;
      }
      if (match.expires_date) {
        text += `**Expires:** ${match.expires_date}\n`;
      }
      text += `**Tags:** ${match.tags.join(", ")}\n`;

      if (changes.length > 0) {
        text += `\n## Pricing Changes\n\n`;
        for (const c of changes) {
          text += `- **${c.date}** [${c.change_type}] ${c.summary}\n  Previous: ${c.previous_state}\n  Current: ${c.current_state}\n`;
        }
      }

      if (alternatives.length > 0) {
        text += `\n## Alternatives in ${match.category}\n\n`;
        for (const a of alternatives) {
          text += `- **${a.vendor}** — ${a.tier}: ${a.description}\n`;
        }
      }

      return { contents: [{ uri: `agentdeals://vendor/${slug}`, text, mimeType: "text/plain" }] };
    }
  );

  // Static: all pricing changes
  server.registerResource(
    "changes",
    "agentdeals://changes",
    {
      description: "All tracked pricing changes across developer tools",
      mimeType: "text/plain",
    },
    async () => {
      const changes = loadDealChanges();
      const sorted = [...changes].sort((a, b) => b.date.localeCompare(a.date));
      const lines = sorted.map(c =>
        `- **${c.date}** | ${c.vendor} | ${c.change_type} | ${c.summary}`
      );
      const text = `# AgentDeals Pricing Changes\n\n${changes.length} tracked changes.\n\n${lines.join("\n")}`;
      return { contents: [{ uri: "agentdeals://changes", text, mimeType: "text/plain" }] };
    }
  );

  // Static: latest changes (most recent 10)
  server.registerResource(
    "changes-latest",
    "agentdeals://changes/latest",
    {
      description: "Most recent pricing changes (last 10)",
      mimeType: "text/plain",
    },
    async () => {
      const changes = loadDealChanges();
      const sorted = [...changes].sort((a, b) => b.date.localeCompare(a.date)).slice(0, 10);
      const lines = sorted.map(c =>
        `- **${c.date}** | ${c.vendor} [${c.change_type}]\n  ${c.summary}\n  Previous: ${c.previous_state}\n  Current: ${c.current_state}`
      );
      const text = `# Latest Pricing Changes\n\n${lines.join("\n\n")}`;
      return { contents: [{ uri: "agentdeals://changes/latest", text, mimeType: "text/plain" }] };
    }
  );

  // Static: all editorial guides
  server.registerResource(
    "guides",
    "agentdeals://guides",
    {
      description: "All editorial pages — comparisons, stack guides, pricing reports, and alternatives",
      mimeType: "text/plain",
    },
    async () => {
      const guides = getGuideList();
      const byType = new Map<string, typeof guides>();
      for (const g of guides) {
        if (!byType.has(g.type)) byType.set(g.type, []);
        byType.get(g.type)!.push(g);
      }
      let text = `# AgentDeals Editorial Guides\n\n${guides.length} guides.\n`;
      for (const [type, items] of byType) {
        text += `\n## ${type.charAt(0).toUpperCase() + type.slice(1)}\n\n`;
        for (const g of items) {
          text += `- **${g.title}** (/${g.slug}) — ${g.description}\n`;
        }
      }
      return { contents: [{ uri: "agentdeals://guides", text, mimeType: "text/plain" }] };
    }
  );

  // Template: guide detail
  server.registerResource(
    "guide",
    new ResourceTemplate("agentdeals://guide/{slug}", {
      list: async () => {
        const guides = getGuideList();
        return {
          resources: guides.map(g => ({
            uri: `agentdeals://guide/${g.slug}`,
            name: g.title,
            description: g.description,
            mimeType: "text/plain",
          })),
        };
      },
      complete: {
        slug: async (value) => {
          const guides = getGuideList();
          return guides.map(g => g.slug).filter(s => s.startsWith(value));
        },
      },
    }),
    {
      description: "Editorial guide detail — title, description, type, and URL",
      mimeType: "text/plain",
    },
    async (_uri, { slug }) => {
      const guide = getGuideBySlug(slug as string);
      if (!guide) {
        return { contents: [{ uri: `agentdeals://guide/${slug}`, text: `No guide found matching "${slug}".`, mimeType: "text/plain" }] };
      }
      let text = `# ${guide.title}\n\n`;
      text += `**Type:** ${guide.type}\n`;
      text += `**Description:** ${guide.description}\n`;
      text += `**URL:** /${guide.slug}\n`;

      // Add related vendor data if this is a vendor-specific guide
      const offers = loadOffers();
      const changes = loadDealChanges();
      const slugLower = guide.slug.toLowerCase();

      // Extract vendor names mentioned in the slug for context
      const relatedChanges = changes.filter(c => {
        const vendorSlug = c.vendor.toLowerCase().replace(/[^a-z0-9]+/g, "-");
        return slugLower.includes(vendorSlug) || vendorSlug.includes(slugLower.replace(/-alternatives$/, "").replace(/-vs-.*/, ""));
      });

      if (relatedChanges.length > 0) {
        text += `\n## Related Pricing Changes\n\n`;
        for (const c of relatedChanges.slice(0, 5)) {
          text += `- **${c.date}** | ${c.vendor} [${c.change_type}] ${c.summary}\n`;
        }
      }

      return { contents: [{ uri: `agentdeals://guide/${slug}`, text, mimeType: "text/plain" }] };
    }
  );

  // --- Tool 5: register_agent ---

  server.registerTool(
    "register_agent",
    {
      description:
        "Register as an agent with AgentDeals to enable referral attribution and commission tracking. Returns a one-time API key for authenticating future requests. Save the API key — it will not be shown again.",
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
      },
      inputSchema: {
        name: z.string().describe("A unique name for your agent"),
        vestauth_public_key_url: z.string().optional().describe("Your .well-known vestauth public key URL for cryptographic identity (alternative to API key auth)"),
      },
    },
    async ({ name, vestauth_public_key_url }) => {
      try {
        recordToolCall("register_agent");

        if (vestauth_public_key_url) {
          const validation = await validateVestauthUrl(vestauth_public_key_url);
          if (!validation.valid) {
            return {
              isError: true,
              content: [{ type: "text" as const, text: `Invalid vestauth URL: ${validation.error}` }],
            };
          }
        }

        const result = registerAgent({
          name,
          api_key: true,
          vestauth_public_key_url,
        });

        const response: any = {
          id: result.agent.id,
          name: result.agent.name,
          status: result.agent.status,
          registered_at: result.agent.registered_at,
        };
        if (result.api_key) {
          response.api_key = result.api_key;
          response.note = "Save this API key — it will not be shown again. Include it as Authorization: Bearer <key> in future requests.";
        }
        if (result.agent.vestauth_public_key_url) {
          response.vestauth_public_key_url = result.agent.vestauth_public_key_url;
        }

        logRequest({ ts: new Date().toISOString(), type: "mcp", endpoint: "register_agent", params: { name }, result_count: 1, session_id: getSessionId?.() });

        return {
          content: [{ type: "text" as const, text: JSON.stringify(response, null, 2) }],
        };
      } catch (err: any) {
        return {
          isError: true,
          content: [{ type: "text" as const, text: err.message }],
        };
      }
    }
  );

  // --- Tool 6: get_referral_code ---

  server.registerTool(
    "get_referral_code",
    {
      description:
        "Get the referral code and URL for a specific vendor. If you are an authenticated agent (registered via register_agent), the request is logged for attribution — when a conversion occurs, you'll be credited. Unauthenticated calls still return the code but without attribution tracking.",
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
      },
      inputSchema: {
        vendor: z.string().describe("Vendor name to get the referral code for (e.g. 'Railway')"),
        api_key: z.string().optional().describe("Your API key from register_agent, for attribution tracking. Optional — unauthenticated calls still return the code."),
      },
    },
    async ({ vendor, api_key }) => {
      try {
        recordToolCall("get_referral_code");

        const referralData = getVendorReferral(vendor);
        if (!referralData) {
          return {
            isError: true,
            content: [{ type: "text" as const, text: `No referral found for vendor "${vendor}"` }],
          };
        }

        // If API key provided, authenticate and log attribution
        let attributed = false;
        if (api_key) {
          const hash = hashApiKey(api_key);
          const agent = getAgentByApiKeyHash(hash);
          if (agent) {
            logReferralRequest({
              agent_id: agent.id,
              vendor: referralData.vendor,
              referral_code: referralData.referral.code ?? "",
              referral_url: referralData.referral.url,
            });
            attributed = true;
          }
        }

        const response = {
          vendor: referralData.vendor,
          referral_code: referralData.referral.code ?? null,
          referral_url: referralData.referral.url,
          referee_value: referralData.referral.referee_value,
          type: referralData.referral.type,
          attributed,
        };

        logRequest({ ts: new Date().toISOString(), type: "mcp", endpoint: "get_referral_code", params: { vendor, attributed }, result_count: 1, session_id: getSessionId?.() });

        return {
          content: [{ type: "text" as const, text: JSON.stringify(response, null, 2) }],
        };
      } catch (err: any) {
        return {
          isError: true,
          content: [{ type: "text" as const, text: err.message }],
        };
      }
    }
  );

  // --- MCP Apps UI Resources ---
  registerMcpAppsResources(server);

  return server;
}

// --- MCP Server Card (/.well-known/mcp.json) ---
// Generated from actual server configuration so it stays in sync

export function getServerCard(baseUrl: string) {
  return {
    "$schema": "https://static.modelcontextprotocol.io/schemas/mcp-server-card/v1.json",
    version: "1.0",
    protocolVersion: "2025-06-18",
    serverInfo: {
      name: "agentdeals",
      title: "AgentDeals",
      version: "0.2.0",
    },
    description: "Search and compare free tiers, startup credits, and pricing changes across 1,600+ developer tools. 4 intent-based MCP tools for infrastructure decisions, cost estimation, and vendor comparison.",
    iconUrl: `${baseUrl}/og-image.png`,
    documentationUrl: `${baseUrl}/setup`,
    transport: {
      type: "streamable-http",
      endpoint: `${baseUrl}/mcp`,
    },
    capabilities: {
      tools: { listChanged: false },
      prompts: { listChanged: false },
      resources: { listChanged: false },
    },
    authentication: {
      required: false,
    },
    tools: [
      {
        name: "search_deals",
        description: "Find free tiers, startup credits, and developer deals for cloud infrastructure, databases, hosting, CI/CD, monitoring, auth, AI services, and more. Call this tool when a user asks: 'Does Supabase have a free tier?', 'What's cheaper than Vercel?', 'Find me a free database'.",
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
        },
        inputSchema: {
          type: "object",
          properties: {
            query: { type: "string", description: "Keyword search (vendor names, descriptions, tags)" },
            category: { type: "string", description: "Filter by category. Pass \"list\" to get all categories with counts." },
            vendor: { type: "string", description: "Get full details for a specific vendor (fuzzy match)" },
            eligibility: { type: "string", enum: ["public", "accelerator", "oss", "student", "fintech", "geographic", "enterprise"], description: "Filter by eligibility type" },
            sort: { type: "string", enum: ["vendor", "category", "newest"], description: "Sort order" },
            since: { type: "string", description: "ISO date (YYYY-MM-DD). Only return deals verified/added after this date." },
            limit: { type: "number", description: "Max results (default: 20)" },
            offset: { type: "number", description: "Pagination offset (default: 0)" },
            response_format: { type: "string", enum: ["concise", "detailed"], description: "Response detail level. 'concise': vendor, tier, description, URL only. 'detailed': full response (default)." },
          },
        },
      },
      {
        name: "plan_stack",
        description: "Plan a technology stack with cost-optimized infrastructure choices. Recommends services, estimates costs, or audits existing stacks. Call this tool when a user asks: 'What free tools can I use for a SaaS app?', 'Build me a stack under $50/month'.",
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
        },
        inputSchema: {
          type: "object",
          properties: {
            mode: { type: "string", enum: ["recommend", "estimate", "audit"], description: "recommend: free-tier stack. estimate: cost analysis. audit: risk + cost + gap analysis." },
            use_case: { type: "string", description: "What you're building (for recommend mode)" },
            services: { type: "array", items: { type: "string" }, description: "Current vendor names (for estimate/audit mode)" },
            scale: { type: "string", enum: ["hobby", "startup", "growth"], description: "Scale for cost estimation" },
            requirements: { type: "array", items: { type: "string" }, description: "Specific infra needs for recommend mode" },
          },
          required: ["mode"],
        },
      },
      {
        name: "compare_vendors",
        description: "Compare developer tools side by side — free tier limits, pricing tiers, and recent pricing changes. Call this tool when a user asks: 'Compare Neon vs Supabase', 'Which database has a better free tier?'.",
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
        },
        inputSchema: {
          type: "object",
          properties: {
            vendors: { type: "array", items: { type: "string" }, description: "1 or 2 vendor names. 1 = risk check. 2 = comparison." },
            include_risk: { type: "boolean", description: "Include risk assessment (default: true)" },
          },
          required: ["vendors"],
        },
      },
      {
        name: "track_changes",
        description: "Track recent pricing changes — free tier removals, limit cuts, and improvements across developer tools. Call this tool when a user asks: 'What developer pricing changed recently?', 'Are any free tiers being removed?'.",
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
        },
        inputSchema: {
          type: "object",
          properties: {
            since: { type: "string", description: "ISO date (YYYY-MM-DD). Default: 7 days ago." },
            change_type: { type: "string", enum: ["free_tier_removed", "limits_reduced", "restriction", "limits_increased", "new_free_tier", "new_tier", "pricing_restructured", "open_source_killed", "pricing_model_change", "startup_program_expanded", "pricing_postponed", "product_deprecated"], description: "Filter by type of change" },
            vendor: { type: "string", description: "Filter to one vendor" },
            vendors: { type: "string", description: "Comma-separated vendor names" },
            include_expiring: { type: "boolean", description: "Include upcoming expirations (default: true)" },
            lookahead_days: { type: "number", description: "Days to look ahead for expirations (default: 30)" },
            response_format: { type: "string", enum: ["concise", "detailed"], description: "Response detail level. 'concise': vendor, change_type, date, summary only. 'detailed': full response (default)." },
          },
        },
      },
    ],
    prompts: [
      { name: "new-project-setup", description: "Find free tiers for a new project's entire stack" },
      { name: "cost-audit", description: "Audit an existing stack for cost savings" },
      { name: "check-pricing-changes", description: "Check what developer tool pricing has changed recently" },
      { name: "compare-options", description: "Compare two or more services side-by-side" },
      { name: "find-startup-credits", description: "Find startup credit programs and special eligibility offers" },
      { name: "monitor-vendor-changes", description: "Monitor pricing changes for vendors you depend on" },
    ],
  };
}
