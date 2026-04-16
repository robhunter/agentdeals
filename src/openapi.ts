export const openapiSpec = {
  openapi: "3.0.3",
  info: {
    title: "AgentDeals API",
    description: "Aggregated free tiers, discounts, and startup programs for developer infrastructure. No authentication required.",
    version: "0.1.0",
    contact: {
      name: "AgentDeals",
      url: "https://agentdeals.dev"
    },
    license: {
      name: "MIT",
      url: "https://opensource.org/licenses/MIT"
    }
  },
  servers: [
    {
      url: "https://agentdeals.dev",
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
    "/api/newest": {
      get: {
        summary: "Newest deals",
        description: "Returns deals sorted by verified date (newest first) with days_since_update. Use for periodic 'what's new' checks.",
        parameters: [
          { name: "since", in: "query", description: "ISO date (YYYY-MM-DD). Only return deals verified after this date. Default: 30 days ago", schema: { type: "string", format: "date" } },
          { name: "limit", in: "query", description: "Max results (default: 20, max: 50)", schema: { type: "integer", default: 20 } },
          { name: "category", in: "query", description: "Filter by category name", schema: { type: "string" } }
        ],
        responses: {
          "200": {
            description: "List of newest deals with days_since_update",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    deals: { type: "array", items: { allOf: [{ $ref: "#/components/schemas/Offer" }, { type: "object", properties: { days_since_update: { type: "integer" } } }] } },
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
        description: "Returns tracked pricing and tier changes across vendors. Filter by date, change type, vendor, or category. When vendors or categories are provided, returns personalized results with advisory section for high-impact changes outside your filter.",
        parameters: [
          { name: "since", in: "query", description: "Filter changes after this date (YYYY-MM-DD)", schema: { type: "string", format: "date" }, example: "2025-01-01" },
          { name: "type", in: "query", description: "Filter by change type", schema: { type: "string", enum: ["free_tier_removed", "limits_reduced", "restriction", "limits_increased", "new_free_tier", "new_tier", "pricing_restructured", "open_source_killed", "pricing_model_change", "startup_program_expanded", "pricing_postponed", "product_deprecated"] } },
          { name: "vendor", in: "query", description: "Filter by vendor name", schema: { type: "string" } },
          { name: "vendors", in: "query", description: "Comma-separated vendor names to filter by (e.g. 'Vercel,Supabase,Clerk'). Triggers personalized response.", schema: { type: "string" }, example: "Vercel,Supabase" },
          { name: "categories", in: "query", description: "Comma-separated category names to filter by (e.g. 'Database,Cloud Hosting'). Case-insensitive partial match. Triggers personalized response.", schema: { type: "string" }, example: "Database,Hosting" }
        ],
        responses: {
          "200": {
            description: "List of deal changes. When vendors or categories are provided, returns personalized response with your_stack_changes, advisory, and summary fields instead of changes/total.",
            content: {
              "application/json": {
                schema: {
                  oneOf: [
                    {
                      type: "object",
                      description: "Standard response (no vendor/category filters)",
                      properties: {
                        changes: { type: "array", items: { $ref: "#/components/schemas/DealChange" } },
                        total: { type: "integer" }
                      }
                    },
                    {
                      type: "object",
                      description: "Personalized response (vendor/category filters active)",
                      properties: {
                        your_stack_changes: { type: "array", items: { $ref: "#/components/schemas/DealChange" } },
                        advisory: { type: "array", items: { $ref: "#/components/schemas/DealChange" }, description: "Top 3 high-impact changes outside your filter" },
                        summary: {
                          type: "object",
                          properties: {
                            stack_changes_count: { type: "integer" },
                            ecosystem_high_impact_count: { type: "integer" },
                            period_days: { type: "integer" }
                          }
                        }
                      }
                    }
                  ]
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
    "/api/compare": {
      get: {
        summary: "Compare two vendors side by side",
        description: "Returns a structured comparison of two developer tool vendors including free tier details, pricing, and recent deal changes.",
        parameters: [
          { name: "a", in: "query", required: true, description: "First vendor name (case-insensitive, fuzzy match supported)", schema: { type: "string" }, example: "Supabase" },
          { name: "b", in: "query", required: true, description: "Second vendor name (case-insensitive, fuzzy match supported)", schema: { type: "string" }, example: "Neon" }
        ],
        responses: {
          "200": {
            description: "Side-by-side vendor comparison",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    vendor_a: { $ref: "#/components/schemas/Offer" },
                    vendor_b: { $ref: "#/components/schemas/Offer" },
                    shared_categories: { type: "boolean" },
                    category_overlap: { type: "array", items: { type: "string" } }
                  }
                }
              }
            }
          },
          "400": {
            description: "Missing required parameters",
            content: {
              "application/json": {
                schema: { type: "object", properties: { error: { type: "string" } } }
              }
            }
          },
          "404": {
            description: "One or both vendors not found",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    error: { type: "string" },
                    suggestions_a: { type: "array", items: { type: "string" } },
                    suggestions_b: { type: "array", items: { type: "string" } }
                  }
                }
              }
            }
          }
        }
      }
    },
    "/api/audit-stack": {
      get: {
        summary: "Audit your infrastructure stack",
        description: "Analyze your current services for pricing risks, cost savings, and missing capabilities. Returns per-service risk assessment, cheaper alternatives, and gap analysis.",
        parameters: [
          { name: "services", in: "query", required: true, description: "Comma-separated vendor names (e.g. 'Vercel,Supabase,Clerk')", schema: { type: "string" }, example: "Vercel,Supabase,Clerk" }
        ],
        responses: {
          "200": {
            description: "Stack audit results",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    services_analyzed: { type: "number" },
                    risks_found: { type: "number" },
                    savings_opportunities: { type: "number" },
                    gaps: { type: "array", items: { type: "object" } },
                    services: { type: "array", items: { type: "object" } },
                    recommendations: { type: "array", items: { type: "string" } }
                  }
                }
              }
            }
          },
          "400": {
            description: "Missing services parameter",
            content: {
              "application/json": {
                schema: { type: "object", properties: { error: { type: "string" } } }
              }
            }
          }
        }
      }
    },
    "/api/vendor-risk/{vendor}": {
      get: {
        summary: "Check vendor pricing stability and risk",
        description: "Before depending on a vendor's free tier, check if their pricing is stable. Returns risk level (stable/caution/risky), pricing change history, free tier longevity, and more-stable alternatives.",
        parameters: [
          { name: "vendor", in: "path", required: true, description: "Vendor name (case-insensitive, fuzzy match supported)", schema: { type: "string" }, example: "Vercel" }
        ],
        responses: {
          "200": {
            description: "Vendor risk assessment",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    vendor: { type: "string" },
                    category: { type: "string" },
                    risk_level: { type: "string", enum: ["stable", "caution", "risky"] },
                    free_tier_longevity_days: { type: "number" },
                    changes: { type: "array", items: { $ref: "#/components/schemas/DealChange" } },
                    alternatives: {
                      type: "array",
                      items: {
                        type: "object",
                        properties: {
                          vendor: { type: "string" },
                          category: { type: "string" },
                          tier: { type: "string" },
                          risk_level: { type: "string", enum: ["stable", "caution", "risky"] }
                        }
                      }
                    },
                    summary: { type: "string" }
                  }
                }
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
                    suggestions: { type: "array", items: { type: "string" } }
                  }
                }
              }
            }
          }
        }
      }
    },
    "/api/expiring": {
      get: {
        summary: "Get expiring deals",
        description: "Check which developer tool deals, free tiers, or credits are expiring soon. Returns deals sorted by expiration date (soonest first).",
        parameters: [
          { name: "within_days", in: "query", description: "Number of days to look ahead (default: 30, max: 365)", schema: { type: "integer", default: 30, minimum: 1, maximum: 365 } }
        ],
        responses: {
          "200": {
            description: "Expiring deals",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    deals: {
                      type: "array",
                      items: {
                        type: "object",
                        properties: {
                          vendor: { type: "string" },
                          category: { type: "string" },
                          description: { type: "string" },
                          tier: { type: "string" },
                          url: { type: "string", format: "uri" },
                          expires_date: { type: "string", format: "date" },
                          days_until_expiry: { type: "integer" }
                        }
                      }
                    },
                    total: { type: "integer" }
                  }
                }
              }
            }
          }
        }
      }
    },
    "/api/freshness": {
      get: {
        summary: "Get data freshness metrics",
        description: "Returns data quality metrics including freshness score, verification age breakdowns, stalest/freshest entries, and per-category freshness.",
        parameters: [],
        responses: {
          "200": {
            description: "Data freshness metrics",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    total_offers: { type: "integer" },
                    verified_within_7_days: { type: "integer" },
                    verified_within_30_days: { type: "integer" },
                    verified_within_90_days: { type: "integer" },
                    verified_within_180_days: { type: "integer" },
                    freshness_score: { type: "integer", description: "Percentage of offers verified within 90 days" },
                    stalest_entries: {
                      type: "array",
                      items: {
                        type: "object",
                        properties: {
                          vendor: { type: "string" },
                          category: { type: "string" },
                          verifiedDate: { type: "string", format: "date" },
                          url: { type: "string", format: "uri" },
                          days_since_verified: { type: "integer" }
                        }
                      }
                    },
                    freshest_entries: {
                      type: "array",
                      items: {
                        type: "object",
                        properties: {
                          vendor: { type: "string" },
                          category: { type: "string" },
                          verifiedDate: { type: "string", format: "date" },
                          url: { type: "string", format: "uri" },
                          days_since_verified: { type: "integer" }
                        }
                      }
                    },
                    by_category: {
                      type: "array",
                      items: {
                        type: "object",
                        properties: {
                          category: { type: "string" },
                          count: { type: "integer" },
                          avg_days_since_verified: { type: "integer" },
                          freshness_score: { type: "integer" }
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    },
    "/api/digest": {
      get: {
        summary: "Get weekly pricing digest",
        description: "Curated weekly summary of developer tool pricing changes, new offers, and upcoming deadlines. Falls back to 30-day window if fewer than 3 changes in the past week.",
        parameters: [],
        responses: {
          "200": {
            description: "Weekly digest",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    week: { type: "string", description: "Week date range" },
                    date_range: { type: "string", description: "ISO date range" },
                    deal_changes: {
                      type: "array",
                      items: {
                        type: "object",
                        properties: {
                          vendor: { type: "string" },
                          change_type: { type: "string" },
                          date: { type: "string", format: "date" },
                          summary: { type: "string" },
                          impact: { type: "string", enum: ["high", "medium", "low"] }
                        }
                      }
                    },
                    new_offers: {
                      type: "array",
                      items: {
                        type: "object",
                        properties: {
                          vendor: { type: "string" },
                          category: { type: "string" },
                          description: { type: "string" }
                        }
                      }
                    },
                    upcoming_deadlines: {
                      type: "array",
                      items: {
                        type: "object",
                        properties: {
                          vendor: { type: "string" },
                          expires_date: { type: "string", format: "date" },
                          days_until_expiry: { type: "integer" }
                        }
                      }
                    },
                    summary: { type: "string", description: "One-paragraph summary of the week" }
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
    "/api/costs": {
      get: {
        summary: "Estimate infrastructure costs",
        description: "Estimate monthly costs for a stack of services at different scales. Shows free tier limits, when you'd exceed them, and projected costs.",
        parameters: [
          { name: "services", in: "query", required: true, description: "Comma-separated list of vendor names", schema: { type: "string" }, example: "Vercel,Supabase,Clerk" },
          { name: "scale", in: "query", description: "Usage scale tier", schema: { type: "string", enum: ["hobby", "startup", "growth"], default: "hobby" } }
        ],
        responses: {
          "200": {
            description: "Cost estimates per service and total",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    scale: { type: "string", description: "Scale tier used for estimation" },
                    services: {
                      type: "array",
                      items: {
                        type: "object",
                        properties: {
                          vendor: { type: "string" },
                          free_tier: { type: "string" },
                          estimated_monthly: { type: "string" },
                          notes: { type: "string" }
                        }
                      }
                    },
                    total_estimated_monthly: { type: "string" }
                  }
                }
              }
            }
          },
          "400": { description: "Missing services parameter or invalid scale" }
        }
      }
    },
    "/feed.xml": {
      get: {
        summary: "Atom feed of pricing changes",
        description: "Atom feed of developer tool pricing changes. Subscribe in any feed reader to stay updated on free tier removals, limit changes, and new deals. Also available at /api/feed.",
        responses: {
          "200": {
            description: "Atom XML feed",
            content: {
              "application/atom+xml": {
                schema: { type: "string", format: "binary" }
              }
            }
          }
        }
      }
    },
    "/api/pageviews": {
      get: {
        summary: "Page view analytics",
        description: "Returns server-side page view counts for today, yesterday, all-time top pages, and referrer breakdown. Bot traffic is excluded.",
        responses: {
          "200": {
            description: "Page view data",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    today: {
                      type: "object",
                      properties: {
                        total: { type: "integer" },
                        top_pages: { type: "array", items: { type: "object", properties: { path: { type: "string" }, views: { type: "integer" } } } }
                      }
                    },
                    yesterday: {
                      type: "object",
                      properties: {
                        total: { type: "integer" },
                        top_pages: { type: "array", items: { type: "object", properties: { path: { type: "string" }, views: { type: "integer" } } } }
                      }
                    },
                    all_time: {
                      type: "object",
                      properties: {
                        total: { type: "integer" },
                        top_pages: { type: "array", items: { type: "object", properties: { path: { type: "string" }, views: { type: "integer" } } } }
                      }
                    },
                    referrers_today: { type: "object", additionalProperties: { type: "integer" } }
                  }
                }
              }
            }
          }
        }
      }
    },
    "/api/referral-codes": {
      get: {
        summary: "List all active referral codes (marketplace)",
        description: "Returns all active referral codes across vendors — both platform codes (ours) and agent-submitted marketplace codes. No authentication required. Filter by source or vendor category. Individual vendor lookup: GET /api/referral-codes/{vendor}.",
        parameters: [
          { name: "source", in: "query", description: "Filter by source: platform (our codes) or agent (agent-submitted marketplace codes). Omit to get both.", schema: { type: "string", enum: ["platform", "agent"] } },
          { name: "category", in: "query", description: "Filter by vendor category slug (e.g. cloud-hosting). See /api/categories for valid slugs.", schema: { type: "string" }, example: "cloud-hosting" }
        ],
        responses: {
          "200": {
            description: "Active referral codes across all vendors",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    codes: { type: "array", items: { $ref: "#/components/schemas/ReferralCodeListing" } },
                    total: { type: "integer" }
                  },
                  required: ["codes", "total"]
                },
                example: {
                  codes: [
                    { vendor: "Railway", category: "Cloud Hosting", code: "7RZL9q", referral_url: "https://railway.com?referralCode=7RZL9q", referee_benefit: "$20 in credits", source: "platform" }
                  ],
                  total: 1
                }
              }
            }
          },
          "400": {
            description: "Invalid source or unknown category slug",
            content: { "application/json": { schema: { type: "object", properties: { error: { type: "string" } } } } }
          }
        }
      }
    },
    "/api/referral-codes/{vendor}": {
      get: {
        summary: "Get best referral code for a vendor",
        description: "Returns the best available referral code for a vendor. Platform codes (ours) take priority over agent-submitted marketplace codes. Same shape is inlined on /api/offers, /api/compare, /api/details/{vendor}, /api/newest, and MCP tool responses.",
        parameters: [
          { name: "vendor", in: "path", required: true, description: "Vendor name (case-insensitive)", schema: { type: "string" }, example: "Railway" }
        ],
        responses: {
          "200": {
            description: "Best available referral code",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/ReferralCodeListing" },
                example: { vendor: "Railway", code: "7RZL9q", referral_url: "https://railway.com?referralCode=7RZL9q", referee_benefit: "$20 in credits", source: "platform" }
              }
            }
          },
          "404": { description: "No active referral codes for the requested vendor", content: { "application/json": { schema: { type: "object", properties: { error: { type: "string" } } } } } }
        }
      }
    },
    "/api/stats": {
      get: {
        summary: "Service statistics",
        description: "Returns connection and usage statistics. Session and usage counts persist across deploys via Redis.",
        responses: {
          "200": {
            description: "Service statistics",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    activeSessions: { type: "integer", description: "Currently connected MCP sessions" },
                    totalSessionsAllTime: { type: "integer", description: "Cumulative sessions across all deploys (persisted in Redis)" },
                    totalApiHitsAllTime: { type: "integer", description: "Cumulative REST API hits across all deploys (persisted in Redis)" },
                    totalToolCallsAllTime: { type: "integer", description: "Cumulative MCP tool calls across all deploys (persisted in Redis)" },
                    sessionsToday: { type: "integer", description: "Sessions since midnight UTC (resets daily)" },
                    serverStarted: { type: "string", format: "date-time", description: "ISO timestamp of current server start" },
                    clients: { type: "object", additionalProperties: { type: "integer" }, description: "Cumulative session counts per MCP client name (e.g. claude-desktop, cursor)" }
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
      ReferralCodeListing: {
        type: "object",
        properties: {
          vendor: { type: "string", description: "Vendor/service name" },
          category: { type: "string", nullable: true, description: "Primary category for the vendor (null if unknown)" },
          code: { type: "string", description: "The referral code string" },
          referral_url: { type: "string", format: "uri", description: "Full referral URL the referee should visit" },
          referee_benefit: { type: "string", description: "What the person using the code gets (e.g. '$20 in credits')" },
          source: { type: "string", enum: ["platform", "agent-submitted"], description: "platform = AgentDeals-owned code, agent-submitted = marketplace-submitted code" }
        },
        required: ["vendor", "code", "referral_url", "referee_benefit", "source"]
      },
      DealChange: {
        type: "object",
        properties: {
          vendor: { type: "string" },
          change_type: { type: "string", enum: ["free_tier_removed", "limits_reduced", "restriction", "limits_increased", "new_free_tier", "new_tier", "pricing_restructured", "open_source_killed", "pricing_model_change", "startup_program_expanded", "pricing_postponed", "product_deprecated", "rebranded"] },
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
