export const openapiSpec = {
  openapi: "3.0.3",
  info: {
    title: "AgentDeals API",
    description: "Aggregated free tiers, discounts, and startup programs for developer infrastructure. No authentication required.",
    version: "0.1.0",
    contact: {
      name: "AgentDeals",
      url: "https://agentdeals-production.up.railway.app"
    },
    license: {
      name: "MIT",
      url: "https://opensource.org/licenses/MIT"
    }
  },
  servers: [
    {
      url: "https://agentdeals-production.up.railway.app",
      description: "Production server"
    }
  ],
  security: [],
  paths: {
    "/api/offers": {
      get: {
        summary: "Search and browse offers",
        description: "Search vendor offers by keyword and/or category. Returns paginated results.",
        parameters: [
          { name: "q", in: "query", description: "Search keyword (matches vendor name, description, category, tags)", schema: { type: "string" }, example: "database" },
          { name: "category", in: "query", description: "Filter by category name", schema: { type: "string" }, example: "Cloud Hosting" },
          { name: "limit", in: "query", description: "Max results per page", schema: { type: "integer", default: 20 } },
          { name: "offset", in: "query", description: "Number of results to skip", schema: { type: "integer", default: 0 } }
        ],
        responses: {
          "200": {
            description: "Paginated list of offers",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    offers: { type: "array", items: { $ref: "#/components/schemas/Offer" } },
                    total: { type: "integer", description: "Total matching offers (before pagination)" }
                  }
                },
                example: {
                  offers: [{ vendor: "Supabase", category: "Cloud Hosting", description: "Open-source Firebase alternative with Postgres database, auth, storage, and edge functions. Free tier: 2 projects, 500MB database, 1GB file storage, 50K monthly active users.", tier: "Free", url: "https://supabase.com/pricing", tags: ["database", "auth", "serverless"], verifiedDate: "2026-03-01" }],
                  total: 1
                }
              }
            }
          }
        }
      }
    },
    "/api/categories": {
      get: {
        summary: "List all categories",
        description: "Returns all offer categories with the number of offers in each.",
        responses: {
          "200": {
            description: "List of categories with counts",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    categories: {
                      type: "array",
                      items: {
                        type: "object",
                        properties: {
                          name: { type: "string" },
                          count: { type: "integer" }
                        }
                      }
                    }
                  }
                },
                example: {
                  categories: [
                    { name: "Cloud Hosting", count: 45 },
                    { name: "Databases", count: 30 }
                  ]
                }
              }
            }
          }
        }
      }
    },
    "/api/new": {
      get: {
        summary: "Recently added or updated offers",
        description: "Returns offers where verifiedDate falls within the last N days.",
        parameters: [
          { name: "days", in: "query", description: "Number of days to look back (1-30)", schema: { type: "integer", default: 7 }, example: 7 },
          { name: "limit", in: "query", description: "Max results to return", schema: { type: "integer", default: 50 } }
        ],
        responses: {
          "200": {
            description: "List of recently verified offers",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    offers: { type: "array", items: { $ref: "#/components/schemas/Offer" } },
                    total: { type: "integer" }
                  }
                }
              }
            }
          }
        }
      }
    },
    "/api/changes": {
      get: {
        summary: "Deal and pricing changes",
        description: "Returns tracked pricing and tier changes across vendors. Filter by date, change type, or vendor.",
        parameters: [
          { name: "since", in: "query", description: "Filter changes after this date (YYYY-MM-DD)", schema: { type: "string", format: "date" }, example: "2025-01-01" },
          { name: "type", in: "query", description: "Filter by change type", schema: { type: "string", enum: ["free_tier_removed", "limits_reduced", "limits_increased", "new_free_tier", "pricing_restructured"] } },
          { name: "vendor", in: "query", description: "Filter by vendor name", schema: { type: "string" } }
        ],
        responses: {
          "200": {
            description: "List of deal changes",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    changes: { type: "array", items: { $ref: "#/components/schemas/DealChange" } },
                    total: { type: "integer" }
                  }
                },
                example: {
                  changes: [{ vendor: "Heroku", change_type: "free_tier_removed", date: "2022-11-28", summary: "Heroku eliminated all free dynos, free Postgres, and free Redis.", previous_state: "Free dyno (550-1000 hrs/mo), free Postgres (10K rows), free Redis (25MB)", current_state: "No free tier. Cheapest plan: $5/mo Eco dyno.", impact: "high", source_url: "https://blog.heroku.com/next-chapter", category: "Cloud Hosting", alternatives: ["Railway", "Render", "Fly.io"] }],
                  total: 1
                }
              }
            }
          },
          "400": {
            description: "Invalid since parameter",
            content: {
              "application/json": {
                schema: { type: "object", properties: { error: { type: "string" } } }
              }
            }
          }
        }
      }
    },
    "/api/details/{vendor}": {
      get: {
        summary: "Vendor detail with alternatives",
        description: "Get detailed information about a specific vendor's offer. Optionally includes alternatives in the same category.",
        parameters: [
          { name: "vendor", in: "path", required: true, description: "Vendor name (URL-encoded)", schema: { type: "string" }, example: "Supabase" },
          { name: "alternatives", in: "query", description: "Include alternative vendors in the same category", schema: { type: "string", enum: ["true", "false"], default: "false" } }
        ],
        responses: {
          "200": {
            description: "Vendor offer details",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    offer: { $ref: "#/components/schemas/Offer" },
                    alternatives: { type: "array", items: { $ref: "#/components/schemas/Offer" }, description: "Only present when alternatives=true" }
                  }
                }
              }
            }
          },
          "400": {
            description: "Missing vendor name",
            content: {
              "application/json": {
                schema: { type: "object", properties: { error: { type: "string" } } }
              }
            }
          },
          "404": {
            description: "Vendor not found",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    error: { type: "string" },
                    suggestions: { type: "array", items: { type: "string" }, description: "Similar vendor names" }
                  }
                }
              }
            }
          }
        }
      }
    },
    "/api/stack": {
      get: {
        summary: "Get free-tier stack recommendation",
        description: "Returns a curated infrastructure stack recommendation based on your project type. Covers hosting, database, auth, and more — all free tier.",
        parameters: [
          { name: "use_case", in: "query", required: true, description: "What you're building (e.g., 'Next.js SaaS app', 'API backend', 'static blog')", schema: { type: "string" }, example: "Next.js SaaS app" },
          { name: "requirements", in: "query", description: "Comma-separated infrastructure needs (e.g., 'database,auth,email')", schema: { type: "string" }, example: "database,auth,email" }
        ],
        responses: {
          "200": {
            description: "Stack recommendation",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    use_case: { type: "string" },
                    stack: {
                      type: "array",
                      items: {
                        type: "object",
                        properties: {
                          role: { type: "string" },
                          vendor: { type: "string" },
                          tier: { type: "string" },
                          description: { type: "string" },
                          url: { type: "string", format: "uri" }
                        }
                      }
                    },
                    total_monthly_cost: { type: "string" },
                    limitations: { type: "array", items: { type: "string" } },
                    upgrade_path: { type: "string" }
                  }
                }
              }
            }
          },
          "400": {
            description: "Missing use_case parameter",
            content: {
              "application/json": {
                schema: { type: "object", properties: { error: { type: "string" } } }
              }
            }
          }
        }
      }
    },
    "/api/query-log": {
      get: {
        summary: "Recent request log",
        description: "Returns recent request-level log entries for both MCP tool calls and REST API hits. Stored in Redis, capped at 1000 entries.",
        parameters: [
          { name: "limit", in: "query", description: "Number of entries to return (1-200)", schema: { type: "integer", default: 50 } }
        ],
        responses: {
          "200": {
            description: "Recent request log entries",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    entries: {
                      type: "array",
                      items: {
                        type: "object",
                        properties: {
                          ts: { type: "string", format: "date-time" },
                          type: { type: "string", enum: ["mcp", "api"] },
                          endpoint: { type: "string" },
                          params: { type: "object" },
                          user_agent: { type: "string" },
                          result_count: { type: "integer" },
                          session_id: { type: "string" }
                        }
                      }
                    },
                    count: { type: "integer" }
                  }
                }
              }
            }
          }
        }
      }
    },
    "/api/stats": {
      get: {
        summary: "Service statistics",
        description: "Returns aggregate service statistics including uptime, total offers, categories, and usage counts.",
        responses: {
          "200": {
            description: "Service statistics",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    uptime_seconds: { type: "number" },
                    total_offers: { type: "integer" },
                    total_categories: { type: "integer" },
                    total_deal_changes: { type: "integer" },
                    sessions: { type: "integer" },
                    tool_calls: { type: "object" },
                    api_hits: { type: "object" },
                    landing_page_views: { type: "integer" }
                  }
                }
              }
            }
          }
        }
      }
    }
  },
  components: {
    schemas: {
      Offer: {
        type: "object",
        properties: {
          vendor: { type: "string", description: "Vendor/service name" },
          category: { type: "string", description: "Offer category" },
          description: { type: "string", description: "Description of the offer and free tier details" },
          tier: { type: "string", description: "Tier name (e.g. Free, Free Credits, Open Source)" },
          url: { type: "string", format: "uri", description: "Pricing/offer page URL" },
          tags: { type: "array", items: { type: "string" }, description: "Searchable tags" },
          verifiedDate: { type: "string", format: "date", description: "Date the offer was last verified (YYYY-MM-DD)" },
          eligibility: { $ref: "#/components/schemas/Eligibility" }
        },
        required: ["vendor", "category", "description", "tier", "url", "tags", "verifiedDate"]
      },
      Eligibility: {
        type: "object",
        description: "Eligibility requirements for conditional offers",
        properties: {
          type: { type: "string", enum: ["public", "accelerator", "oss", "student", "fintech", "geographic", "enterprise"] },
          conditions: { type: "array", items: { type: "string" } },
          program: { type: "string" }
        },
        required: ["type", "conditions"]
      },
      DealChange: {
        type: "object",
        properties: {
          vendor: { type: "string" },
          change_type: { type: "string", enum: ["free_tier_removed", "limits_reduced", "limits_increased", "new_free_tier", "pricing_restructured"] },
          date: { type: "string", format: "date" },
          summary: { type: "string" },
          previous_state: { type: "string" },
          current_state: { type: "string" },
          impact: { type: "string", enum: ["high", "medium", "low"] },
          source_url: { type: "string", format: "uri" },
          category: { type: "string" },
          alternatives: { type: "array", items: { type: "string" } }
        },
        required: ["vendor", "change_type", "date", "summary", "previous_state", "current_state", "impact", "source_url", "category", "alternatives"]
      }
    }
  }
};
