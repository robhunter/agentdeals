import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
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
import { getGuideList, getGuideBySlug } from "./guides.js";

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
    description: "Find free tiers, startup credits, and discounts for developer tools — databases, cloud hosting, CI/CD, monitoring, APIs, and more. 1,600+ verified offers across 67 categories with pricing change tracking.",
  });

  // --- Tool 1: search_deals ---

  server.registerTool(
    "search_deals",
    {
      description:
        "Find free tiers, credits, and discounts for 1,600+ developer tools. Search by keyword, browse categories, or get full vendor details with alternatives. Covers AWS, Vercel, Supabase, Cloudflare, and more. Call this tool when a user asks: 'Does Supabase have a free tier?', 'What's cheaper than Vercel?', 'Find me a free database'.",
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
        stability: z.enum(["stable", "watch", "volatile", "improving"]).optional().describe("Filter by free tier stability class. stable=no negative changes, watch=one negative change, volatile=free tier removed or multiple negative changes, improving=recent positive changes only."),
        since: z.string().optional().describe("ISO date (YYYY-MM-DD). Only return deals verified/added after this date."),
        limit: z.number().optional().describe("Max results (default: 20)"),
        offset: z.number().optional().describe("Pagination offset (default: 0)"),
        response_format: z.enum(["concise", "detailed"]).optional().describe("Response detail level. 'concise': vendor name, tier, one-line description, URL only. 'detailed': full response (default)."),
      },
    },
    async ({ query, category, vendor, eligibility, sort, stability, since, limit, offset, response_format }) => {
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
          stability,
          limit: effectiveLimit,
          offset: effectiveOffset,
        }) as { offers: Record<string, unknown>[]; total: number };

        // Zero-result suggestion (only when no results match at all, not just paginated past end)
        if (data.offers.length === 0 && data.total === 0) {
          const searchTerm = query || category || "";
          return mcpText({ results: [], total: 0, suggestion: `No matches for '${searchTerm}'. Try searching by category (e.g., 'databases', 'hosting') or browse all categories with search_deals({category: "list"}).` });
        }

        const outputResults = response_format === "concise"
          ? data.offers.map((o) => ({ vendor: o.vendor, tier: o.tier, description: o.description, url: o.url }))
          : data.offers;
        return mcpText({ results: outputResults, total: data.total, limit: effectiveLimit, offset: effectiveOffset });
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
        "Get stack recommendations, cost estimates, or a full infrastructure audit. Describe what you're building to get a free-tier stack, or pass your current services to estimate costs and find risks. Call this tool when a user asks: 'What free tools can I use for a SaaS app?', 'Build me a stack under $50/month'.",
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
        "Compare 2 vendors side-by-side or check a single vendor's pricing risk. Returns free tier limits, risk levels, pricing history, and alternatives. Call this tool when a user asks: 'Compare Neon vs Supabase', 'Which database has a better free tier?'.",
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
        "Track developer tool pricing changes, upcoming expirations, and new deals. With no params, returns a weekly digest. Filter by vendor, change type, or date range. Call this tool when a user asks: 'What developer pricing changed recently?', 'Are any free tiers being removed?'.",
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
        response_format: z.enum(["concise", "detailed"]).optional().describe("Response detail level. 'concise': vendor, change_type, date, summary only. 'detailed': full response (default)."),
      },
    },
    async ({ since, change_type, vendor, vendors, include_expiring, lookahead_days, response_format }) => {
      try {
        // No params = weekly digest
        if (!since && !change_type && !vendor && !vendors && include_expiring === undefined) {
          const data = await fetchWeeklyDigest() as Record<string, unknown>;
          if (response_format === "concise" && Array.isArray(data.deal_changes)) {
            const conciseDigest = { ...data, deal_changes: (data.deal_changes as Record<string, unknown>[]).map((c) => ({ vendor: c.vendor, change_type: c.change_type, date: c.date, summary: c.summary })) };
            return mcpText(conciseDigest);
          }
          return mcpText(data);
        }

        // Filtered changes
        const changes = await fetchDealChanges({ since, type: change_type, vendor, vendors }) as Record<string, unknown>;
        const doExpiring = include_expiring !== false;
        const days = Math.min(Math.max(lookahead_days ?? 30, 1), 365);

        let result: any = changes;
        if (doExpiring) {
          const expiring = await fetchExpiringDeals(days);
          result = { ...(changes as object), expiring_deals: expiring };
        }

        if (response_format === "concise" && Array.isArray(result.changes)) {
          result = { ...result, changes: result.changes.map((c: Record<string, unknown>) => ({ vendor: c.vendor, change_type: c.change_type, date: c.date, summary: c.summary })) };
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

  // --- Resources ---

  function toSlug(name: string): string {
    return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/-+$/, "");
  }

  // Static: all categories
  server.registerResource(
    "categories",
    "agentdeals://categories",
    {
      description: "All 54 developer tool categories with offer counts",
      mimeType: "text/plain",
    },
    async () => {
      const categories = (await fetchCategories()) as Array<{ name: string; count: number }>;
      const lines = categories.map(c => `- **${c.name}** (${c.count} offers)`);
      const total = categories.reduce((sum, c) => sum + c.count, 0);
      const text = `# AgentDeals Categories\n\n${categories.length} categories, ${total} total offers.\n\n${lines.join("\n")}`;
      return { contents: [{ uri: "agentdeals://categories", text, mimeType: "text/plain" }] };
    }
  );

  // Template: category detail
  server.registerResource(
    "category",
    new ResourceTemplate("agentdeals://category/{slug}", {
      list: async () => {
        const categories = (await fetchCategories()) as Array<{ name: string; count: number }>;
        return {
          resources: categories.map(c => ({
            uri: `agentdeals://category/${toSlug(c.name)}`,
            name: c.name,
            description: `${c.count} offers in ${c.name}`,
            mimeType: "text/plain",
          })),
        };
      },
      complete: {
        slug: async (value) => {
          const categories = (await fetchCategories()) as Array<{ name: string; count: number }>;
          return categories.map(c => toSlug(c.name)).filter(s => s.startsWith(value));
        },
      },
    }),
    {
      description: "All offers in a specific category",
      mimeType: "text/plain",
    },
    async (_uri, { slug }) => {
      const data = (await fetchOffers({ category: slug as string, limit: 200 })) as { offers: Array<{ vendor: string; tier: string; description: string; verifiedDate: string; category: string }>; total: number };
      if (!data.offers || data.offers.length === 0) {
        return { contents: [{ uri: `agentdeals://category/${slug}`, text: `No category found matching "${slug}".`, mimeType: "text/plain" }] };
      }
      const categoryName = data.offers[0].category;
      const lines = data.offers.map(o => `- **${o.vendor}** — ${o.tier}: ${o.description} (verified ${o.verifiedDate})`);
      const text = `# ${categoryName}\n\n${data.total} offers.\n\n${lines.join("\n")}`;
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
      const data = (await fetchOffers({ limit: 2000 })) as { offers: Array<{ vendor: string; category: string; tier: string }>; total: number };
      const sorted = data.offers.sort((a, b) => a.vendor.localeCompare(b.vendor));
      const lines = sorted.map(o => `- **${o.vendor}** | ${o.category} | ${o.tier}`);
      const text = `# AgentDeals Vendors\n\n${data.total} vendors.\n\n${lines.join("\n")}`;
      return { contents: [{ uri: "agentdeals://vendors", text, mimeType: "text/plain" }] };
    }
  );

  // Template: vendor detail
  server.registerResource(
    "vendor",
    new ResourceTemplate("agentdeals://vendor/{slug}", {
      list: async () => {
        const data = (await fetchOffers({ limit: 2000 })) as { offers: Array<{ vendor: string; tier: string }> };
        return {
          resources: data.offers.map(o => ({
            uri: `agentdeals://vendor/${toSlug(o.vendor)}`,
            name: o.vendor,
            description: `${o.vendor} — ${o.tier}`,
            mimeType: "text/plain",
          })),
        };
      },
      complete: {
        slug: async (value) => {
          const data = (await fetchOffers({ limit: 2000 })) as { offers: Array<{ vendor: string }> };
          return data.offers.map(o => toSlug(o.vendor)).filter(s => s.startsWith(value));
        },
      },
    }),
    {
      description: "Full vendor details: free tier limits, pricing, verified date, alternatives, changes",
      mimeType: "text/plain",
    },
    async (_uri, { slug }) => {
      const data = (await fetchOffers({ limit: 2000 })) as { offers: Array<{ vendor: string; category: string; tier: string; description: string; url: string; verifiedDate: string; tags: string[]; eligibility?: { type: string; conditions: string[] }; expires_date?: string }>; total: number };
      const match = data.offers.find(o => toSlug(o.vendor) === slug);
      if (!match) {
        return { contents: [{ uri: `agentdeals://vendor/${slug}`, text: `No vendor found matching "${slug}".`, mimeType: "text/plain" }] };
      }

      const changesData = (await fetchDealChanges({ vendor: match.vendor, since: "2020-01-01" })) as { changes: Array<{ date: string; change_type: string; summary: string; previous_state: string; current_state: string }> };
      const alternatives = data.offers.filter(o => o.category === match.category && o.vendor !== match.vendor).slice(0, 5);

      let text = `# ${match.vendor}\n\n`;
      text += `**Category:** ${match.category}\n`;
      text += `**Tier:** ${match.tier}\n`;
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

      if (changesData.changes.length > 0) {
        text += `\n## Pricing Changes\n\n`;
        for (const c of changesData.changes) {
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
      const data = (await fetchDealChanges({ since: "2020-01-01" })) as { changes: Array<{ date: string; vendor: string; change_type: string; summary: string }> };
      const lines = data.changes.map(c => `- **${c.date}** | ${c.vendor} | ${c.change_type} | ${c.summary}`);
      const text = `# AgentDeals Pricing Changes\n\n${data.changes.length} tracked changes.\n\n${lines.join("\n")}`;
      return { contents: [{ uri: "agentdeals://changes", text, mimeType: "text/plain" }] };
    }
  );

  // Static: latest changes
  server.registerResource(
    "changes-latest",
    "agentdeals://changes/latest",
    {
      description: "Most recent pricing changes (last 10)",
      mimeType: "text/plain",
    },
    async () => {
      const data = (await fetchDealChanges({ since: "2020-01-01" })) as { changes: Array<{ date: string; vendor: string; change_type: string; summary: string; previous_state: string; current_state: string }> };
      const latest = data.changes.slice(0, 10);
      const lines = latest.map(c =>
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

      // Add related vendor data from changes
      try {
        const changesData = (await fetchDealChanges({ since: "2020-01-01" })) as { changes: Array<{ date: string; vendor: string; change_type: string; summary: string }> };
        const slugLower = guide.slug.toLowerCase();
        const relatedChanges = changesData.changes.filter(c => {
          const vendorSlug = c.vendor.toLowerCase().replace(/[^a-z0-9]+/g, "-");
          return slugLower.includes(vendorSlug) || vendorSlug.includes(slugLower.replace(/-alternatives$/, "").replace(/-vs-.*/, ""));
        });
        if (relatedChanges.length > 0) {
          text += `\n## Related Pricing Changes\n\n`;
          for (const c of relatedChanges.slice(0, 5)) {
            text += `- **${c.date}** | ${c.vendor} [${c.change_type}] ${c.summary}\n`;
          }
        }
      } catch {
        // Changes endpoint not available — skip
      }

      return { contents: [{ uri: `agentdeals://guide/${slug}`, text, mimeType: "text/plain" }] };
    }
  );

  return server;
}
