import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  fetchCategories,
  fetchOffers,
  fetchOfferDetails,
  fetchNewOffers,
  fetchDealChanges,
  fetchStackRecommendation,
  fetchCosts,
  fetchCompare,
  fetchVendorRisk,
  fetchAuditStack,
  fetchExpiringDeals,
  fetchNewestDeals,
  fetchWeeklyDigest,
} from "./api-client.js";

function mcpError(msg: string) {
  return {
    isError: true as const,
    content: [{ type: "text" as const, text: msg }],
  };
}

function mcpText(data: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
  };
}

function tryParseJson(text: string): unknown | null {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export function createServer(): McpServer {
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
        const categories = await fetchCategories();
        return mcpText(categories);
      } catch (err) {
        return mcpError(`Error listing categories: ${err instanceof Error ? err.message : String(err)}`);
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
        const usePagination = limit !== undefined || offset !== undefined;
        const effectiveOffset = offset ?? 0;
        const effectiveLimit = limit ?? (usePagination ? 20 : 10000);
        const data = await fetchOffers({ q: query, category, eligibility_type, sort, limit: effectiveLimit, offset: effectiveOffset }) as { offers: unknown[]; total: number };
        return mcpText({ results: data.offers, total: data.total, limit: effectiveLimit, offset: effectiveOffset });
      } catch (err) {
        return mcpError(`Error searching offers: ${err instanceof Error ? err.message : String(err)}`);
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
        const data = await fetchOfferDetails(vendor, include_alternatives) as { offer: Record<string, unknown>; alternatives?: unknown[] };
        // Return the offer object directly (matching server.ts output format)
        // The REST API returns alternatives both on the offer and as a sibling
        // Ensure alternatives are on the offer object when requested
        if (include_alternatives && data.alternatives && !data.offer.alternatives) {
          data.offer.alternatives = data.alternatives;
        }
        return mcpText(data.offer);
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        // Parse API 404 errors to provide the same format as server.ts
        const match = errMsg.match(/API error \(404\): (.+)/);
        if (match) {
          const parsed = tryParseJson(match[1]);
          if (parsed && typeof parsed === "object" && parsed !== null && "error" in parsed) {
            const apiError = parsed as { error: string; suggestions?: string[] };
            const suggestions = apiError.suggestions ?? [];
            const msg = suggestions.length > 0
              ? `${apiError.error} Did you mean: ${suggestions.join(", ")}?`
              : `${apiError.error} No similar vendors found.`;
            return mcpError(msg);
          }
        }
        return mcpError(`Error getting offer details: ${errMsg}`);
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
        const data = await fetchNewOffers(days);
        return mcpText(data);
      } catch (err) {
        return mcpError(`Error getting new offers: ${err instanceof Error ? err.message : String(err)}`);
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
        const data = await fetchNewestDeals({ since, limit, category });
        return mcpText(data);
      } catch (err) {
        return mcpError(`Error getting newest deals: ${err instanceof Error ? err.message : String(err)}`);
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
        vendors: z.string().optional().describe("Comma-separated vendor names to filter by (case-insensitive partial match). Use to track changes affecting your specific stack, e.g. 'Vercel,Supabase,Clerk'"),
      },
    },
    async ({ since, change_type, vendor, vendors }) => {
      try {
        const data = await fetchDealChanges({ since, type: change_type, vendor, vendors });
        return mcpText(data);
      } catch (err) {
        return mcpError(`Error getting deal changes: ${err instanceof Error ? err.message : String(err)}`);
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
        const data = await fetchStackRecommendation(use_case, requirements);
        return mcpText(data);
      } catch (err) {
        return mcpError(`Error getting stack recommendation: ${err instanceof Error ? err.message : String(err)}`);
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
        const data = await fetchCosts(services, scale);
        return mcpText(data);
      } catch (err) {
        return mcpError(`Error estimating costs: ${err instanceof Error ? err.message : String(err)}`);
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
        const data = await fetchCompare(vendor_a, vendor_b);
        return mcpText(data);
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        // Parse API 404 errors to provide the same format as server.ts
        const match = errMsg.match(/API error \(404\): (.+)/);
        if (match) {
          const parsed = tryParseJson(match[1]);
          if (parsed && typeof parsed === "object" && parsed !== null && "error" in parsed) {
            return mcpError((parsed as { error: string }).error);
          }
        }
        return mcpError(`Error comparing services: ${errMsg}`);
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
        const data = await fetchVendorRisk(vendor);
        return mcpText(data);
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        const match = errMsg.match(/API error \(404\): (.+)/);
        if (match) {
          const parsed = tryParseJson(match[1]);
          if (parsed && typeof parsed === "object" && parsed !== null && "error" in parsed) {
            return mcpError((parsed as { error: string }).error);
          }
        }
        return mcpError(`Error checking vendor risk: ${errMsg}`);
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
        const data = await fetchAuditStack(services);
        return mcpText(data);
      } catch (err) {
        return mcpError(`Error auditing stack: ${err instanceof Error ? err.message : String(err)}`);
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
        const data = await fetchExpiringDeals(within_days);
        return mcpText(data);
      } catch (err) {
        return mcpError(`Error getting expiring deals: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  );

  server.registerTool(
    "get_weekly_digest",
    {
      description:
        "Get a curated weekly summary of developer tool pricing changes, new offers, and upcoming deadlines. Use for regular check-ins on what's changed in developer pricing. Falls back to 30-day window if fewer than 3 changes in the past week.",
      inputSchema: {},
    },
    async () => {
      try {
        const data = await fetchWeeklyDigest();
        return mcpText(data);
      } catch (err) {
        return mcpError(`Error getting weekly digest: ${err instanceof Error ? err.message : String(err)}`);
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

Step 1: Use get_stack_recommendation with use_case="${project_description}" to get a recommended stack.
Step 2: For each recommended vendor, use get_offer_details with include_alternatives=true to see the full deal details and alternatives.
Step 3: For the top picks, use check_vendor_risk to verify pricing stability.

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
      const auditSteps = vendors.map((v) => `- Use get_offer_details with vendor="${v}" and include_alternatives=true`).join("\n");
      const riskSteps = vendors.map((v) => `- Use check_vendor_risk with vendor="${v}"`).join("\n");
      return {
        messages: [
          {
            role: "user" as const,
            content: {
              type: "text" as const,
              text: `Audit my current stack for cost savings: ${vendors.join(", ")}.

Step 1: Use audit_stack with vendors="${vendors.join(",")}" for an overview.
Step 2: Get detailed alternatives for each vendor:
${auditSteps}
Step 3: Check risk for each vendor:
${riskSteps}
Step 4: Use estimate_costs with services="${vendors.join(",")}" to project costs.

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

Step 1: Use get_deal_changes to see all recent changes (free tier removals, limit reductions, limit increases, new free tiers, pricing restructures).
Step 2: Use get_expiring_deals to check for upcoming pricing deadlines.
Step 3: For any concerning changes, use check_vendor_risk on those vendors for context.

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

Step 1: Use compare_services with vendors="${vendors.join(",")}" for a side-by-side comparison.
Step 2: For each vendor, use check_vendor_risk to assess pricing stability.
Step 3: Use get_deal_changes for each vendor to see recent pricing history.

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
      const eligFilter = eligibility ? ` with eligibility_type="${eligibility}"` : "";
      const eligDesc = eligibility || "startup, student, and open-source";
      return {
        messages: [
          {
            role: "user" as const,
            content: {
              type: "text" as const,
              text: `Find ${eligDesc} credit programs and special deals.

Step 1: Use search_offers${eligFilter} with sort="value" to find the highest-value conditional deals.
Step 2: For the top results, use get_offer_details with include_alternatives=true to see full details and eligibility requirements.

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
