import { API_ENDPOINTS, type ApiEndpoint } from "./api-inventory.js";
import { CHANGE_DIRECTION } from "./change-direction.js";
import { MCP_TOOL_NAMES } from "./mcp-tool-inventory.js";
import { RATE_LIMIT_PER_MINUTE, SIGNAL_BODY_MAX } from "./signal.js";
import { SIGNAL_EVENTS } from "./stats.js";

export const CHANGE_TYPES: readonly string[] = Object.keys(CHANGE_DIRECTION);

export const PROVENANCE_REF = "#/components/schemas/Provenance";

export const PATHS_OUTSIDE_THE_ENDPOINT_INVENTORY: Record<string, string> = {
  "/feed.xml": "The Atom alias every page's <link rel=\"alternate\"> points at. /api/feed serves the same body and is the name the endpoint inventory holds it under.",
};

const DOCUMENTED_OPERATIONS: Record<string, Record<string, any>> = {

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
                  total: { type: "integer", description: "Total matching offers (before pagination)" },
                  gated: { type: "integer", description: "How many of the `total` matching offers carry a non-null `gate` — counted over the whole match, not the returned page (#1241)." },
                  gate_summary: { type: "string", description: "One line stating how many of the matching offers are not on our ranked list and why. Absent when `gated` is 0." }
                }
              },
              example: {
                offers: [{ vendor: "Supabase", category: "Cloud Hosting", description: "Open-source Firebase alternative with Postgres database, auth, storage, and edge functions. Free tier: 2 projects, 500MB database, 1GB file storage, 50K monthly active users.", tier: "Free", url: "https://supabase.com/pricing", tags: ["database", "auth", "serverless"], verifiedDate: "2026-03-01", gate: null }],
                total: 1,
                gated: 0
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
      description: "Returns all offer categories with the number of offers in each, the scope statement that says what the name holds, and the other category names that answer the same question. Several names answer one question and hold disjoint sets, so a count alone does not say whether a category is the whole answer: read `also_answering` before deciding a category is empty of what you want. Names in `retired_names` are accepted by `category=` filters and redirect on `/category/`.",
      responses: {
        "200": {
          description: "List of categories with counts, scope statements and the names that answer alongside them",
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
                        slug: { type: "string" },
                        count: { type: "integer" },
                        audience: { type: "string", enum: ["developer", "personal"], description: "Who the products under this name are sold to." },
                        holds: { type: "string", enum: ["products", "programmes"], description: "`programmes` means every member is qualified-access — a startup or accelerator offer, not a free tier anyone can open." },
                        scope: { type: "string", description: "One line saying what this name holds and what it does not." },
                        answers: { type: "array", items: { type: "string" }, description: "The question or questions this name answers." },
                        also_answering: {
                          type: "array",
                          description: "Other categories answering one of the same questions. Their sets are disjoint from this one.",
                          items: { type: "object", properties: { name: { type: "string" }, slug: { type: "string" }, count: { type: "integer" } } }
                        },
                        example_members: { type: "array", items: { type: "string" } }
                      }
                    }
                  },
                  example_members_basis: { type: "string" },
                  retired_names: { type: "object", additionalProperties: { type: "string" }, description: "Category names no longer published, mapped to the name that replaced them." }
                }
              },
              example: {
                categories: [
                  {
                    name: "Cloud Storage",
                    slug: "cloud-storage",
                    count: 9,
                    audience: "personal",
                    holds: "products",
                    scope: "Consumer file-sync drives a person keeps documents and photos in — not storage an application writes to.",
                    answers: ["where do my files live"],
                    also_answering: [
                      { name: "CDN", slug: "cdn", count: 19 },
                      { name: "Storage", slug: "storage", count: 55 }
                    ],
                    example_members: ["Google Drive", "Google Photos", "iCloud"]
                  }
                ],
                retired_names: { "Startup Programs": "Startup Perks" }
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
      description: "Returns tracked pricing and tier changes across vendors. Filter by date, change type, vendor, or category.",
      parameters: [
        { name: "since", in: "query", description: "Filter changes after this date (YYYY-MM-DD)", schema: { type: "string", format: "date" }, example: "2025-01-01" },
        { name: "type", in: "query", description: "Filter by change type. Every type a record can carry is accepted; the same list types the `change_type` field on the records that come back.", schema: { type: "string", enum: [...CHANGE_TYPES] } },
        { name: "vendor", in: "query", description: "Filter by vendor name", schema: { type: "string" } },
        { name: "vendors", in: "query", description: "Comma-separated vendor names to filter by (e.g. 'Vercel,Supabase,Clerk')", schema: { type: "string" }, example: "Vercel,Supabase" },
        { name: "category", in: "query", description: "Comma-separated category names to filter by (e.g. 'Database,Cloud Hosting'). Case-insensitive partial match.", schema: { type: "string" }, example: "Database,Hosting" },
        { name: "categories", in: "query", description: "Comma-separated category names to filter by (e.g. 'Database,Cloud Hosting'). Case-insensitive partial match.", schema: { type: "string" }, example: "Database,Hosting" },
        { name: "limit", in: "query", description: "Max results per page", schema: { type: "integer", default: 20 } },
        { name: "offset", in: "query", description: "Number of results to skip", schema: { type: "integer", default: 0 } }
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
                  total: { type: "integer" },
                  returned: { type: "integer" },
                  limit: { type: "integer" },
                  offset: { type: "integer" },
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
              },
              example: {
                changes: [{ vendor: "Heroku", change_type: "free_tier_removed", date: "2022-11-28", summary: "Heroku eliminated all free dynos, free Postgres, and free Redis.", previous_state: "Free dyno (550-1000 hrs/mo), free Postgres (10K rows), free Redis (25MB)", current_state: "No free tier. Cheapest plan: $5/mo Eco dyno.", impact: "high", source_url: "https://blog.heroku.com/next-chapter", category: "Cloud Hosting", alternatives: ["Railway", "Render", "Fly.io"] }],
                total: 1,
                returned: 1,
                limit: 20,
                offset: 0
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
      description: "Get detailed information about a specific vendor's offer. Optionally includes alternatives in the same category. Accepts canonical vendor names (e.g. \"Supabase\") or short-form slugs (e.g. \"kiro\" → Amazon Kiro, \"proton\" → multi-product disambiguation). Fuzzy matches resolve in-place and return `resolved_from`. Ambiguous inputs return 200 with a `disambiguation` array instead of an `offer`.",
      parameters: [
        { name: "vendor", in: "path", required: true, description: "Vendor name or short-form slug (URL-encoded)", schema: { type: "string" }, example: "Supabase" },
        { name: "alternatives", in: "query", description: "Include alternative vendors in the same category", schema: { type: "string", enum: ["true", "false"], default: "false" } }
      ],
      responses: {
        "200": {
          description: "Vendor offer details, OR a disambiguation list when the input matches multiple vendors (e.g. \"proton\"). When the input was fuzzy-matched to a canonical vendor, the response includes `resolved_from`.",
          content: {
            "application/json": {
              schema: {
                oneOf: [
                  {
                    type: "object",
                    description: "Resolved vendor offer",
                    properties: {
                      offer: { $ref: "#/components/schemas/Offer" },
                      alternatives: { type: "array", items: { $ref: "#/components/schemas/Offer" }, description: "Only present when alternatives=true" },
                      resolved_from: { type: "string", description: "Original input when fuzzy-matched to a canonical vendor (e.g. input \"kiro\" resolves to Amazon Kiro)" }
                    }
                  },
                  {
                    type: "object",
                    description: "Disambiguation list when input matches multiple vendors",
                    required: ["disambiguation", "resolved_from"],
                    properties: {
                      disambiguation: { type: "array", items: { type: "object", properties: { slug: { type: "string" }, name: { type: "string" } } } },
                      resolved_from: { type: "string" }
                    }
                  }
                ]
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
          description: "Vendor not found (no exact match AND no fuzzy resolution)",
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
        { name: "a", in: "query", required: true, description: "First vendor name (case-insensitive; a qualified name such as 'Supabase database' resolves to the vendor it names, see VendorMatch)", schema: { type: "string" }, example: "Supabase" },
        { name: "b", in: "query", required: true, description: "Second vendor name (case-insensitive; a qualified name such as 'Neon free tier' resolves to the vendor it names, see VendorMatch)", schema: { type: "string" }, example: "Neon" }
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
                  vendor_a_match: { $ref: "#/components/schemas/VendorMatch" },
                  vendor_b_match: { $ref: "#/components/schemas/VendorMatch" },
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
        { name: "services", in: "query", required: true, description: "Comma-separated vendor names (e.g. 'Vercel,Supabase,Clerk'). An audit reports only names it matched exactly; anything else comes back as status not_found with suggestions, so that risks_found and cheaper_alternative are never computed for a product you did not name (#1269).", schema: { type: "string" }, example: "Vercel,Supabase,Clerk" }
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
                  risks_found: { type: "number", description: "Services carrying a published caution or risky level. A service whose level is withheld is not counted here — it is unrated, not safe (#1486)." },
                  savings_opportunities: { type: "number" },
                  gaps: { type: "array", items: { type: "object" } },
                  services: {
                    type: "array",
                    items: {
                      type: "object",
                      properties: {
                        vendor: { type: "string" },
                        status: { type: "string", enum: ["found", "not_found"] },
                        category: { type: "string" },
                        tier: { type: "string" },
                        risk_level: { type: "string", enum: ["stable", "caution", "risky"], nullable: true, description: "The same level /api/offers publishes for the record this name resolved to, from the same function (#1486) — null wherever any rule withholds it, and never substituted with a favourable default." },
                        risk_cause: { type: "object", nullable: true, description: "The single dated record that produced a non-stable risk_level." },
                        gate: { type: "object", nullable: true, description: "Non-null for an offer we have decided not to list (#1241). The caller named this vendor, so the gate is reported whether or not a level would have been published." },
                        rating_withheld: { type: "object", nullable: true, description: "Non-null where the only records that would rate this vendor cite no source (#1352)." },
                        link_unreachable: { type: "object", nullable: true, description: "Non-null where the offer's own link is confirmed unreachable (#1046)." },
                        source_check: { type: "object", nullable: true, description: "Our last read of the page we cite. An outcome other than ok withholds a favourable level." },
                        level_withheld_because: { type: "string", nullable: true, description: "The sentence naming the rule that withheld the level, or null where a level is published. A null risk_level always arrives with one." },
                        recent_changes: { type: "array", items: { type: "object" } },
                        cheaper_alternative: { type: "object", nullable: true, description: "A same-category free offer we publish a stable level for. Chosen with the same function as risk_level, so a vendor we decline to rate is never offered as the safer swap (#1486)." },
                        suggestions: { type: "array", items: { type: "string" } }
                      }
                    }
                  },
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
        { name: "vendor", in: "path", required: true, description: "Vendor name (case-insensitive; a qualified name such as 'Vercel Pro plan' resolves to the vendor it names, see VendorMatch)", schema: { type: "string" }, example: "Vercel" }
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
                  vendor_match: { $ref: "#/components/schemas/VendorMatch" },
                  category: { type: "string" },
                  risk_level: { type: "string", enum: ["stable", "caution", "risky"], nullable: true, description: "Null where the offer's own link is confirmed unreachable (#1046) — we withhold the level rather than publish a favourable one we cannot check. Also null where gate is non-null (#1241): an offer we have decided not to list is not one we rate. Also null where rating_withheld is non-null (#1352): the only records that would rate this vendor cite no source." },
                  link_unreachable: { type: "object", nullable: true, description: "Non-null only where a check reached a conclusion about the destination: a 404 confirmed by a full request, a 410, or a hostname with no address. Being refused (403, 429, 5xx, timeout) is evidence about our checker and never produces one of these.", properties: { last_reachable: { type: "string", format: "date", nullable: true }, checked: { type: "string", format: "date" }, terminal: { type: "boolean" } } },
                  risk_cause: { type: "object", nullable: true, description: "The single dated record that produced a non-stable risk_level. Never null when risk_level is caution or risky (#1038) — a client that renders the level must be able to render the reason.", properties: { vendor: { type: "string" }, date: { type: "string" }, change_type: { type: "string" }, summary: { type: "string" }, source_url: { type: "string", nullable: true, description: "The page this record was read from, or null where we hold none. Carried on the cause so a client rendering the reason can cite it." }, current_state: { type: "string" }, resolution: { $ref: "#/components/schemas/ChangeResolution" } } },
                  rating_withheld: { type: "object", nullable: true, description: "Non-null where every record that would have set a non-stable risk_level carries an empty source_url (#1352). The level is withheld rather than reported as stable, and the records are named on the vendor page marked as unsourced.", properties: { reason: { type: "string", enum: ["no_source"] }, records: { type: "number" } } },
                  gate: { $ref: "#/components/schemas/Gate" },
                  source_check: { $ref: "#/components/schemas/SourceCheck" },
                  free_tier_longevity_days: { type: "number", nullable: true, description: "Null where the gate code is offer_retired or not_a_free_offer (#1241) — a count of days a free tier has held has no referent where our own record says there is no free tier." },
                  changes: { type: "array", items: { $ref: "#/components/schemas/DealChange" } },
                  alternatives: {
                    type: "array",
                    items: {
                      type: "object",
                      properties: {
                        vendor: { type: "string" },
                        category: { type: "string" },
                        tier: { type: "string" },
                        risk_level: { type: "string", enum: ["stable", "caution", "risky"], nullable: true, description: "Null where this alternative's own link is confirmed unreachable (#1046), null where its rating_withheld is non-null (#1352), and null where its gate is non-null (#1241) — rankForListing demotes a gated record to the tail rather than dropping it, so an alternative can be one we do not list. The same function decides this as decides the level on the offer itself (#1486)." },
                        link_unreachable: { type: "object", nullable: true, properties: { last_reachable: { type: "string", format: "date", nullable: true }, checked: { type: "string", format: "date" }, terminal: { type: "boolean" } } },
                        gate: { $ref: "#/components/schemas/Gate" },
                        risk_cause: { type: "object", nullable: true, description: "The single dated record that produced a non-stable risk_level. Never null when risk_level is caution or risky (#1038) — a client that renders the level must be able to render the reason.", properties: { vendor: { type: "string" }, date: { type: "string" }, change_type: { type: "string" }, summary: { type: "string" }, source_url: { type: "string", nullable: true, description: "The page this record was read from, or null where we hold none. Carried on the cause so a client rendering the reason can cite it." }, current_state: { type: "string" }, resolution: { $ref: "#/components/schemas/ChangeResolution" } } },
                        rating_withheld: { type: "object", nullable: true, description: "Non-null where every record that would have set a non-stable risk_level carries an empty source_url (#1352). The level is withheld rather than reported as stable.", properties: { reason: { type: "string", enum: ["no_source"] }, records: { type: "number" } } }
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
                        last_read_date: { type: "string", format: "date" },
                        url: { type: "string", format: "uri" },
                        days_since_verified: { type: "integer" },
                        days_since_read: { type: "integer" }
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
                        last_read_date: { type: "string", format: "date" },
                        url: { type: "string", format: "uri" },
                        days_since_verified: { type: "integer" },
                        days_since_read: { type: "integer" }
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
                  },
                  quarantine: {
                    type: "object",
                    description: "Offers the re-verification job has stopped checking daily because three consecutive checks failed. They are retried on a backoff; the entry says what failed and when it is next due.",
                    properties: {
                      count: { type: "integer" },
                      retry_after_days: { type: "integer" },
                      by_reason: { type: "object", additionalProperties: { type: "integer" } },
                      entries: {
                        type: "array",
                        items: {
                          type: "object",
                          properties: {
                            vendor: { type: "string" },
                            url: { type: "string", format: "uri" },
                            consecutive_failures: { type: "integer" },
                            failure_category: { type: "string", nullable: true },
                            last_error: { type: "string", nullable: true },
                            last_attempt_at: { type: "string", format: "date", nullable: true },
                            last_success: { type: "string", format: "date", nullable: true },
                            quarantined_since: { type: "string", format: "date", nullable: true },
                            next_retry: { type: "string", format: "date", nullable: true }
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
                        date: { type: "string", format: "date", description: "When the change took effect, unless date_source is \"discovered\" — then it is the day we found it and the effective date is unknown." },
                        date_source: { type: "string", enum: ["vendor_page", "hand_written", "discovered"], description: "Where date came from. \"vendor_page\": the vendor's page stated it. \"hand_written\": a person recorded it before this field existed. \"discovered\": the page stated no effective date, so date is the day we read the page — do not present it as the date the vendor changed anything." },
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
      summary: "Get free-tier stack candidates per role",
      description: "For each role in your project type (hosting, database, auth, …) returns the set of free-tier offers whose terms we can stand behind today — deliberately not a single pick, because under every signal we record dozens of them tie. Each candidate carries its demerits, with the recorded fact and date behind each, plus any recorded changes we disclose but do not rank on. This endpoint does NOT model technical fit between a product and a role; the caller must apply that. The method is published at /criteria, and every role returns the tie_break seed so its order can be recomputed independently.",
      parameters: [
        { name: "use_case", in: "query", required: true, description: "What you're building (e.g., 'Next.js SaaS app', 'API backend', 'static blog')", schema: { type: "string" }, example: "Next.js SaaS app" },
        { name: "requirements", in: "query", description: "Comma-separated infrastructure needs (e.g., 'database,auth,email')", schema: { type: "string" }, example: "database,auth,email" }
      ],
      responses: {
        "200": {
          description: "Candidate sets per role, with the evidence behind each",
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
                        category: { type: "string" },
                        candidates: {
                          type: "array",
                          description: "The rotated tied set for this role, capped at 8. Not ordered by merit — every member is indistinguishable under our criteria.",
                          items: {
                            type: "object",
                            properties: {
                              vendor: { type: "string" },
                              tier: { type: "string" },
                              description: { type: "string" },
                              url: { type: "string", format: "uri" },
                              verified_date: { type: "string", format: "date" },
                              last_read_date: { type: "string", format: "date", description: "The day we last read this vendor's page, whatever that read concluded. verified_date is the day we last confirmed the terms we publish, so this is the later of the two whenever a read found something we had not recorded." },
                              risk_level: { type: "string", enum: ["stable", "caution", "risky"], nullable: true, description: "The same level /api/offers publishes for this record, from the same function (#1486). Null where we withhold it rather than publish a favourable one we cannot stand behind. A null always arrives with the field naming the rule that withheld it, and with level_withheld_because." },
                              rating_withheld: { type: "object", nullable: true, description: "Non-null where every record that would have set a non-stable risk_level carries an empty source_url (#1352). The level is withheld rather than reported as stable.", properties: { reason: { type: "string", enum: ["no_source"] }, records: { type: "number" } } },
                              gate: { type: "object", nullable: true, description: "Non-null for an offer we have decided not to list (#1241). A candidate set is drawn from ungated offers, so this is null in practice and is carried because the level's rules are one set." },
                              source_check: { type: "object", nullable: true, description: "Our last read of the page we cite. An outcome other than ok withholds a favourable level." },
                              level_withheld_because: { type: "string", nullable: true, description: "The sentence naming the rule that withheld the level, or null where a level is published." },
                              stability: { type: "string", enum: ["stable", "watch", "volatile", "improving"], nullable: true, description: "Null where a favourable class would rest on records we cannot stand behind (#1561). Withheld by every reason that withholds risk_level: an unreachable pricing page, a page stating no amount, tier or rate we can read, a refused read, a narrowing citing no source, or a gated listing. A null always arrives with stability_withheld_because." },
                              stability_withheld: { type: "object", nullable: true, description: "Non-null where a standing narrowing for this vendor cites no source, so a favourable stability class is withheld rather than published.", properties: { reason: { type: "string", enum: ["no_source"] }, records: { type: "number" } } },
                              stability_withheld_because: { type: "string", nullable: true, description: "The code naming the rule that withheld the stability class, or null where a class is published." },
                              link_unreachable: { type: "object", nullable: true, description: "Non-null where the offer's own link has not resolved for us (#1046).", properties: { last_reachable: { type: "string", nullable: true }, checked: { type: "string" }, terminal: { type: "boolean" } } },
                              demerits: { type: "array", description: "Empty when we hold nothing against the offer.", items: { type: "object", properties: { code: { type: "string" }, points: { type: "integer" }, reason: { type: "string" }, date: { type: "string" }, about_us: { type: "boolean", description: "True when the demerit describes a limit of ours rather than a fact about the vendor." } } } },
                              disclosures: { type: "array", description: "Recorded changes shown but never ranked on.", items: { type: "object", properties: { code: { type: "string" }, date: { type: "string" }, summary: { type: "string" } } } }
                            }
                          }
                        },
                        tie_count: { type: "integer", description: "How many offers tie at zero demerits in this role." },
                        eligible_count: { type: "integer" },
                        demoted_count: { type: "integer" },
                        excluded_count: { type: "integer" },
                        reason: { type: "string" },
                        tie_break: { type: "object", properties: { date: { type: "string" }, query_key: { type: "string" }, seed: { type: "string" }, tie_count: { type: "integer" }, algorithm: { type: "string" } } }
                      }
                    }
                  },
                  method: { type: "object", properties: { policy: { type: "string" }, not_modelled: { type: "string" }, criteria_url: { type: "string" } } },
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
      description: "Returns recent request-level log entries for both MCP tool calls and REST API hits. Stored in Redis, capped at 1000 entries. Query parameter values are not published: each entry reports the parameter names it carried and the length of each value. Session identifiers are not published either; entries from one session share a session_index that is assigned within a single response and carries no meaning across responses.",
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
                        type: { type: "string", enum: ["mcp", "api", "session_connect"] },
                        endpoint: { type: "string" },
                        param_lengths: {
                          type: "object",
                          description: "Parameter name to the character length of the value that was sent. Values themselves are retained internally and never published.",
                          additionalProperties: { type: "integer" }
                        },
                        user_agent: { type: "string" },
                        result_count: { type: "integer" },
                        session_index: { type: "integer", description: "Groups entries from the same session within this response only." },
                        client_info: {
                          type: "object",
                          properties: { name: { type: "string" }, version: { type: "string" } }
                        }
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
      summary: "List every referral code we hold",
      description: "Returns every active referral code AgentDeals holds, with the reader benefit and every restriction on each. No authentication required. Filter by vendor category. Individual vendor lookup: GET /api/referral-codes/{vendor}. Agent-submitted codes are retired: source=agent answers 200 with an empty list and the reason.",
      parameters: [
        { name: "source", in: "query", description: "platform returns the codes we hold, which is every code we serve. agent is retired and returns an empty list with the reason.", schema: { type: "string", enum: ["platform", "agent"] } },
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
                  { vendor: "Railway", category: "Cloud Hosting", code: "7RZL9q", referral_url: "https://railway.com?referralCode=7RZL9q", referee_benefit: "$20 in credits", restrictions: [], source: "platform" }
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
      description: "Returns the referral code AgentDeals holds for a vendor, or 404 when we hold none. Same shape is inlined on /api/offers, /api/compare, /api/details/{vendor}, /api/newest, and MCP tool responses.",
      parameters: [
        { name: "vendor", in: "path", required: true, description: "Vendor name (case-insensitive)", schema: { type: "string" }, example: "Railway" }
      ],
      responses: {
        "200": {
          description: "Best available referral code",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ReferralCodeListing" },
              example: { vendor: "Railway", code: "7RZL9q", referral_url: "https://railway.com?referralCode=7RZL9q", referee_benefit: "$20 in credits", restrictions: [], source: "platform" }
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
                  sessionsToday: { type: "integer", description: "Sessions opened since midnight UTC. Persisted per day, so a deploy does not reset it. Counts only from the date the daily series began — see sessions.recording_since on /api/traffic." },
                  serverStarted: { type: "string", format: "date-time", description: "ISO timestamp of current server start" },
                  clients: { type: "object", additionalProperties: { type: "integer" }, description: "Cumulative session counts per MCP client name (e.g. claude-desktop, cursor)" },
                  toolCallsByClient: { type: "object", additionalProperties: { type: "integer" }, description: "Cumulative MCP tool-call counts per MCP client name. Missing/empty client IDs bucket to 'unknown'. Values sum to totalToolCallsAllTime (invariant)." },
                  toolCallsByName: { type: "object", additionalProperties: { type: "integer" }, description: `Cumulative MCP tool-call counts per tool name. The tools we offer are ${MCP_TOOL_NAMES.join(", ")}; counts against names no longer offered are historical and stay in the total. Pre-feature historical calls bucket to 'unknown'. Values sum to totalToolCallsAllTime (invariant).` }
                }
              }
            }
          }
        }
      }
    }
  },
  "/api/deadlines": {
    get: {
      summary: "Future-dated changes with a countdown",
      description: "Every tracked change whose date is still ahead of today, soonest first, each with the number of days remaining. Use it to find the deadlines a stack is about to run into rather than the ones it has already passed.",
      parameters: [
        { name: "type", in: "query", description: "Return only changes of this type.", schema: { type: "string", enum: [...CHANGE_TYPES] } }
      ],
      responses: {
        "200": {
          description: "Future-dated changes ordered by date",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  deadlines: {
                    type: "array",
                    items: { allOf: [{ $ref: "#/components/schemas/DealChange" }, { type: "object", properties: { countdown_days: { type: "integer", description: "Whole days from today, UTC, to the date on the record." } } }] }
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
  "/api/ai-coding-pricing": {
    get: {
      summary: "AI coding tool pricing",
      description: "The AI Coding records and the tracked changes against them, in one response. Every record is the same one /api/offers returns, with the path to our page for that vendor added.",
      parameters: [
        { name: "type", in: "query", description: "Return only tools of this kind.", schema: { type: "string", enum: ["ide", "cli", "cloud-agent", "app-builder"] } }
      ],
      responses: {
        "200": {
          description: "AI coding tools, the changes recorded against them, and the kinds on offer",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  tools: { type: "array", items: { allOf: [{ $ref: "#/components/schemas/Offer" }, { type: "object", properties: { vendor_page: { type: "string", description: "Path to our page for this vendor." } } }] } },
                  changes: { type: "array", items: { $ref: "#/components/schemas/DealChange" } },
                  count: { type: "integer" },
                  categories: { type: "array", items: { type: "string" }, description: "The values the type parameter accepts." }
                }
              }
            }
          }
        }
      }
    }
  },
  "/api/hosting-pricing": {
    get: {
      summary: "Cloud hosting and PaaS pricing",
      description: "The hosting and platform records and the tracked changes against them, in one response. has_referral says whether we hold a referral code for the vendor; the code itself is on /api/referral-codes/{vendor}.",
      parameters: [
        { name: "type", in: "query", description: "Return only platforms of this kind.", schema: { type: "string", enum: ["traditional-paas", "edge-serverless", "full-featured", "static-specialized"] } }
      ],
      responses: {
        "200": {
          description: "Hosting platforms, the changes recorded against them, and the kinds on offer",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  platforms: { type: "array", items: { allOf: [{ $ref: "#/components/schemas/Offer" }, { type: "object", properties: { vendor_page: { type: "string" }, has_referral: { type: "boolean" } } }] } },
                  changes: { type: "array", items: { $ref: "#/components/schemas/DealChange" } },
                  count: { type: "integer" },
                  categories: { type: "array", items: { type: "string" }, description: "The values the type parameter accepts." }
                }
              }
            }
          }
        }
      }
    }
  },
  "/api/llm-pricing": {
    get: {
      summary: "LLM API pricing",
      description: "The LLM API records and the tracked changes against them, in one response. A provider with no free allowance is still returned, with its gate stating why we do not rank it.",
      parameters: [
        { name: "type", in: "query", description: "Return only providers of this kind.", schema: { type: "string", enum: ["frontier", "inference", "open-source-host", "specialized"] } }
      ],
      responses: {
        "200": {
          description: "LLM API providers, the changes recorded against them, and the kinds on offer",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  providers: { type: "array", items: { allOf: [{ $ref: "#/components/schemas/Offer" }, { type: "object", properties: { vendor_page: { type: "string" } } }] } },
                  changes: { type: "array", items: { $ref: "#/components/schemas/DealChange" } },
                  count: { type: "integer" },
                  categories: { type: "array", items: { type: "string" }, description: "The values the type parameter accepts." }
                }
              }
            }
          }
        }
      }
    }
  },
  "/api/startup-credits": {
    get: {
      summary: "Startup credits and programmes",
      description: "The qualified-access records — accelerator, incubator and founder programmes — and the tracked changes against them. Every member has conditions on it: read eligibility before presenting a ceiling as available.",
      parameters: [
        { name: "type", in: "query", description: "Return only programmes of this kind.", schema: { type: "string", enum: ["cloud-infrastructure", "fintech-banking", "developer-tools", "ai-tools"] } }
      ],
      responses: {
        "200": {
          description: "Startup programmes, the changes recorded against them, and the kinds on offer",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  programs: { type: "array", items: { allOf: [{ $ref: "#/components/schemas/Offer" }, { type: "object", properties: { vendor_page: { type: "string" } } }] } },
                  changes: { type: "array", items: { $ref: "#/components/schemas/DealChange" } },
                  count: { type: "integer" },
                  categories: { type: "array", items: { type: "string" }, description: "The values the type parameter accepts." }
                }
              }
            }
          }
        }
      }
    }
  },
  "/api/referral-programs": {
    get: {
      summary: "Vendors running a referral or affiliate programme",
      description: "Vendors whose own referral programme is open to anyone, with what the referrer and the referee each get. This is not the list of codes we hold and earn on — that is /api/referral-codes, and /disclosure names every one of them.",
      parameters: [
        { name: "category", in: "query", description: "Filter by vendor category name. The categories field lists the ones present.", schema: { type: "string" }, example: "Cloud Hosting" }
      ],
      responses: {
        "200": {
          description: "Referral programmes and the categories they fall in",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  programs: {
                    type: "array",
                    items: {
                      type: "object",
                      properties: {
                        vendor: { type: "string" },
                        category: { type: "string" },
                        referrer_benefit: { type: "string", description: "What the person sharing the link gets." },
                        referee_benefit: { type: "string", description: "What the person using the link gets." },
                        program_url: { type: "string", format: "uri", description: "The vendor's own page describing the programme." },
                        type: { type: "string" },
                        commission_type: { type: "string" },
                        vendor_page: { type: "string" }
                      }
                    }
                  },
                  count: { type: "integer" },
                  categories: { type: "array", items: { type: "string" } }
                }
              }
            }
          }
        }
      }
    }
  },
  "/api/digest/weekly": {
    get: {
      summary: "Weekly digest, formatted",
      description: "One week of tracked changes, rendered. format=json returns the digest as data with the markdown and HTML renderings alongside it; format=markdown and format=html return that rendering as the body, so only format=json carries a citation block.",
      parameters: [
        { name: "format", in: "query", description: "Which rendering to return as the body. Default json.", schema: { type: "string", enum: ["json", "markdown", "html"], default: "json" } },
        { name: "limit", in: "query", description: "Max changes to include.", schema: { type: "integer" } },
        { name: "weeks_ago", in: "query", description: "0 is the current week, 1 the week before it.", schema: { type: "integer", default: 0 } }
      ],
      responses: {
        "200": {
          description: "The week's digest in the requested rendering",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  week_of: { type: "string", format: "date" },
                  week_ending: { type: "string", format: "date" },
                  total_changes: { type: "integer", description: "Every change we hold, not only this week's." },
                  changes_in_week: { type: "integer", description: "Changes the vendor made within the week." },
                  discovered_in_week: { type: "integer", description: "Changes recorded within the week, whatever date they carry. A change dated earlier that we found this week is counted here and not in changes_in_week." },
                  summary: { type: "object", additionalProperties: { type: "integer" }, description: "Counts by change type for the week." },
                  headline: { type: "string" },
                  top_changes: { type: "array", items: { $ref: "#/components/schemas/DealChange" } },
                  discovered_changes: { type: "array", items: { $ref: "#/components/schemas/DealChange" } },
                  discovery_note: { type: "string", description: "States which of the two counts the listed changes are drawn from." },
                  digest_markdown: { type: "string" },
                  digest_html: { type: "string" }
                }
              }
            },
            "text/markdown": { schema: { type: "string" } },
            "text/html": { schema: { type: "string" } }
          }
        }
      }
    }
  },
  "/api/feed": {
    get: {
      summary: "Atom feed of pricing changes",
      description: "The same Atom body served at /feed.xml, which is the href every page's feed autodiscovery link carries.",
      responses: {
        "200": {
          description: "Atom XML feed",
          content: { "application/atom+xml": { schema: { type: "string", format: "binary" } } }
        }
      }
    }
  },
  "/api/traffic": {
    get: {
      summary: "Traffic by client class",
      description: "Our own request counters, split by what made the request — AI agent, crawler or browser — with MCP tool calls alongside web hits so the two can be compared. These are counts of visits to us, not index data, so no citation block is attached. available is false when the store backing the daily series is not configured, and error then says so.",
      responses: {
        "200": {
          description: "Traffic counters over several windows",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  today: { $ref: "#/components/schemas/TrafficWindow" },
                  last_7d: { $ref: "#/components/schemas/TrafficWindow" },
                  last_30d: { $ref: "#/components/schemas/TrafficWindow" },
                  web_vs_mcp: { type: "object", additionalProperties: { type: "object" }, description: "Web hits, AI-agent hits and MCP tool calls per window, with the ratios between them. A ratio is null when the denominator is zero." },
                  available: { type: "boolean", description: "Whether the daily series has a store behind it. False means only the since-boot counters are meaningful." },
                  error: { type: "string", description: "Why the daily series is unavailable, when it is." },
                  since_boot_by_class: { type: "object", additionalProperties: { type: "integer" } },
                  since_boot_not_found: { type: "integer" },
                  since_boot_redirects: { type: "integer" },
                  not_found_sample: { type: "array", items: { type: "object", properties: { ts: { type: "string", format: "date-time" }, client_class: { type: "string" }, status: { type: "integer" }, path: { type: "string" } } } },
                  sessions: { type: "object", properties: { daily: { type: "array", items: { type: "object" } }, today: { type: "integer" }, recording_since: { type: "string", format: "date", nullable: true, description: "The first day of the daily series. A count before this date is not missing, it was never recorded." }, all_time: { type: "integer" }, retention_days: { type: "integer" } } },
                  ai_agent_trigger_families: { type: "object", additionalProperties: { type: "array", items: { type: "string" } }, description: "Which user agents we read as user-initiated, as search indexing, and as training crawls." },
                  notes: { type: "array", items: { type: "string" }, description: "What each figure does and does not count, including how much of it is our own crawling." },
                  storage: { type: "object", description: "Whether the counters are being persisted, and the failures if not." },
                  vendor_series: { type: "object", description: "State of the per-vendor daily series." }
                }
              }
            }
          }
        }
      }
    }
  },
  "/api/watchlist": {
    post: {
      summary: "Subscribe to a vendor's pricing changes",
      description: "Registers a webhook to be called when a change is recorded against a vendor. The response carries a secret used to sign the deliveries; it is returned once and not readable afterwards. Subscribing twice for the same vendor and URL is a conflict, not a second subscription.",
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: {
              type: "object",
              properties: {
                vendor: { type: "string", description: "Vendor name, as /api/offers returns it." },
                webhook_url: { type: "string", format: "uri", description: "Absolute URL we POST to." }
              },
              required: ["vendor", "webhook_url"]
            },
            example: { vendor: "Supabase", webhook_url: "https://example.com/hooks/agentdeals" }
          }
        }
      },
      responses: {
        "201": {
          description: "Subscription created",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  id: { type: "string" },
                  vendor: { type: "string" },
                  webhook_url: { type: "string", format: "uri" },
                  secret: { type: "string", description: "Signs the delivery. Returned only here." },
                  created_at: { type: "string", format: "date-time" }
                }
              }
            }
          }
        },
        "400": { description: "Body is not JSON, or vendor or webhook_url is missing or not a URL", content: { "application/json": { schema: { type: "object", properties: { error: { type: "string" } } } } } },
        "409": { description: "The subscription was refused: this vendor and URL are already subscribed, or this URL has reached the cap on vendors it may watch. The error says which.", content: { "application/json": { schema: { type: "object", properties: { error: { type: "string" } } } } } },
        "503": { description: "The subscription could not be persisted, so it was not created", content: { "application/json": { schema: { type: "object", properties: { error: { type: "string" } } } } } }
      }
    },
    get: {
      summary: "List watchlist subscriptions",
      description: "Subscriptions we hold, without their secrets. Pass the webhook URL to see only the subscriptions pointing at it.",
      parameters: [
        { name: "webhook_url", in: "query", description: "Return only subscriptions delivering to this URL.", schema: { type: "string", format: "uri" } }
      ],
      responses: {
        "200": {
          description: "Subscriptions and their count",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  subscriptions: { type: "array", items: { $ref: "#/components/schemas/WatchlistSubscription" } },
                  total: { type: "integer" }
                }
              }
            }
          }
        }
      }
    }
  },
  "/api/watchlist/{id}": {
    get: {
      summary: "Read one subscription",
      description: "The subscription's state, including the last change delivered against it. The secret is not returned.",
      parameters: [
        { name: "id", in: "path", required: true, description: "Subscription id, as returned when it was created.", schema: { type: "string" } }
      ],
      responses: {
        "200": {
          description: "The subscription",
          content: {
            "application/json": {
              schema: {
                allOf: [
                  { $ref: "#/components/schemas/WatchlistSubscription" },
                  { type: "object", properties: { last_notified_change: { type: "string", nullable: true, description: "The last change we delivered on this subscription, or null if none has been." } } }
                ]
              }
            }
          }
        },
        "404": { description: "No subscription with this id", content: { "application/json": { schema: { type: "object", properties: { error: { type: "string" } } } } } }
      }
    },
    delete: {
      summary: "Unsubscribe",
      description: "Removes the subscription. Deleting one that is already gone is a 404, not a success.",
      parameters: [
        { name: "id", in: "path", required: true, description: "Subscription id.", schema: { type: "string" } }
      ],
      responses: {
        "200": { description: "Removed", content: { "application/json": { schema: { type: "object", properties: { ok: { type: "boolean" } } } } } },
        "404": { description: "No subscription with this id", content: { "application/json": { schema: { type: "object", properties: { error: { type: "string" } } } } } },
        "503": { description: "The removal could not be persisted, so it did not take effect", content: { "application/json": { schema: { type: "object", properties: { error: { type: "string" } } } } } }
      }
    }
  },
  "/api/signal": {
    post: {
      summary: "Report a vendor you recommended",
      description: "The attribution beacon. Tell us which vendor from one of our responses you named in your answer, and whether your user went on to sign up. No authentication. What we record is the vendor slug, the event, and an optional note — notes may be shared verbatim with the vendor named, so send nothing about your user. Counts collected here are published as self-reported and never affect any order we publish. A caller that cannot issue a POST may send the same fields as a query string on a GET to this path with ack=1, which is described at /signal.",
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: {
              type: "object",
              properties: {
                event: { type: "string", enum: [...SIGNAL_EVENTS], description: "recommended when you named the vendor in an answer; converted when your user signed up. An unrecognised value is still recorded, and the response says it was not recognised." },
                vendor: { type: "string", description: "The vendor slug, as a response of ours carries it. A name we cannot resolve is recorded unresolved rather than refused." },
                source: { type: "string" },
                agent: { type: "string" },
                agent_id: { type: "string" },
                note: { type: "string", description: "Optional, and may be shared verbatim with the vendor named." }
              },
              required: ["event", "vendor"]
            },
            example: { event: "recommended", vendor: "supabase" }
          },
          "application/x-www-form-urlencoded": {
            schema: { type: "object", properties: { event: { type: "string" }, vendor: { type: "string" }, note: { type: "string" } } }
          }
        }
      },
      responses: {
        "202": {
          description: "Recorded",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  ok: { type: "boolean" },
                  recorded: { type: "string", description: "The event as we stored it." },
                  vendor: { type: "string", nullable: true },
                  vendor_resolved: { type: "boolean", description: "Present and false when the name did not resolve to a vendor we hold." },
                  unresolved_name: { type: "string", description: "Present with vendor_resolved, carrying the name as sent." },
                  event_recognized: { type: "boolean", description: "Present and false when the event is not one we know." },
                  valid_events: { type: "array", items: { type: "string" } },
                  note_received: { type: "boolean" },
                  note_redacted: { type: "boolean" },
                  note_published: { type: "boolean" },
                  agent_id_reserved: { type: "boolean" },
                  self_reported: { type: "boolean", description: "Always true. Every count here is the caller's own claim and is published as one." },
                  affects_ranking: { type: "boolean", description: "Always false." },
                  docs: { type: "string" }
                }
              }
            }
          }
        },
        "400": { description: "event or vendor is missing", content: { "application/json": { schema: { type: "object", properties: { ok: { type: "boolean" }, error: { type: "string" }, hint: { type: "string" }, valid_events: { type: "array", items: { type: "string" } } } } } } },
        "405": { description: "A method other than POST, or a GET without ack=1", content: { "application/json": { schema: { type: "object", properties: { ok: { type: "boolean" }, error: { type: "string" }, docs: { type: "string" } } } } } },
        "413": { description: `A body over ${SIGNAL_BODY_MAX} bytes`, content: { "application/json": { schema: { type: "object", properties: { ok: { type: "boolean" }, error: { type: "string" }, max_bytes: { type: "integer" }, docs: { type: "string" } } } } } },
        "429": { description: `Over ${RATE_LIMIT_PER_MINUTE} requests a minute from one caller. Retry-After carries the wait.`, content: { "application/json": { schema: { type: "object", properties: { ok: { type: "boolean" }, error: { type: "string" }, retry_after_seconds: { type: "integer" }, docs: { type: "string" } } } } } }
      }
    }
  },
  "/api/openapi.json": {
    get: {
      summary: "This document",
      description: "The OpenAPI 3.0 description of this API. Its path list is built from the same endpoint inventory that renders /developers and the request block on the home page, so a route reachable from either is described here.",
      responses: {
        "200": {
          description: "OpenAPI 3.0 document",
          content: { "application/json": { schema: { type: "object" } } }
        }
      }
    }
  },
  "/api/docs": {
    get: {
      summary: "Browsable API reference",
      description: "Renders this document as a page you can issue requests from.",
      responses: {
        "200": {
          description: "HTML page",
          content: { "text/html": { schema: { type: "string" } } }
        }
      }
    }
  }
};

