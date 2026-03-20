import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  fetchCategories,
  fetchOffers,
  fetchOfferDetails,
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

function parse404Error(err: unknown): string | null {
  const errMsg = err instanceof Error ? err.message : String(err);
  const match = errMsg.match(/API error \(404\): (.+)/);
  if (match) {
    const parsed = tryParseJson(match[1]);
    if (parsed && typeof parsed === "object" && parsed !== null && "error" in parsed) {
      const apiError = parsed as { error: string; suggestions?: string[] };
      const suggestions = apiError.suggestions ?? [];
      return suggestions.length > 0
        ? `${apiError.error} Did you mean: ${suggestions.join(", ")}?`
        : `${apiError.error} No similar vendors found.`;
    }
  }
  return null;
}

export function createServer(): McpServer {
  const server = new McpServer({
    name: "agentdeals",
    version: "0.1.0",
    description: "Find free tiers, startup credits, and discounts for developer tools — databases, cloud hosting, CI/CD, monitoring, APIs, and more. 1,500+ verified offers across 54 categories with pricing change tracking.",
  });

  // --- Tool 1: search_deals ---

  server.registerTool(
    "search_deals",
    {
      description:
        "Find free tiers, credits, and discounts for 1,500+ developer tools. Search by keyword, browse categories, or get full vendor details with alternatives. Covers AWS, Vercel, Supabase, Cloudflare, and more.",
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
      },
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
        // Mode: list categories
        if (category === "list") {
          const categories = await fetchCategories();
          return mcpText(categories);
        }

        // Mode: vendor details
        if (vendor) {
          try {
            const data = await fetchOfferDetails(vendor, true) as { offer: Record<string, unknown>; alternatives?: unknown[] };
            if (data.alternatives && !data.offer.alternatives) {
              data.offer.alternatives = data.alternatives;
            }
            return mcpText(data.offer);
          } catch (err) {
            const parsed = parse404Error(err);
            if (parsed) return mcpError(parsed);
            throw err;
          }
        }

        // Mode: recent deals (since param without search)
        if (since && !query && !category) {
          const data = await fetchNewestDeals({ since, limit, category: undefined });
          return mcpText(data);
        }

        // Mode: search/browse
        const effectiveOffset = offset ?? 0;
        const effectiveLimit = limit ?? 20;
        const data = await fetchOffers({
          q: query,
          category,
          eligibility_type: eligibility,
          sort,
          limit: effectiveLimit,
          offset: effectiveOffset,
        }) as { offers: unknown[]; total: number };
        return mcpText({ results: data.offers, total: data.total, limit: effectiveLimit, offset: effectiveOffset });
      } catch (err) {
        return mcpError(`Error: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  );

  // --- Tool 2: plan_stack ---

  server.registerTool(
    "plan_stack",
    {
      description:
        "Get stack recommendations, cost estimates, or a full infrastructure audit. Describe what you're building to get a free-tier stack, or pass your current services to estimate costs and find risks.",
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
      },
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
        if (mode === "recommend") {
          if (!use_case) return mcpError("use_case is required for recommend mode");
          const data = await fetchStackRecommendation(use_case, requirements);
          return mcpText(data);
        }
        if (mode === "estimate") {
          if (!services || services.length === 0) return mcpError("services is required for estimate mode");
          const data = await fetchCosts(services, scale);
          return mcpText(data);
        }
        if (mode === "audit") {
          if (!services || services.length === 0) return mcpError("services is required for audit mode");
          const data = await fetchAuditStack(services);
          return mcpText(data);
        }
        return mcpError(`Unknown mode: ${mode}`);
      } catch (err) {
        return mcpError(`Error: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  );

  // --- Tool 3: compare_vendors ---

  server.registerTool(
    "compare_vendors",
    {
      description:
        "Compare 2 vendors side-by-side or check a single vendor's pricing risk. Returns free tier limits, risk levels, pricing history, and alternatives.",
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
      },
      inputSchema: {
        vendors: z.array(z.string()).describe("1 or 2 vendor names. 1 vendor = risk check. 2 vendors = side-by-side comparison."),
        include_risk: z.boolean().optional().describe("Include risk assessment (default: true)"),
      },
    },
    async ({ vendors, include_risk }) => {
      try {
        const doRisk = include_risk !== false;

        // Single vendor = risk check
        if (vendors.length === 1) {
          try {
            const data = await fetchVendorRisk(vendors[0]);
            return mcpText(data);
          } catch (err) {
            const parsed = parse404Error(err);
            if (parsed) return mcpError(parsed);
            throw err;
          }
        }

        // Two vendors = comparison
        if (vendors.length === 2) {
          try {
            let comparison = await fetchCompare(vendors[0], vendors[1]);
            if (doRisk) {
              let riskA = null;
              let riskB = null;
              try { riskA = await fetchVendorRisk(vendors[0]); } catch { /* skip */ }
              try { riskB = await fetchVendorRisk(vendors[1]); } catch { /* skip */ }
              comparison = { ...(comparison as object), risk: { [vendors[0]]: riskA, [vendors[1]]: riskB } };
            }
            return mcpText(comparison);
          } catch (err) {
            const parsed = parse404Error(err);
            if (parsed) return mcpError(parsed);
            throw err;
          }
        }

        return mcpError("vendors must contain 1 or 2 vendor names");
      } catch (err) {
        return mcpError(`Error: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  );

  // --- Tool 4: track_changes ---

  server.registerTool(
    "track_changes",
    {
      description:
        "Track developer tool pricing changes, upcoming expirations, and new deals. With no params, returns a weekly digest. Filter by vendor, change type, or date range.",
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
      },
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
        // No params = weekly digest
        if (!since && !change_type && !vendor && !vendors && include_expiring === undefined) {
          const data = await fetchWeeklyDigest();
          return mcpText(data);
        }

        // Filtered changes
        const changes = await fetchDealChanges({ since, type: change_type, vendor, vendors });
        const doExpiring = include_expiring !== false;
        const days = Math.min(Math.max(lookahead_days ?? 30, 1), 365);

        let result: any = changes;
        if (doExpiring) {
          const expiring = await fetchExpiringDeals(days);
          result = { ...(changes as object), expiring_deals: expiring };
        }

        return mcpText(result);
      } catch (err) {
        return mcpError(`Error: ${err instanceof Error ? err.message : String(err)}`);
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
