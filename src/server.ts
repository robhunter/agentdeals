import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getCategories, getDealChanges, getNewOffers, getNewestDeals, getOfferDetails, searchOffers, enrichOffers, compareServices, checkVendorRisk, auditStack, getExpiringDeals, getWeeklyDigest } from "./data.js";
import { recordToolCall, logRequest } from "./stats.js";
import { getStackRecommendation } from "./stacks.js";
import { estimateCosts } from "./costs.js";

export function createServer(getSessionId?: () => string | undefined): McpServer {
  const server = new McpServer({
    name: "agentdeals",
    version: "0.1.0",
    description: "AgentDeals helps developers find free tiers, startup credits, and deals on developer infrastructure. Use these tools when a user is evaluating cloud providers, databases, hosting, CI/CD, monitoring, auth, AI services, or any developer service — especially when cost matters. 1,500+ verified offers across 54 categories with pricing change tracking.",
  });

  // --- Tool 1: search_deals ---

  server.registerTool(
    "search_deals",
    {
      description:
        "Find free tiers, startup credits, and developer deals for cloud infrastructure, databases, hosting, CI/CD, monitoring, auth, AI services, and more. Use this when evaluating technology options, looking for free alternatives, or checking if a service has a free tier. Returns verified deal details including specific limits, eligibility requirements, and verification dates.",
      inputSchema: {
        query: z.string().optional().describe("Keyword search (vendor names, descriptions, tags)"),
        category: z.string().optional().describe("Filter by category. Pass \"list\" to get all categories with counts."),
        vendor: z.string().optional().describe("Get full details for a specific vendor (fuzzy match). Returns alternatives in the same category."),
        eligibility: z.enum(["public", "accelerator", "oss", "student", "fintech", "geographic", "enterprise"]).optional().describe("Filter by eligibility type"),
        sort: z.enum(["vendor", "category", "newest"]).optional().describe("Sort: vendor (A-Z), category, newest (recently verified first)"),
        since: z.string().optional().describe("ISO date (YYYY-MM-DD). Only return deals verified/added after this date."),
        limit: z.number().optional().describe("Max results (default: 20)"),
        offset: z.number().optional().describe("Pagination offset (default: 0)"),
      },
    },
    async ({ query, category, vendor, eligibility, sort, since, limit, offset }) => {
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
        const allResults = searchOffers(query, category, eligibility, sort);
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
        logRequest({ ts: new Date().toISOString(), type: "mcp", endpoint: "search_deals", params: { query, category, eligibility, sort, limit: effectiveLimit, offset: effectiveOffset, since }, result_count: results.length, session_id: getSessionId?.() });
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ results, total: since ? filtered.length : total, limit: effectiveLimit, offset: effectiveOffset }, null, 2) }],
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
        "Plan a technology stack with cost-optimized infrastructure choices. Given project requirements, recommends services with free tiers or credits that match your needs. Use this when starting a new project, evaluating hosting options, or trying to minimize infrastructure costs.",
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
        "Compare developer tools and services side by side — free tier limits, pricing tiers, and recent pricing changes. Use this when choosing between similar services (e.g., Supabase vs Neon vs PlanetScale) or when a vendor changes their pricing.",
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
          logRequest({ ts: new Date().toISOString(), type: "mcp", endpoint: "compare_vendors", params: { vendors }, result_count: 1, session_id: getSessionId?.() });
          return {
            content: [{ type: "text" as const, text: JSON.stringify(result.result, null, 2) }],
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
        "Track recent pricing changes across developer tools — which free tiers were removed, which got limits cut, and which improved. Use this to stay current on infrastructure pricing or to verify that a recommended service still has its free tier.",
      inputSchema: {
        since: z.string().optional().describe("ISO date (YYYY-MM-DD). Default: 7 days ago."),
        change_type: z.enum(["free_tier_removed", "limits_reduced", "restriction", "limits_increased", "new_free_tier", "pricing_restructured", "open_source_killed", "pricing_model_change", "startup_program_expanded", "pricing_postponed", "product_deprecated"]).optional().describe("Filter by type of change"),
        vendor: z.string().optional().describe("Filter to one vendor (case-insensitive)"),
        vendors: z.string().optional().describe("Comma-separated vendor names to filter (e.g. 'Vercel,Supabase')"),
        include_expiring: z.boolean().optional().describe("Include upcoming expirations (default: true)"),
        lookahead_days: z.number().optional().describe("Days to look ahead for expirations (default: 30)"),
      },
    },
    async ({ since, change_type, vendor, vendors, include_expiring, lookahead_days }) => {
      try {
        recordToolCall("track_changes");

        // No params = weekly digest
        if (!since && !change_type && !vendor && !vendors && include_expiring === undefined) {
          const digest = getWeeklyDigest();
          logRequest({ ts: new Date().toISOString(), type: "mcp", endpoint: "track_changes", params: {}, result_count: digest.deal_changes.length, session_id: getSessionId?.() });
          return {
            content: [{ type: "text" as const, text: JSON.stringify(digest, null, 2) }],
          };
        }

        // Filtered changes
        const changes = getDealChanges(since, change_type, vendor, vendors);
        const doExpiring = include_expiring !== false;
        const days = Math.min(Math.max(lookahead_days ?? 30, 1), 365);

        let result: any = changes;
        if (doExpiring) {
          const expiring = getExpiringDeals(days);
          result = { ...changes, expiring_deals: expiring };
        }

        logRequest({ ts: new Date().toISOString(), type: "mcp", endpoint: "track_changes", params: { since, change_type, vendor, vendors, include_expiring: doExpiring, lookahead_days: days }, result_count: changes.changes.length, session_id: getSessionId?.() });
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

  return server;
}