export const openapiSpec = {
  openapi: "3.0.3",
  info: {
    title: "AgentDeals API",
    description: [
      "Aggregated free tiers, discounts, and startup programs for developer infrastructure. No authentication is required on any path described here.",
      `This document's path list is built from the same endpoint inventory that renders /developers and the request block on the home page, so every route either of those offers is described here, read and write alike. The write paths in it are ${writePaths().join(", ")}.`,
      "Three classes of route answer and are deliberately absent. Routes serving one caller's own state — a registration, a submission, a subscription belonging to whoever created it. Routes serving our own operational counters and editorial registers. And POST /api/agents/register, which mints a key read by features this document does not describe; it is not offered as a public capability.",
      "Every response carrying index data includes a `_provenance` object, described by the Provenance schema, so a figure can be attributed without parsing a sentence."
    ].join("\n\n"),
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
  paths: pathsFor(),
  components: {
    schemas: {
      Provenance: {
        type: "object",
        description: "Where the figures in this response came from and how to attribute them. Every response carrying index data has one, under the key `_provenance`. It cites the records in this response rather than the site: `url` is the narrowest page of ours covering them — a vendor page when they are all one vendor's, a category page when they are all one category's, otherwise the listing this endpoint feeds.",
        properties: {
          source: { type: "string", description: "Always AgentDeals." },
          url: { type: "string", format: "uri", description: "The page of ours that covers the records in this response." },
          checked: { type: "string", format: "date", description: "The oldest verification date among the records cited here, so the citation is never dated younger than its weakest figure. Absent when no record in the response carries a date." },
          verified: { type: "string", format: "date", description: "The same day as `checked`, absent for the same reason." },
          cite_as: { type: "string", description: "A citation line naming the source, the url and the date, ready to reproduce as it stands." },
          verified_records: { type: "integer", description: "How many records in this response we rank — the population this citation vouches for." },
          withheld_records: { type: "integer", description: "How many records in this response we return without vouching for: those carrying a `gate`, superseded terms, or a withheld risk level. Absent when there are none." },
          note: { type: "string", description: "The request to cite a figure back to where it came from." },
          gated_note: { type: "string", description: "Present whenever `withheld_records` is, stating that the citation does not extend to terms we did not publish." },
          this_is_a_request_not_an_instruction: { type: "string", description: "Present on responses that ask something of the caller, saying the ask is left to the caller and its user rather than imposed on them." }
        },
        required: ["source", "url", "cite_as", "verified_records", "note"]
      },
      TrafficWindow: {
        type: "object",
        description: "Request counts over one window. `coverage` says how much of the window we hold data for, so a low figure can be read as quiet rather than as unrecorded.",
        properties: {
          days: { type: "integer" },
          from: { type: "string", format: "date" },
          to: { type: "string", format: "date" },
          detail_days: { type: "integer" },
          data_days_available: { type: "integer" },
          coverage: { type: "string" },
          hits_total: { type: "integer" },
          hits_excluding_internal: { type: "integer", description: "Hits with our own crawling removed." },
          by_class: { type: "object", additionalProperties: { type: "integer" }, description: "Hits per client class." },
          ai_agent_by_family: { type: "object", additionalProperties: { type: "integer" } },
          ai_agent_by_trigger: { type: "object", additionalProperties: { type: "integer" }, description: "AI-agent hits split by whether a person asked for them." }
        }
      },
      WatchlistSubscription: {
        type: "object",
        description: "A registered webhook. The signing secret is returned once, when the subscription is created, and never again.",
        properties: {
          id: { type: "string" },
          vendor: { type: "string" },
          webhook_url: { type: "string", format: "uri" },
          created_at: { type: "string", format: "date-time" }
        },
        required: ["id", "vendor", "webhook_url", "created_at"]
      },
      Offer: {
        type: "object",
        properties: {
          vendor: { type: "string", description: "Vendor/service name" },
          category: { type: "string", description: "Offer category" },
          description: { type: "string", description: "Description of the offer and free tier details" },
          tier: { type: "string", description: "Tier name (e.g. Free, Free Credits, Open Source)" },
          url: { type: "string", format: "uri", description: "Pricing/offer page URL" },
          tags: { type: "array", items: { type: "string" }, description: "Searchable tags" },
          verifiedDate: { type: "string", format: "date", description: "The day we last read the page and confirmed the terms this record publishes (YYYY-MM-DD). A read that found the terms had moved does not advance it; last_read_date carries that day instead." },
          last_read_date: { type: "string", format: "date", description: "The day we last read the vendor's page, whatever the read concluded (YYYY-MM-DD). Never earlier than verifiedDate, and later than it wherever a read has succeeded since the last confirmation. A read that failed — the page did not resolve, or did not name the vendor or product — does not advance it." },
          eligibility: { $ref: "#/components/schemas/Eligibility" },
          gate: { $ref: "#/components/schemas/Gate" },
          risk_level: { type: "string", enum: ["stable", "caution", "risky"], nullable: true, description: "Our published pricing-risk verdict, or null where a rule withholds it: gate is non-null (#1241, #1260), rating_withheld is non-null (#1352), or the page we cite could not confirm the record — link_unreachable, or a source_check outcome of does_not_name_vendor, does_not_name_product, states_no_terms or unreadable (#1046, #1500). One function applies all three rules and every surface that publishes a level calls it, so /api/audit-stack, /api/stack, /stack-check and MCP plan_stack answer the same as this field for the same record on the same day (#1486)." },
          source_check: { $ref: "#/components/schemas/SourceCheck" }
        },
        required: ["vendor", "category", "description", "tier", "url", "tags", "verifiedDate"]
      },
      VendorMatch: {
        type: "object",
        description: "Which name you asked about and which record answered. A name we hold verbatim matches exact. A name we do not hold matches inferred only when a vendor name we do hold appears in it as a whole word or dotted segment — \"AWS Lambda Free\" resolves to AWS, \"launchdarkly.com\" to LaunchDarkly. A fragment that merely appears inside a longer vendor name resolves to nothing and returns 404 with suggestions, because an accidental hit used to be returned shaped exactly like an exact one (#1269).",
        properties: {
          requested: { type: "string", description: "The name as you sent it." },
          matched: { type: "string", description: "The vendor this response is about." },
          type: { type: "string", enum: ["exact", "inferred"] }
        },
        required: ["requested", "matched", "type"]
      },
      SourceCheck: {
        type: "object",
        nullable: true,
        description: "What we found on the page at url when we last read it, and so how much of this record that page supports. The outcome grades our evidence, not the offer (#1268).",
        properties: {
          checked: { type: "string", format: "date", description: "The day we last read the page." },
          outcome: {
            type: "string",
            enum: ["ok", "states_no_amount", "does_not_name_vendor", "does_not_name_product", "states_no_terms", "unreadable"],
            description: [
              "ok — the page names the vendor and states at least one amount, rate or price, either in figures the page renders or as a typed price in its schema.org markup (#1279).",
              "states_no_amount — the page names the vendor and names a plan or tier, but every price signal on it is a phrase such as \"Enterprise plan\" or \"Free forever\" and none is a figure (#1268). The quantities in description come from our own entry, not from that page. risk_level is still published and the summary says so, rather than being withheld.",
              "does_not_name_vendor — the page we read never writes the vendor's name. The URL we asked for is not evidence for this check, so a domain that keeps the vendor's name and loses its product reaches this outcome too (#1355).",
              "does_not_name_product — the page we read writes the platform token the vendor name shares with the host we cite it from, and never writes the rest of the name. For a vendor called <Platform> <Product> this is a live page on the platform's own domain that says nothing about the product, so the record rests on the platform existing rather than on the offer existing (#1500).",
              "states_no_terms — the page names the vendor but carries no price signal of any kind.",
              "unreadable — the fetch produced no body we could read.",
              "The last four withhold a favourable risk_level; the first two do not."
            ].join(" ")
          },
          detail: { type: "string", description: "Our own sentence recording what the check found — never a quotation from the page, and not corroborable against it (#1467). For ok, the form of the vendor's name the check matched and the price signal it found, or what the markup states when the rendered page states no amount; for states_no_amount, the phrase that was the page's entire price evidence; otherwise why the page cannot confirm the record. Where the page was read for schema.org markup, the detail says whether that markup was absent, present and priceless, or priced. The fields carrying text taken from a page are product_role.source_quote and product_subtypes.labels[].source_quote." },
          read: { type: "string", enum: ["markup"], description: "Present when the ok grade rests on typed prices in the page's schema.org markup rather than on a figure the page renders (#1279)." },
          unrendered_prices: {
            type: "array",
            items: { type: "string" },
            description: "Non-zero prices the page publishes as schema.org Offer data but does not render in its text — a tab or toggle layout showing one tier at a time. At most the first six are listed. The record is not written from these; they are recorded so a disagreement between markup and page can be reviewed (#1279)."
          }
        },
        required: ["checked", "outcome", "detail"]
      },
      Gate: {
        type: "object",
        nullable: true,
        description: "Why we do not rank this offer, or null where we do. The same verdict rankOffers applies, from the same function (#1241) — nothing is filtered out of a response because of it, so a caller asking whether an offer exists still gets the record. The full code table is published at /criteria.",
        properties: {
          code: { type: "string", enum: ["eligibility_restricted", "not_a_free_offer", "offer_expired", "offer_retired", "verification_lapsed"] },
          reason: { type: "string", description: "The reason we publish for this record, naming the tier, date or restriction the code was decided on." }
        },
        required: ["code", "reason"]
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
          restrictions: { type: "array", items: { type: "string" }, description: "Conditions the referee must meet before the benefit is theirs (e.g. 'A payment method must be linked'). Empty when the record records none. Publish these wherever you publish referee_benefit." },
          source: { type: "string", enum: ["platform"], description: "Always platform: a code AgentDeals holds and earns on. Agent-submitted codes are retired and none is served." }
        },
        required: ["vendor", "code", "referral_url", "referee_benefit", "restrictions", "source"]
      },
      DealChange: {
        type: "object",
        properties: {
          vendor: { type: "string" },
          change_type: { type: "string", enum: [...CHANGE_TYPES] },
          reports: { type: "string", enum: ["vendor_offer", "our_index"], description: "What the record is about. 'vendor_offer' — the vendor changed its own offer, and a vendor page is where that can be read. 'our_index' — we changed what we list while the vendor's offer stood still, so no vendor page evidences it and the record carries no source_url. Absent means vendor_offer. Filter these out of any figure you present as vendor market activity." },
          date: { type: "string", format: "date" },
          summary: { type: "string" },
          previous_state: { type: "string" },
          current_state: { type: "string" },
          tier_direction: { type: "string", enum: ["narrowed", "unchanged", "widened"], description: "Whether the tier we list is worse, the same, or better under current_state than it was under previous_state, judged with both in hand rather than read off change_type. Where it says the tier did not get worse we publish the record and take no risk verdict from it. Absent means we have not judged this record." },
          impact: { type: "string", enum: ["high", "medium", "low"] },
          source_url: { type: "string", format: "uri" },
          category: { type: "string" },
          alternatives: { type: "array", items: { type: "string" } },
          resolution: { $ref: "#/components/schemas/ChangeResolution" }
        },
        required: ["vendor", "change_type", "date", "summary", "previous_state", "current_state", "impact", "source_url", "category", "alternatives"]
      },
      ChangeResolution: {
        type: "object",
        nullable: true,
        description: "Present when the change this record describes is no longer in force. state is 'reversed' when the vendor ended it and 'retracted' when the record was our error. date is the day from which it stopped being in force, or the day we established that, whichever we can source. resolved_by names the change record that ended it, when one exists. A record carrying this field never rates the vendor.",
        properties: {
          state: { type: "string", enum: ["reversed", "retracted"] },
          date: { type: "string", format: "date" },
          detail: { type: "string" },
          source_url: { type: "string", format: "uri" },
          resolved_by: { type: "object", properties: { vendor: { type: "string" }, date: { type: "string", format: "date" }, change_type: { type: "string" } } }
        },
        required: ["state", "date"]
      }
    }
  }
};

