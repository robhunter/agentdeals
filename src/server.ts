import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getCategories, getDealChanges, getNewOffers, getNewestDeals, getOfferDetails, searchOffers, enrichOffers, compareServices, checkVendorRisk, auditStack, getExpiringDeals } from "./data.js";
import { recordToolCall, logRequest } from "./stats.js";
import { getStackRecommendation } from "./stacks.js";
import { estimateCosts } from "./costs.js";

export function createServer(getSessionId?: () => string | undefined): McpServer {
  const server = new McpServer({
    name: "agentdeals",
    version: "0.1.0",
    description: "Find free tiers, startup credits, and discounts for developer tools — databases, cloud hosting, CI/CD, monitoring, APIs, and more. 1,500+ verified offers across 52 categories with pricing change tracking.",
  });

  server.registerTool(
    "list_categories",
    {
      description:
        "Browse 52 categories of developer infrastructure deals (databases, cloud hosting, CI/CD, monitoring, auth, search, and more). Call this first to see what's available before searching.",
    },
    async () => {
      try {
        recordToolCall("list_categories");
        const categories = getCategories();
        logRequest({ ts: new Date().toISOString(), type: "mcp", endpoint: "list_categories", params: {}, result_count: categories.length, session_id: getSessionId?.() });
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(categories, null, 2),
            },
          ],
        };
      } catch (err) {
        console.error("list_categories error:", err);
        return {
          isError: true,
          content: [
            {
              type: "text" as const,
              text: `Error listing categories: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
        };
      }
    }
  );

  server.registerTool(
    "search_offers",
    {
      description:
        "Find free tiers, credits, and discounts for developer tools. Use when choosing infrastructure for a new project, comparing vendor pricing, or finding cost savings. Covers 1,500+ offers from vendors like AWS, Vercel, Supabase, Cloudflare, and more. Supports filtering by category, eligibility (public, startup, OSS, student), and sorting by recency.",
      inputSchema: {
        query: z.string().optional().describe("Keyword to search for in vendor names, descriptions, and tags"),
        category: z.string().optional().describe("Filter results to a specific category (e.g. 'Databases', 'Cloud Hosting')"),
        eligibility_type: z.enum(["public", "accelerator", "oss", "student", "fintech", "geographic", "enterprise"]).optional().describe("Filter by eligibility type: public, accelerator, oss, student, fintech, geographic, enterprise"),
        sort: z.enum(["vendor", "category", "newest"]).optional().describe("Sort results: vendor (alphabetical by vendor name), category (by category then vendor), newest (most recently verified first)"),
        limit: z.number().optional().describe("Maximum results to return (default: all results, or 20 when offset is provided)"),
        offset: z.number().optional().describe("Number of results to skip (default: 0)"),
      },
    },
    async ({ query, category, eligibility_type, sort, limit, offset }) => {
      try {
        recordToolCall("search_offers");
        const allResults = searchOffers(query, category, eligibility_type, sort);
        const total = allResults.length;
        const usePagination = limit !== undefined || offset !== undefined;
        const effectiveOffset = offset ?? 0;
        const effectiveLimit = limit ?? (usePagination ? 20 : total);
        const paged = allResults.slice(effectiveOffset, effectiveOffset + effectiveLimit);
        const results = enrichOffers(paged);
        logRequest({ ts: new Date().toISOString(), type: "mcp", endpoint: "search_offers", params: { query, category, eligibility_type, sort, limit: effectiveLimit, offset: effectiveOffset }, result_count: results.length, session_id: getSessionId?.() });
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ results, total, limit: effectiveLimit, offset: effectiveOffset }, null, 2),
            },
          ],
        };
      } catch (err) {
        console.error("search_offers error:", err);
        return {
          isError: true,
          content: [
            {
              type: "text" as const,
              text: `Error searching offers: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
        };
      }
    }
  );

  server.registerTool(
    "get_offer_details",
    {
      description:
        "Get full pricing details for a specific vendor's free tier or deal. Use include_alternatives to compare up to 5 similar vendors in the same category — ideal for recommending alternatives or evaluating options.",
      inputSchema: {
        vendor: z.string().describe("Vendor name (case-insensitive match)"),
        include_alternatives: z.boolean().optional().describe("When true, includes full deal objects for up to 5 alternative vendors in the same category"),
      },
    },
    async ({ vendor, include_alternatives }) => {
      try {
        recordToolCall("get_offer_details");
        const result = getOfferDetails(vendor, include_alternatives ?? false);
        if ("error" in result) {
          const msg = result.suggestions.length > 0
            ? `${result.error} Did you mean: ${result.suggestions.join(", ")}?`
            : `${result.error} No similar vendors found.`;
          logRequest({ ts: new Date().toISOString(), type: "mcp", endpoint: "get_offer_details", params: { vendor, include_alternatives }, result_count: 0, session_id: getSessionId?.() });
          return {
            isError: true,
            content: [{ type: "text" as const, text: msg }],
          };
        }
        logRequest({ ts: new Date().toISOString(), type: "mcp", endpoint: "get_offer_details", params: { vendor, include_alternatives }, result_count: 1, session_id: getSessionId?.() });
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(result.offer, null, 2),
            },
          ],
        };
      } catch (err) {
        console.error("get_offer_details error:", err);
        return {
          isError: true,
          content: [
            {
              type: "text" as const,
              text: `Error getting offer details: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
        };
      }
    }
  );

  server.registerTool(
    "get_new_offers",
    {
      description:
        "Check what developer tool deals were recently added or updated. Returns offers verified within the last N days, sorted newest first. Use for periodic checks to stay current on new free tiers and credits.",
      inputSchema: {
        days: z.number().optional().describe("Number of days to look back (default: 7, max: 30)"),
      },
    },
    async ({ days }) => {
      try {
        recordToolCall("get_new_offers");
        const result = getNewOffers(days ?? 7);
        logRequest({ ts: new Date().toISOString(), type: "mcp", endpoint: "get_new_offers", params: { days: days ?? 7 }, result_count: result.offers.length, session_id: getSessionId?.() });
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      } catch (err) {
        console.error("get_new_offers error:", err);
        return {
          isError: true,
          content: [
            {
              type: "text" as const,
              text: `Error getting new offers: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
        };
      }
    }
  );

  server.registerTool(
    "get_newest_deals",
    {
      description:
        "See what's new in the AgentDeals index. Returns deals sorted by verified date (newest first), with days_since_update for each result. Use for periodic 'what's new' checks — pairs with monitor-vendor-changes prompt for a complete recurring usage loop.",
      inputSchema: {
        since: z.string().optional().describe("ISO date string (YYYY-MM-DD). Only return deals verified/added after this date. Default: 30 days ago"),
        limit: z.number().optional().describe("Max results to return (default: 20, max: 50)"),
        category: z.string().optional().describe("Filter by category name"),
      },
    },
    async ({ since, limit, category }) => {
      try {
        recordToolCall("get_newest_deals");
        const result = getNewestDeals({ since, limit, category });
        logRequest({ ts: new Date().toISOString(), type: "mcp", endpoint: "get_newest_deals", params: { since, limit, category }, result_count: result.total, session_id: getSessionId?.() });
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      } catch (err) {
        console.error("get_newest_deals error:", err);
        return {
          isError: true,
          content: [
            {
              type: "text" as const,
              text: `Error getting newest deals: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
        };
      }
    }
  );

  server.registerTool(
    "get_deal_changes",
    {
      description:
        "Check which developer tools recently changed their pricing or free tiers. Tracks removals, limit reductions, limit increases, new free tiers, and restructures. Use when advising on vendor lock-in risk or staying current on pricing shifts.",
      inputSchema: {
        since: z.string().optional().describe("ISO date string (YYYY-MM-DD). Only return changes on or after this date. Default: 30 days ago"),
        change_type: z.enum(["free_tier_removed", "limits_reduced", "limits_increased", "new_free_tier", "pricing_restructured", "open_source_killed", "pricing_model_change", "startup_program_expanded", "pricing_postponed", "product_deprecated"]).optional().describe("Filter by type of change"),
        vendor: z.string().optional().describe("Filter by vendor name (case-insensitive partial match)"),
      },
    },
    async ({ since, change_type, vendor }) => {
      try {
        recordToolCall("get_deal_changes");
        const result = getDealChanges(since, change_type, vendor);
        logRequest({ ts: new Date().toISOString(), type: "mcp", endpoint: "get_deal_changes", params: { since, change_type, vendor }, result_count: result.changes.length, session_id: getSessionId?.() });
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      } catch (err) {
        console.error("get_deal_changes error:", err);
        return {
          isError: true,
          content: [
            {
              type: "text" as const,
              text: `Error getting deal changes: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
        };
      }
    }
  );

  server.registerTool(
    "get_stack_recommendation",
    {
      description:
        "Get a complete free-tier infrastructure stack recommendation for your project. Instead of searching category by category, describe what you're building and get a curated stack with hosting, database, auth, and more — all free tier. Covers SaaS apps, API backends, static sites, mobile apps, AI/ML projects, e-commerce, and DevOps.",
      inputSchema: {
        use_case: z.string().describe("What you're building (e.g., 'Next.js SaaS app', 'Python API backend', 'static blog', 'mobile app', 'AI chatbot')"),
        requirements: z.array(z.string()).optional().describe("Specific infrastructure needs to include (e.g., ['database', 'auth', 'email', 'monitoring']). Overrides template defaults when provided."),
      },
    },
    async ({ use_case, requirements }) => {
      try {
        recordToolCall("get_stack_recommendation");
        const result = getStackRecommendation(use_case, requirements);
        logRequest({ ts: new Date().toISOString(), type: "mcp", endpoint: "get_stack_recommendation", params: { use_case, requirements }, result_count: result.stack.length, session_id: getSessionId?.() });
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      } catch (err) {
        console.error("get_stack_recommendation error:", err);
        return {
          isError: true,
          content: [
            {
              type: "text" as const,
              text: `Error getting stack recommendation: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
        };
      }
    }
  );

  server.registerTool(
    "estimate_costs",
    {
      description:
        "Estimate infrastructure costs for your current stack at different scales. Pass the vendor names you're using (e.g. Vercel, Supabase, Clerk) and a scale (hobby/startup/growth) to get per-service cost analysis, free tier limits, free alternatives, and warnings about recent pricing changes. Use during project planning, code reviews, or deployment setup.",
      inputSchema: {
        services: z.array(z.string()).describe("Vendor names to analyze (e.g. ['Vercel', 'Supabase', 'Clerk'])"),
        scale: z.enum(["hobby", "startup", "growth"]).optional().describe("Scale: hobby (free tiers), startup (some paid), growth (mostly paid). Default: hobby"),
      },
    },
    async ({ services, scale }) => {
      try {
        recordToolCall("estimate_costs");
        const result = estimateCosts(services, scale ?? "hobby");
        logRequest({ ts: new Date().toISOString(), type: "mcp", endpoint: "estimate_costs", params: { services, scale: scale ?? "hobby" }, result_count: result.services.length, session_id: getSessionId?.() });
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      } catch (err) {
        console.error("estimate_costs error:", err);
        return {
          isError: true,
          content: [
            {
              type: "text" as const,
              text: `Error estimating costs: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
        };
      }
    }
  );

  server.registerTool(
    "compare_services",
    {
      description:
        "Compare two developer tool vendors side by side. Returns free tier limits, pricing tiers, key differentiators, and recent deal changes for both. Use when deciding between two options (e.g., Supabase vs Neon, Vercel vs Netlify).",
      inputSchema: {
        vendor_a: z.string().describe("First vendor name (case-insensitive, fuzzy match supported)"),
        vendor_b: z.string().describe("Second vendor name (case-insensitive, fuzzy match supported)"),
      },
    },
    async ({ vendor_a, vendor_b }) => {
      try {
        recordToolCall("compare_services");
        const result = compareServices(vendor_a, vendor_b);
        if ("error" in result) {
          logRequest({ ts: new Date().toISOString(), type: "mcp", endpoint: "compare_services", params: { vendor_a, vendor_b }, result_count: 0, session_id: getSessionId?.() });
          return {
            isError: true,
            content: [{ type: "text" as const, text: result.error }],
          };
        }
        logRequest({ ts: new Date().toISOString(), type: "mcp", endpoint: "compare_services", params: { vendor_a, vendor_b }, result_count: 2, session_id: getSessionId?.() });
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(result.comparison, null, 2),
            },
          ],
        };
      } catch (err) {
        console.error("compare_services error:", err);
        return {
          isError: true,
          content: [
            {
              type: "text" as const,
              text: `Error comparing services: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
        };
      }
    }
  );

  server.registerTool(
    "check_vendor_risk",
    {
      description:
        "Before depending on a vendor's free tier, check if their pricing is stable. Returns risk level (stable/caution/risky), pricing change history, free tier longevity, and more-stable alternatives. We track 52+ real pricing changes — use this to avoid vendors that have broken trust.",
      inputSchema: {
        vendor: z.string().describe("Vendor name to check (case-insensitive, fuzzy match supported)"),
      },
    },
    async ({ vendor }) => {
      try {
        recordToolCall("check_vendor_risk");
        const result = checkVendorRisk(vendor);
        if ("error" in result) {
          logRequest({ ts: new Date().toISOString(), type: "mcp", endpoint: "check_vendor_risk", params: { vendor }, result_count: 0, session_id: getSessionId?.() });
          return {
            isError: true,
            content: [{ type: "text" as const, text: result.error }],
          };
        }
        logRequest({ ts: new Date().toISOString(), type: "mcp", endpoint: "check_vendor_risk", params: { vendor }, result_count: 1, session_id: getSessionId?.() });
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(result.result, null, 2),
            },
          ],
        };
      } catch (err) {
        console.error("check_vendor_risk error:", err);
        return {
          isError: true,
          content: [
            {
              type: "text" as const,
              text: `Error checking vendor risk: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
        };
      }
    }
  );

  server.registerTool(
    "audit_stack",
    {
      description:
        "Audit your current infrastructure stack for cost savings, pricing risks, and missing capabilities. Pass the services you use today. Returns per-service risk assessment, cheaper alternatives, gap analysis for common categories (databases, hosting, CI/CD, auth, monitoring, logging, email, search, feature flags), and actionable recommendations.",
      inputSchema: {
        services: z.array(z.string()).describe("Vendor/service names you currently use (e.g. ['Vercel', 'Supabase', 'Clerk', 'Datadog'])"),
      },
    },
    async ({ services }) => {
      try {
        recordToolCall("audit_stack");
        const result = auditStack(services);
        logRequest({ ts: new Date().toISOString(), type: "mcp", endpoint: "audit_stack", params: { services }, result_count: result.services_analyzed, session_id: getSessionId?.() });
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      } catch (err) {
        console.error("audit_stack error:", err);
        return {
          isError: true,
          content: [
            {
              type: "text" as const,
              text: `Error auditing stack: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
        };
      }
    }
  );

  server.registerTool(
    "get_expiring_deals",
    {
      description:
        "Check which developer tool deals, free tiers, or credits are expiring soon. Use to avoid service disruptions and find replacements before deadlines.",
      inputSchema: {
        within_days: z.number().optional().describe("Number of days to look ahead (default: 30, max: 365)"),
      },
    },
    async ({ within_days }) => {
      try {
        recordToolCall("get_expiring_deals");
        const days = Math.min(Math.max(within_days ?? 30, 1), 365);
        const result = getExpiringDeals(days);
        logRequest({ ts: new Date().toISOString(), type: "mcp", endpoint: "get_expiring_deals", params: { within_days: days }, result_count: result.total, session_id: getSessionId?.() });
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      } catch (err) {
        console.error("get_expiring_deals error:", err);
        return {
          isError: true,
          content: [
            {
              type: "text" as const,
              text: `Error getting expiring deals: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
        };
      }
    }
  );

  // --- Prompt Templates ---

  server.registerPrompt(
    "find-free-alternative",
    {
      description: "Find free alternatives to a specific vendor. Returns the vendor's current deal plus up to 5 alternatives in the same category.",
      argsSchema: {
        vendor: z.string().describe("The vendor name to find alternatives for (e.g. 'Heroku', 'Firebase', 'Auth0')"),
      },
    },
    async ({ vendor }) => ({
      messages: [
        {
          role: "user" as const,
          content: {
            type: "text" as const,
            text: `Find free alternatives to ${vendor}. Use the get_offer_details tool with vendor="${vendor}" and include_alternatives=true to get the vendor's current deal and up to 5 alternatives in the same category.`,
          },
        },
      ],
    })
  );

  server.registerPrompt(
    "recommend-stack",
    {
      description: "Get a recommended free-tier infrastructure stack for a project. Returns hosting, database, auth, and more — all free tier.",
      argsSchema: {
        project_description: z.string().describe("What you're building (e.g. 'Next.js SaaS app', 'Python API backend', 'mobile app')"),
      },
    },
    async ({ project_description }) => ({
      messages: [
        {
          role: "user" as const,
          content: {
            type: "text" as const,
            text: `Recommend a free infrastructure stack for: ${project_description}. Use the get_stack_recommendation tool with use_case="${project_description}" to get a curated stack of free-tier services covering hosting, database, auth, and more.`,
          },
        },
      ],
    })
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
            text: "What developer tool pricing has changed recently? Use the get_deal_changes tool to see recent free tier removals, limit reductions, limit increases, new free tiers, and pricing restructures.",
          },
        },
      ],
    })
  );

  server.registerPrompt(
    "search-deals",
    {
      description: "Search for free tiers and deals in a specific category. Browse database, hosting, auth, CI/CD, and 48 more categories.",
      argsSchema: {
        category: z.string().describe("Category to search (e.g. 'Databases', 'Cloud Hosting', 'Auth', 'CI/CD', 'Monitoring')"),
      },
    },
    async ({ category }) => ({
      messages: [
        {
          role: "user" as const,
          content: {
            type: "text" as const,
            text: `Find free tiers for ${category}. Use the search_offers tool with category="${category}" to see all available free tiers, credits, and discounts in this category.`,
          },
        },
      ],
    })
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
      const vendorChecks = vendorList.map((v) => `- Use check_vendor_risk with vendor="${v}" to get its risk level, pricing change history, and more-stable alternatives`).join("\n");
      const vendorFilter = vendorList.map((v) => `- Use get_deal_changes with vendor="${v}" to check for any recent pricing changes`).join("\n");
      return {
        messages: [
          {
            role: "user" as const,
            content: {
              type: "text" as const,
              text: `Monitor pricing changes for my vendor watchlist: ${vendorList.join(", ")}.

For each vendor, check its pricing stability and recent changes:

${vendorChecks}

${vendorFilter}

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
