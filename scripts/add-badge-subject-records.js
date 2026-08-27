#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const INDEX = path.join(__dirname, "..", "data", "index.json");

const VERIFIED = "2026-08-27";

const RECORDS = [
  {
    vendor: "Amazon SES",
    category: "Email",
    description:
      "Transactional and bulk email API/SMTP. No perpetual free tier: new AWS accounts get up to $200 in AWS Free Tier credits usable across eligible services, the free plan runs for 6 months after account creation, and credits expire 12 months after account creation. $0.10 per 1,000 outbound emails after that, plus EC2 compute and data transfer if you send from AWS.",
    tier: "Credits",
    url: "https://aws.amazon.com/ses/pricing/",
    tags: ["email", "transactional email", "smtp", "aws", "time-limited", "credits"],
    verifiedDate: VERIFIED,
  },
  {
    vendor: "Storj",
    category: "Storage",
    description:
      "Distributed S3-compatible object storage. Free trial only: 25 GB free storage for 30 days, no credit card required, and 2 Object Mount licenses. After the trial, $7/TB storage and $7/TB egress with a $5 monthly minimum fee (waived while the trial is running and for accounts paying in STORJ token).",
    tier: "Trial",
    url: "https://storj.io/pricing",
    tags: ["storage", "object storage", "s3-compatible", "decentralized", "time-limited", "trial"],
    verifiedDate: VERIFIED,
  },
  {
    vendor: "SigNoz",
    category: "Monitoring",
    description:
      "OpenTelemetry-native observability with logs, metrics and traces in one tool. The community edition is free to self-host. SigNoz Cloud starts at $49/month including $49 of usage credit, then $0.3/GB ingested for logs and traces (15-day retention) and $0.1 per million metric samples; eligible startups pay $19/month for the first 12 months.",
    tier: "Free OSS",
    url: "https://signoz.io/pricing/",
    tags: ["monitoring", "observability", "opentelemetry", "apm", "tracing", "self-hosted", "open source", "datadog-alternative"],
    verifiedDate: VERIFIED,
  },
  {
    vendor: "Elastic",
    category: "Monitoring",
    description:
      "The Elastic Stack — Elasticsearch, Kibana, ingest and basic security — self-managed at no cost on the Free and Open tier under the Elastic License and SSPL, with community support. Platinum (existing customers only) and Enterprise are custom-priced and add machine learning, cross-cluster replication, searchable snapshots and 24/7 support. Elastic Cloud Serverless and Hosted are billed separately by usage or resources.",
    tier: "Free OSS",
    url: "https://www.elastic.co/pricing/self-managed",
    tags: ["monitoring", "observability", "search", "logging", "elk", "self-hosted", "open source"],
    verifiedDate: VERIFIED,
  },
  {
    vendor: "Grafana",
    category: "Monitoring",
    description:
      "Grafana OSS — the self-hosted dashboarding and alerting front end, free under AGPL-3.0-only with Apache-2.0 exceptions. Unifies 150+ data sources into one dashboard and supports observability-as-code. You set up, administer and maintain the installation yourself; Grafana Cloud is the hosted product and is priced separately.",
    tier: "Free OSS",
    url: "https://grafana.com/oss/grafana/",
    tags: ["monitoring", "observability", "dashboards", "visualization", "self-hosted", "open source"],
    verifiedDate: VERIFIED,
  },
  {
    vendor: "Mockoon",
    category: "API Development",
    description:
      "Free and open-source desktop app for creating local API mocks — dynamic responses, request logging, record/replay and OpenAPI import. Mockoon Cloud adds hosted mocks and collaboration: Team is $100/month billed annually for 5 members, 3 deployed mocks and 100,000 calls/month, with a 14-day trial on a work email (7 days and a card otherwise).",
    tier: "Free OSS",
    url: "https://mockoon.com/pricing/",
    tags: ["api development", "api mocking", "testing", "desktop app", "self-hosted", "open source"],
    verifiedDate: VERIFIED,
  },
  {
    vendor: "Postal",
    category: "Email",
    description:
      "Free MIT-licensed self-hosted mail server for websites and web servers — an open-source stand-in for Sendgrid, Mailgun or Postmark that you run yourself. No hosted or paid plan is offered; the only cost is the infrastructure you send from.",
    tier: "Free OSS",
    url: "https://github.com/postalserver/postal",
    tags: ["email", "smtp", "transactional email", "mail server", "self-hosted", "open source"],
    verifiedDate: VERIFIED,
  },
  {
    vendor: "swaggo/swag",
    category: "API Development",
    description:
      "Automatically generate RESTful API documentation with Swagger 2.0 for Go. Annotate your handler functions, run swag init, and get a Swagger UI endpoint; works with chi, gin, echo, fiber and net/http. Free and MIT-licensed, with optional sponsorship through Open Collective.",
    tier: "Free OSS",
    url: "https://github.com/swaggo/swag",
    tags: ["api development", "openapi", "swagger", "documentation", "golang", "open source"],
    verifiedDate: VERIFIED,
  },
  {
    vendor: "authentik",
    category: "Auth",
    description:
      "Self-hosted identity provider covering SSO, SAML, OAuth2/OIDC and LDAP. The open-source edition is free and aimed at homelab users and simple use cases. Enterprise is $5/user/month billed annually with external users at $0.02/user/month and no charge for service accounts; Enterprise Plus starts at $20k annually.",
    tier: "Free OSS",
    url: "https://goauthentik.io/pricing/",
    tags: ["auth", "sso", "saml", "oauth", "oidc", "ldap", "self-hosted", "open source"],
    verifiedDate: VERIFIED,
  },
];

const data = JSON.parse(readFileSync(INDEX, "utf-8"));
const existing = new Set(data.offers.map((o) => o.vendor.toLowerCase()));

let added = 0;
for (const rec of RECORDS) {
  if (existing.has(rec.vendor.toLowerCase())) {
    console.log(`skip (already present): ${rec.vendor}`);
    continue;
  }
  data.offers.push(rec);
  added += 1;
  console.log(`added: ${rec.vendor} (${rec.category}, ${rec.tier})`);
}

if (added > 0) writeFileSync(INDEX, JSON.stringify(data, null, 2) + "\n");
console.log(`\n${added} added, ${data.offers.length} records total`);