function specPathFor(path: string): string {
  return path.replace(/:([A-Za-z_]+)/g, "{$1}");
}

function operationKey(endpoint: ApiEndpoint): string {
  return `${endpoint.method} ${specPathFor(endpoint.path)}`;
}

function writePaths(): string[] {
  return API_ENDPOINTS.filter((endpoint) => endpoint.method !== "GET").map(operationKey);
}

function namedParams(spec: string): { name: string; note: string | null }[] {
  const pieces: string[] = [];
  let depth = 0;
  let current = "";
  for (const ch of spec) {
    if (ch === "(") depth += 1;
    if (ch === ")") depth -= 1;
    if (ch === "," && depth === 0) { pieces.push(current); current = ""; continue; }
    current += ch;
  }
  pieces.push(current);
  return pieces
    .map((piece) => piece.trim().match(/^([A-Za-z_][A-Za-z0-9_]*)\s*(?:\(([^)]*)\))?$/))
    .filter((match): match is RegExpMatchArray => match !== null)
    .map((match) => ({ name: match[1], note: match[2] ?? null }));
}

function derivedOperation(endpoint: ApiEndpoint): Record<string, any> {
  const params = endpoint.params.trim() ? namedParams(endpoint.params) : [];
  const query = endpoint.method === "GET" ? params.filter((p) => p.note !== "body") : [];
  const body = params.filter((p) => p.note === "body");
  const operation: Record<string, any> = {
    summary: endpoint.desc,
    description: `${endpoint.desc}. This route is served and carried in our endpoint inventory; its response has not been described here yet, so treat the shape as undocumented rather than empty.`,
    responses: { "200": { description: endpoint.desc } },
  };
  if (query.length > 0) {
    operation.parameters = query.map((p) => ({
      name: p.name,
      in: "query",
      ...(p.note ? { description: p.note } : {}),
      schema: { type: "string" },
    }));
  }
  if (body.length > 0) {
    operation.requestBody = {
      required: true,
      content: { "application/json": { schema: { type: "object", properties: Object.fromEntries(body.map((p) => [p.name, { type: "string" }])) } } },
    };
  }
  return operation;
}

function citedSchema(schema: Record<string, any>): Record<string, any> {
  const citation = { type: "object", properties: { _provenance: { $ref: PROVENANCE_REF } }, required: ["_provenance"] };
  if (Array.isArray(schema.allOf)) return { ...schema, allOf: [...schema.allOf, citation] };
  if (schema.properties) return { ...schema, properties: { ...schema.properties, _provenance: { $ref: PROVENANCE_REF } } };
  return { allOf: [schema, citation] };
}

function withCitation(operation: Record<string, any>): Record<string, any> {
  const json = operation.responses?.["200"]?.content?.["application/json"];
  if (!json?.schema) return operation;
  return {
    ...operation,
    responses: {
      ...operation.responses,
      "200": {
        ...operation.responses["200"],
        content: { ...operation.responses["200"].content, "application/json": { ...json, schema: citedSchema(json.schema) } },
      },
    },
  };
}

export function endpointsDescribedFromTheInventoryAlone(endpoints: readonly ApiEndpoint[] = API_ENDPOINTS): string[] {
  return endpoints
    .filter((endpoint) => DOCUMENTED_OPERATIONS[specPathFor(endpoint.path)]?.[endpoint.method.toLowerCase()] === undefined)
    .map(operationKey);
}

export function documentedOperationsNoEndpointServes(endpoints: readonly ApiEndpoint[] = API_ENDPOINTS): string[] {
  const served = new Set(endpoints.map(operationKey));
  const alias = new Set(Object.keys(PATHS_OUTSIDE_THE_ENDPOINT_INVENTORY));
  return Object.entries(DOCUMENTED_OPERATIONS)
    .filter(([path]) => !alias.has(path))
    .flatMap(([path, methods]) => Object.keys(methods).map((method) => `${method.toUpperCase()} ${path}`))
    .filter((key) => !served.has(key));
}

export function pathsFor(endpoints: readonly ApiEndpoint[] = API_ENDPOINTS): Record<string, Record<string, any>> {
  const paths: Record<string, Record<string, any>> = {};
  for (const endpoint of endpoints) {
    const path = specPathFor(endpoint.path);
    const method = endpoint.method.toLowerCase();
    const written = DOCUMENTED_OPERATIONS[path]?.[method];
    const operation = written ? structuredClone(written) : derivedOperation(endpoint);
    paths[path] = paths[path] ?? {};
    paths[path][method] = endpoint.cites ? withCitation(operation) : operation;
  }
  for (const path of Object.keys(PATHS_OUTSIDE_THE_ENDPOINT_INVENTORY)) {
    const written = DOCUMENTED_OPERATIONS[path];
    if (written) paths[path] = structuredClone(written);
  }
  return paths;
}
