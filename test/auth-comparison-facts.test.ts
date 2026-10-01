import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

const PAGE = "/auth-comparison-2026";
const SITEMAPS_OF_GUIDES_AND_REPORTS = ["/sitemap-pages.xml", "/sitemap-reports.xml", "/sitemap-misc.xml"];

const CELLS: Array<{ table: string; vendor: string; column: string; now: string; was: string }> = [
  {
    "table": "Service",
    "vendor": "Auth0",
    "column": "Overage / User",
    "now": "None: a paid plan sized to all users",
    "was": "~$0.07"
  },
  {
    "table": "Service",
    "vendor": "Auth0",
    "column": "MFA",
    "now": "Not listed on Free",
    "was": "Included"
  },
  {
    "table": "Service",
    "vendor": "Auth0",
    "column": "SSO/SAML",
    "now": "1 enterprise connection + SCIM",
    "was": "Enterprise + SCIM free"
  },
  {
    "table": "Service",
    "vendor": "Auth0",
    "column": "M2M / Agents",
    "now": "1,000 M2M tokens/mo; Token Vault (2 apps)",
    "was": "1,000 M2M + AI token vaults"
  },
  {
    "table": "Service",
    "vendor": "Clerk",
    "column": "Social Login",
    "now": "Up to 3 (Hobby)",
    "was": "5+ providers"
  },
  {
    "table": "Service",
    "vendor": "Clerk",
    "column": "MFA",
    "now": "Pro plan ($25/mo)",
    "was": "Included"
  },
  {
    "table": "Service",
    "vendor": "Clerk",
    "column": "M2M / Agents",
    "now": "2,500 token creations/mo",
    "was": "—"
  },
  {
    "table": "Service",
    "vendor": "Kinde",
    "column": "Overage / User",
    "now": "$0.0175 (Pro, $25/mo)",
    "was": "Tiered ($0.035–$0.0275)"
  },
  {
    "table": "Service",
    "vendor": "Kinde",
    "column": "SSO/SAML",
    "now": "1 enterprise SSO connection",
    "was": "Paid plan"
  },
  {
    "table": "Service",
    "vendor": "Kinde",
    "column": "M2M / Agents",
    "now": "2,000 tokens",
    "was": "200"
  },
  {
    "table": "Service",
    "vendor": "PropelAuth",
    "column": "Overage / User",
    "now": "$0.05 (Growth, $150/mo)",
    "was": "$0.05/MAU"
  },
  {
    "table": "Service",
    "vendor": "Stytch",
    "column": "Free Limit",
    "now": "10K MAU",
    "was": "25K MAU"
  },
  {
    "table": "Service",
    "vendor": "Stytch",
    "column": "Overage / User",
    "now": "$0.20",
    "was": "$0.05"
  },
  {
    "table": "Service",
    "vendor": "Stytch",
    "column": "SSO/SAML",
    "now": "5 SSO or SCIM connections (B2B), then $125/mo each",
    "was": "B2B SDK"
  },
  {
    "table": "Service",
    "vendor": "Descope",
    "column": "Overage / User",
    "now": "None on Free; $0.05 on Pro and Growth",
    "was": "Custom"
  },
  {
    "table": "Service",
    "vendor": "Descope",
    "column": "SSO/SAML",
    "now": "3 connections, 10 active tenants",
    "was": "50 tenants"
  },
  {
    "table": "Service",
    "vendor": "Descope",
    "column": "M2M / Agents",
    "now": "10,000 exchanges",
    "was": "50 M2M"
  },
  {
    "table": "Service",
    "vendor": "WorkOS",
    "column": "Overage / User",
    "now": "$2,500/mo per extra 1M",
    "was": "Free (auth only)"
  },
  {
    "table": "Service",
    "vendor": "WorkOS",
    "column": "Social Login",
    "now": "Social free; SSO $125/connection/mo",
    "was": "Social + enterprise"
  },
  {
    "table": "Service",
    "vendor": "WorkOS",
    "column": "M2M / Agents",
    "now": "M2M apps (price not listed)",
    "was": "—"
  },
  {
    "table": "Service",
    "vendor": "Supabase Auth",
    "column": "Overage / User",
    "now": "$0.00325 above 100K (Pro, $25/mo)",
    "was": "$0.00325"
  },
  {
    "table": "Service",
    "vendor": "Supabase Auth",
    "column": "Social Login",
    "now": "19 + custom OAuth/OIDC",
    "was": "20+ providers"
  },
  {
    "table": "Service",
    "vendor": "Supabase Auth",
    "column": "MFA",
    "now": "TOTP (phone MFA paid, Pro)",
    "was": "TOTP + Phone"
  },
  {
    "table": "Service",
    "vendor": "Supabase Auth",
    "column": "SSO/SAML",
    "now": "SAML on Pro (50 SSO MAU, then $0.015)",
    "was": "—"
  },
  {
    "table": "Service",
    "vendor": "Supabase Auth",
    "column": "Self-Hosted?",
    "now": "Yes (Docker)",
    "was": "BaaS-integrated"
  },
  {
    "table": "Service",
    "vendor": "Firebase Auth",
    "column": "MFA",
    "now": "SMS + TOTP (Identity Platform)",
    "was": "Phone + TOTP"
  },
  {
    "table": "Service",
    "vendor": "AWS Cognito",
    "column": "Free Limit",
    "now": "10K MAU (50K for Lite pools created by Nov 22, 2024)",
    "was": "10K MAU (50K for pools created by Nov 22, 2024)"
  },
  {
    "table": "Service",
    "vendor": "AWS Cognito",
    "column": "Overage / User",
    "now": "$0.0055 Lite / $0.015 Essentials",
    "was": "$0.0055"
  },
  {
    "table": "Service",
    "vendor": "AWS Cognito",
    "column": "Social Login",
    "now": "Social, SAML, OIDC",
    "was": "OIDC + SAML"
  },
  {
    "table": "Service",
    "vendor": "AWS Cognito",
    "column": "SSO/SAML",
    "now": "50 federated MAU free, then $0.015",
    "was": "Included"
  },
  {
    "table": "Service",
    "vendor": "AWS Cognito",
    "column": "M2M / Agents",
    "now": "Paid add-on ($0.00225/token request)",
    "was": "Included"
  },
  {
    "table": "Service",
    "vendor": "Appwrite Auth",
    "column": "Overage / User",
    "now": "$3 per 1,000 above 200K (Pro, $25/mo)",
    "was": "$0 (self-hosted unlimited)"
  },
  {
    "table": "Service",
    "vendor": "Appwrite Auth",
    "column": "MFA",
    "now": "Email, phone, TOTP (no phone on Cloud Free)",
    "was": "Phone + TOTP"
  },
  {
    "table": "Service",
    "vendor": "Authelia",
    "column": "Social Login",
    "now": "None",
    "was": "Via OIDC proxy"
  },
  {
    "table": "Service",
    "vendor": "Authelia",
    "column": "M2M / Agents",
    "now": "Client credentials",
    "was": "—"
  },
  {
    "table": "Service",
    "vendor": "FusionAuth",
    "column": "M2M / Agents",
    "now": "Starter plan and up",
    "was": "Unlimited"
  },
  {
    "table": "Service",
    "vendor": "SuperTokens",
    "column": "MFA",
    "now": "Paid ($0.01/MAU managed, $0.02 self-hosted; $100/mo min)",
    "was": "Included"
  },
  {
    "table": "Service",
    "vendor": "SuperTokens",
    "column": "M2M / Agents",
    "now": "Paid add-on (managed service only)",
    "was": "—"
  },
  {
    "table": "Service",
    "vendor": "SuperTokens",
    "column": "Self-Hosted?",
    "now": "Yes (open-source features free)",
    "was": "Yes (unlimited)"
  },
  {
    "table": "Service",
    "vendor": "Hanko",
    "column": "Overage / User",
    "now": "$0.01 above 10K (Pro, $29/mo)",
    "was": "Contact sales"
  },
  {
    "table": "Service",
    "vendor": "Hanko",
    "column": "MFA",
    "now": "TOTP, security keys",
    "was": "Passkeys (built-in)"
  },
  {
    "table": "Service",
    "vendor": "Hanko",
    "column": "SSO/SAML",
    "now": "SAML on Pro ($49/mo per connection)",
    "was": "—"
  },
  {
    "table": "Service",
    "vendor": "Ory",
    "column": "Free Limit",
    "now": "Self-hosted; cloud Developer plan has no production use",
    "was": "25K (cloud)"
  },
  {
    "table": "Service",
    "vendor": "Ory",
    "column": "Overage / User",
    "now": "$0.14/aDAU (Production, $70/mo or $770/yr)",
    "was": "$0.07 (cloud)"
  },
  {
    "table": "Service",
    "vendor": "Ory",
    "column": "M2M / Agents",
    "now": "Self-hosted Hydra; billed on Ory Network",
    "was": "Included"
  },
  {
    "table": "Best Feature",
    "vendor": "Auth0",
    "column": "Overage",
    "now": "None: a paid plan sized to all users",
    "was": "~$0.07/MAU"
  },
  {
    "table": "Best Feature",
    "vendor": "Auth0",
    "column": "Best Feature",
    "now": "Actions, SCIM and 1 enterprise connection on Free; Token Vault",
    "was": "Actions, SSO/SCIM free, AI token vaults"
  },
  {
    "table": "Best Feature",
    "vendor": "Kinde",
    "column": "Overage",
    "now": "$0.0175 (Pro)",
    "was": "Tiered pricing"
  },
  {
    "table": "Best Feature",
    "vendor": "PropelAuth",
    "column": "Overage",
    "now": "$0.05 (Growth, $150/mo)",
    "was": "$0.05/MAU"
  },
  {
    "table": "Best Feature",
    "vendor": "Stytch",
    "column": "Free Limit",
    "now": "10K MAU",
    "was": "25K MAU"
  },
  {
    "table": "Best Feature",
    "vendor": "Stytch",
    "column": "Overage",
    "now": "$0.20/MAU",
    "was": "$0.05/MAU"
  },
  {
    "table": "Best Feature",
    "vendor": "Stytch",
    "column": "Best Feature",
    "now": "Passwordless and password login, B2B, AI-agent auth",
    "was": "Passwordless-first, B2B SDK"
  },
  {
    "table": "Best Feature",
    "vendor": "Descope",
    "column": "Overage",
    "now": "None on Free; $0.05 on Pro and Growth",
    "was": "Custom pricing"
  },
  {
    "table": "Best Feature",
    "vendor": "WorkOS",
    "column": "Overage",
    "now": "$2,500/mo per extra 1M",
    "was": "Free (auth only)"
  },
  {
    "table": "Platform",
    "vendor": "Appwrite Auth",
    "column": "Overage",
    "now": "$3 per 1,000 above 200K (Pro, $25/mo)",
    "was": "$0 (self-hosted unlimited)"
  },
  {
    "table": "Platform",
    "vendor": "Appwrite Auth",
    "column": "MFA",
    "now": "Email, phone, TOTP (no phone on Cloud Free)",
    "was": "Phone + TOTP"
  },
  {
    "table": "Platform",
    "vendor": "Supabase Auth",
    "column": "Overage",
    "now": "$0.00325/MAU above 100K (Pro)",
    "was": "$0.00325/MAU"
  },
  {
    "table": "Platform",
    "vendor": "Supabase Auth",
    "column": "MFA",
    "now": "TOTP (phone MFA paid)",
    "was": "TOTP + Phone"
  },
  {
    "table": "Platform",
    "vendor": "Firebase Auth",
    "column": "Overage",
    "now": "$0 ($0.0055/MAU from 50K to 100K with Identity Platform)",
    "was": "$0.0055/MAU"
  },
  {
    "table": "Platform",
    "vendor": "AWS Cognito",
    "column": "Overage",
    "now": "$0.0055 Lite / $0.015 Essentials",
    "was": "$0.0055/MAU"
  },
  {
    "table": "Cloud Option",
    "vendor": "FusionAuth",
    "column": "License",
    "now": "Proprietary (free Community edition)",
    "was": "Apache 2.0 (Community)"
  },
  {
    "table": "Cloud Option",
    "vendor": "Keycloak",
    "column": "Cloud Option",
    "now": "None from the project (Red Hat's build is self-run); third parties host it",
    "was": "Red Hat SSO (paid)"
  },
  {
    "table": "Cloud Option",
    "vendor": "Authentik",
    "column": "Cloud Option",
    "now": "None from authentik (Enterprise is self-hosted); third parties host it",
    "was": "Authentik Enterprise (paid)"
  },
  {
    "table": "Cloud Option",
    "vendor": "SuperTokens",
    "column": "Language",
    "now": "Java (core)",
    "was": "Node.js / Go (core)"
  },
  {
    "table": "Cloud Option",
    "vendor": "Ory",
    "column": "Cloud Option",
    "now": "Ory Network (Production $70/mo or $770/yr)",
    "was": "Ory Network (25K free MAU)"
  },
  {
    "table": "Specialty",
    "vendor": "Authgear",
    "column": "Free Tier",
    "now": "No MAU limit (cloud Free)",
    "was": "5K MAU (cloud)"
  },
  {
    "table": "Specialty",
    "vendor": "MojoAuth",
    "column": "Free Tier",
    "now": "25K MAU",
    "was": "1K MAU"
  },
  {
    "table": "Specialty",
    "vendor": "MojoAuth",
    "column": "Specialty",
    "now": "Passwordless-first: magic links, email OTP, social (passkeys on Business Pro)",
    "was": "Passwordless-only: magic links, WebAuthn, biometric"
  },
  {
    "table": "Specialty",
    "vendor": "Hexclave (formerly Stack Auth)",
    "column": "Provider",
    "now": "Hexclave (formerly Stack Auth)",
    "was": "Stack Auth"
  },
  {
    "table": "Specialty",
    "vendor": "Hexclave (formerly Stack Auth)",
    "column": "Free Tier",
    "now": "Self-hosting free; managed 10K user accounts",
    "was": "Unlimited (open source)"
  },
  {
    "table": "Specialty",
    "vendor": "Hexclave (formerly Stack Auth)",
    "column": "Specialty",
    "now": "Open-source auth, managed or self-hosted",
    "was": "Developer-first, open-source managed auth"
  },
  {
    "table": "Model",
    "vendor": "Cerbos Hub",
    "column": "Free Tier",
    "now": "100 monthly active principals, 2 PDPs",
    "was": "100 principals, unlimited policies"
  },
  {
    "table": "Model",
    "vendor": "Authress",
    "column": "Free Tier",
    "now": "First 1,000 billable calls free, then $0.0012/call",
    "was": "1,000 MAU, unlimited resources"
  },
  {
    "table": "Model",
    "vendor": "Authress",
    "column": "Model",
    "now": "Login and permissions API",
    "was": "API-first permission management"
  },
  {
    "table": "At 10K MAU",
    "vendor": "Auth0",
    "column": "At 50K MAU",
    "now": "No published price",
    "was": "~$175/mo"
  },
  {
    "table": "At 10K MAU",
    "vendor": "Auth0",
    "column": "At 100K MAU",
    "now": "No published price",
    "was": "~$525/mo"
  },
  {
    "table": "At 10K MAU",
    "vendor": "Clerk (MRU)",
    "column": "At 100K MAU",
    "now": "$1,025/mo",
    "was": "~$1,000/mo"
  },
  {
    "table": "At 10K MAU",
    "vendor": "Kinde",
    "column": "At 25K MAU",
    "now": "$278.75/mo (Pro)",
    "was": "~$508/mo"
  },
  {
    "table": "At 10K MAU",
    "vendor": "Kinde",
    "column": "At 50K MAU",
    "now": "$716.25/mo (Pro)",
    "was": "~$1,383/mo"
  },
  {
    "table": "At 10K MAU",
    "vendor": "Kinde",
    "column": "At 100K MAU",
    "now": "$1,533.85/mo (Plus)",
    "was": "~$2,758/mo"
  },
  {
    "table": "At 10K MAU",
    "vendor": "PropelAuth",
    "column": "At 25K MAU",
    "now": "$900/mo (Growth)",
    "was": "~$750/mo"
  },
  {
    "table": "At 10K MAU",
    "vendor": "PropelAuth",
    "column": "At 50K MAU",
    "now": "$2,150/mo (Growth)",
    "was": "~$2,000/mo"
  },
  {
    "table": "At 10K MAU",
    "vendor": "PropelAuth",
    "column": "At 100K MAU",
    "now": "$4,650/mo (Growth)",
    "was": "~$4,500/mo"
  },
  {
    "table": "At 10K MAU",
    "vendor": "Stytch",
    "column": "At 25K MAU",
    "now": "~$3,000/mo",
    "was": "$0 (free)"
  },
  {
    "table": "At 10K MAU",
    "vendor": "Stytch",
    "column": "At 50K MAU",
    "now": "~$8,000/mo",
    "was": "~$1,250/mo"
  },
  {
    "table": "At 10K MAU",
    "vendor": "Stytch",
    "column": "At 100K MAU",
    "now": "~$18,000/mo",
    "was": "~$3,750/mo"
  },
  {
    "table": "At 10K MAU",
    "vendor": "Appwrite Auth",
    "column": "At 100K MAU",
    "now": "$25/mo (Pro)",
    "was": "~$100/mo (Pro plan)"
  },
  {
    "table": "At 10K MAU",
    "vendor": "Supabase Auth",
    "column": "At 100K MAU",
    "now": "$25/mo (Pro)",
    "was": "~$162/mo"
  },
  {
    "table": "At 10K MAU",
    "vendor": "Firebase Auth",
    "column": "At 100K MAU",
    "now": "$0 ($275 with Identity Platform)",
    "was": "~$275/mo"
  },
  {
    "table": "At 10K MAU",
    "vendor": "AWS Cognito",
    "column": "At 25K MAU",
    "now": "$82.50 Lite / $225 Essentials",
    "was": "$0 (free)"
  },
  {
    "table": "At 10K MAU",
    "vendor": "AWS Cognito",
    "column": "At 50K MAU",
    "now": "$220 / $600",
    "was": "$0 (free)"
  },
  {
    "table": "At 10K MAU",
    "vendor": "AWS Cognito",
    "column": "At 100K MAU",
    "now": "$495 / $1,350",
    "was": "~$275/mo"
  },
  {
    "table": "At 10K MAU",
    "vendor": "Self-hosted",
    "column": "At 10K MAU",
    "now": "$0 licence",
    "was": "$0"
  },
  {
    "table": "At 10K MAU",
    "vendor": "Self-hosted",
    "column": "At 25K MAU",
    "now": "$0 licence",
    "was": "$0"
  },
  {
    "table": "At 10K MAU",
    "vendor": "Self-hosted",
    "column": "At 50K MAU",
    "now": "$0 licence",
    "was": "$0"
  },
  {
    "table": "At 10K MAU",
    "vendor": "Self-hosted",
    "column": "At 100K MAU",
    "now": "$0 licence",
    "was": "$0 (+ $20-100/mo server)"
  }
];

const STATED_ON_THE_PAGE: string[] = [
  "Side-by-side comparison of 18 auth services.",
  "Auth0's free plan covers 25,000 monthly active users (MAU). Clerk's free Hobby plan covers 50,000 monthly retained users (MRU) per application. Supabase's Free plan covers 50,000 MAU. Firebase Authentication without Identity Platform has no MAU cap. Identity Platform is free up to 50,000 MAU (3,000 daily active users on the no-cost Spark plan). WorkOS User Management is free for up to 1 million MAU. Stytch's free tier covers 10,000 MAU. Amazon Cognito's free tier is 10,000 MAU per AWS account or organization on the Lite and Essentials tiers; on Lite, user pools created on or before 22 November 2024 keep 50,000.",
  "Growth costs:",
  "At 100,000 users: Clerk costs $1,025 a month; Supabase costs $25 a month; Appwrite costs $25 a month; WorkOS costs $0; Firebase Authentication without Identity Platform costs $0; Kinde costs $1,533.85 a month on its Plus plan; PropelAuth costs $4,650 a month on its Growth plan; Stytch's rate gives $18,000 a month before any volume discount it does not publish. On its B2C Essentials plan, Auth0 charges $2,100 a month for 30,000 MAU and publishes no price above that. The free editions of the self-hosted servers charge no licence fee per user.",
  "Managed services charge by the number of users past their free tier. Supabase, Firebase and Appwrite bundle auth with a database and other backend services; AWS sells Cognito as a standalone identity service. The free editions of self-hosted servers charge no licence fee per user, and you run them yourself. WorkOS is free for up to 1 million MAU.",
  "Auth0's free plan covers 25,000 MAU and includes one enterprise connection, Self-Service SSO, SCIM, 5 organizations, Token Vault for 2 connected apps, and 1,000 machine-to-machine (M2M) tokens a month. Its pricing page lists no MFA factors on the free plan. Auth0 has no per-user overage rate: past 25,000 MAU you must buy a paid plan sized to all your users, and 30,000 MAU on B2C Essentials costs $2,100 a month. Clerk's free Hobby plan covers 50,000 MRU per application, with up to 3 social connections and no MFA. On Pro ($25 a month), users from 50,001 to 100,000 MRU cost $0.02 each.",
  "Backend platforms and Cognito:",
  "Supabase Free covers 50,000 MAU; Pro is $25 a month for 100,000 MAU, then $0.00325 per MAU. Firebase Authentication without Identity Platform has no MAU cap; Identity Platform is free to 50,000 MAU, then $0.0055 per MAU up to 100,000. Cognito's free tier is 10,000 MAU per AWS account or organization (50,000 on Lite for user pools created on or before 22 November 2024); above it, Lite costs $0.0055 per MAU up to 100,000 and Essentials, the default for new user pools, $0.015. Appwrite Free covers 75,000 MAU; Pro is $25 a month for 200,000 MAU, then $3 per 1,000 users. Appwrite is open source under the BSD 3-Clause licence. Its migration from Appwrite Cloud to self-hosted Appwrite moves users, databases, files, functions and sites; Appwrite warns that some fields do not transfer.",
  "Self-hosted servers:",
  "Keycloak is an open-source identity server under the Apache 2.0 licence. It supports OIDC, OAuth 2.0 and SAML. Keycloak's sizing guide starts at 1,250 MB of RAM per pod. authentik is an open-source identity provider. Its Docker Compose install needs PostgreSQL and a host with at least 2 CPU cores and 2 GB of RAM. authentik offers no hosted version. Authelia is under 20 MB compressed and normally uses under 30 MB of memory. It provides single sign-on through a session cookie, OpenID Connect or trusted headers. It has no social login. FusionAuth Community is free to self-host with no user limit, but FusionAuth says it is not open source. Its free edition has no machine-to-machine (client credentials) support. Ory's servers (Kratos, Hydra, Keto) are open source under Apache 2.0 and written in Go. Self-hosted Ory Hydra supports machine-to-machine clients at no licence cost. Hanko supports passkeys, passwords and passwordless codes. Its free cloud plan covers 10,000 MAU. The SuperTokens core is written in Java, with backend SDKs for Node.js, Go and Python. SuperTokens charges for MFA even when self-hosted: $0.02 per MAU, with a $100 minimum a month.",
  "Specialized services:",
  "Stack Auth now operates as Hexclave. Self-hosting is free (server under AGPLv3, SDKs under MIT). Its managed Free plan allows 10,000 user accounts. Authgear's free cloud plan has no MAU limit and includes 2 applications and 2 admin seats. Passkeys and biometric login are on every plan. MojoAuth's free plan covers 25,000 MAU with magic links, email one-time codes and Google and Facebook login; passkeys and TOTP need its Business Pro plan ($120 a month for 25,000 MAU). Permit.io and Cerbos handle authorization (what a user may do), not sign-in. Authress handles both sign-in and permissions. Permit.io's free Community plan covers 1,000 MAU. Cerbos Hub's free plan covers 100 monthly active principals; the open-source Cerbos policy decision point is free with no principal limit and can run as a sidecar or as a central service. Authress bills per API call: the first 1,000 billable calls are free, then $0.0012 per call.",
  "Permit.io and Cerbos handle authorization (what a user may do), not sign-in. Authress handles both sign-in and permissions.",
  "Clerk defines a monthly retained user as a user who visits the app in a given month at least one day after signing up. Clerk says MRU is often lower than raw MAU, especially for apps with many one-time signups or trial users. Auth0 publishes no price above 30,000 MAU. Stytch's estimator shows \"Contact us\" above 20,000 MAU. Cognito Lite costs $0.0055 per MAU above the free tier, up to 100,000 MAU. Cognito Essentials, the default tier for new user pools, costs $0.015 per MAU. The free editions of the self-hosted servers charge no licence fee per user.",
  "Auth0: the step from free to paid",
  "Auth0 has no per-user overage rate. Past 25,000 MAU you must buy a paid plan sized to all your users. Auth0's B2C Essentials plan starts at $35 a month for 500 MAU. Auth0's B2B Essentials plan starts at $150 a month for 500 MAU. On B2C Essentials, 30,000 MAU costs $2,100 a month. B2C Essentials and B2C Professional include no enterprise connections, no Self-Service SSO and no SCIM.",
  "Clerk counts retained users",
  "Clerk's free Hobby plan covers 50,000 monthly retained users (MRU) per application. Clerk defines a monthly retained user as a user who visits the app in a given month at least one day after signing up. Clerk says MRU is often lower than raw MAU, especially for apps with many one-time signups or trial users.",
  "Machine-to-machine tokens",
  "Auth0's free plan includes 1,000 M2M tokens a month. Auth0 counts the access tokens it issues, not API calls: one cached token can serve many calls until it expires. Clerk's free plan includes 2,500 M2M token creations a month. Kinde's free plan includes 2,000 M2M tokens. Descope's free plan includes 10,000 M2M exchanges. Cognito's M2M authentication is a paid add-on with no free tier. FusionAuth Community has no M2M support. Self-hosted Ory Hydra supports M2M clients at no licence cost; Ory's hosted service bills M2M tokens.",
  "SMS and MFA charges",
  "Firebase bills SMS for phone sign-in and SMS MFA at $0.01 to $0.50 per message, depending on the country. The first 10 messages a day are free. SMS MFA and TOTP MFA both require the Identity Platform upgrade on Firebase. SuperTokens charges for MFA even when self-hosted: $0.02 per MAU, with a $100 minimum a month. MojoAuth's Business Pro plan is required for passkeys and TOTP.",
  "Running your own server",
  "Keycloak's sizing guide starts at 1,250 MB of RAM per pod. authentik's Docker Compose install needs PostgreSQL and a host with at least 2 CPU cores and 2 GB of RAM. Their free editions charge no licence fee per user. You run the servers and apply security patches and upgrades yourself.",
  "Moving to another provider",
  "Clerk exports password hashes from its dashboard. Auth0 exports password hashes through a support case, which only paying and trial customers can open, and not every request qualifies. Users do not need to reset their passwords if the new provider accepts the hash format. Auth0, Keycloak, Ory, authentik and Kinde support OpenID Connect (OIDC)."
];

const FAQ_BASIS = "This page compares them on free tier limits and what each charges past them; the tables above carry the figures side by side.";

const FAQ_LIMITS = "The free tiers cap monthly users (Auth0, Kinde, PropelAuth, Stytch, Descope, WorkOS, Supabase, Appwrite, Cognito) or retained users (Clerk), and some also cap SSO connections or M2M tokens. The growth-cost table shows what most of them charge past their free tier.";

const WITHDRAWN_FROM_THE_PAGE: string[] = [
  "Best Enterprise Free Tier",
  "Best Developer Experience",
  "Industry signal",
  "Best for Each Use Case",
  "Lock-in Risk",
  "DX Quality",
  "Best For",
  "Auth0 vs Clerk (2026 update)",
  "BEST ENTERPRISE",
  "BEST DX",
  "CHEAPEST AT SCALE",
  "MOST MATURE",
  "BEST UI"
];

const CENSUS: string[] = [
  "~$162",
  "$162/mo",
  "$162.50",
  "$0.00325/MAU after 50K",
  "25K (cloud)",
  "25K free MAU",
  "Tiered ($0.035",
  "$0.0275",
  "~$508",
  "~$1,383",
  "~$2,758",
  "~$1,250/mo",
  "~$3,750/mo",
  "~$175/mo",
  "~$525/mo",
  "~$100/mo (Pro plan)",
  "5K MAU (cloud)",
  "Apache 2.0 (Community)",
  "Red Hat SSO",
  "SSO + SCIM now free",
  "Node.js / Go (core)",
  "1,000 MAU, unlimited resources",
  "Passwordless-only",
  "purest passwordless",
  "zero user disruption",
  "fully open source (MIT)",
  "5+ providers",
  "$0.01–$0.06",
  "TOTP-based MFA is free on all providers",
  "512 MB+ RAM",
  "first-class AI agent support"
];

const AUTH_VENDOR_NAMES: string[] = [
  "Auth0",
  "Clerk",
  "Kinde",
  "PropelAuth",
  "Stytch",
  "Descope",
  "WorkOS",
  "Supabase",
  "Firebase",
  "Cognito",
  "Appwrite",
  "Keycloak",
  "Authentik",
  "authentik",
  "Authelia",
  "FusionAuth",
  "SuperTokens",
  "Hanko",
  "Ory",
  "Authgear",
  "MojoAuth",
  "Stack Auth",
  "Hexclave",
  "Permit.io",
  "Cerbos",
  "Authress"
];

const REPEATED_ELSEWHERE: Record<string, { was: string; now: string }> = {
  "/state-of-free-tiers": {
    "was": "At 100K MAU, Clerk costs ~$1,800/mo while Supabase Auth costs ~$162/mo — an 11x difference.",
    "now": "At 100,000 users, Clerk costs $1,025 a month and Supabase $25 a month on Pro."
  },
  "/free-saas-stack": {
    "was": "At 100K users: Clerk ~$175/mo, Supabase ~$25/mo (cheapest at scale).",
    "now": "At 100,000 users: Clerk costs $1,025 a month; Supabase costs $25 a month on Pro."
  },
  "/auth0-alternatives": {
    "was": "25K (cloud)",
    "now": "Self-hosted; cloud Developer plan has no production use"
  }
};

let server: ChildProcess;
let base = "";
const served = new Map<string, string>();

function decode(text: string): string {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&#39;|&#x27;|&rsquo;|’/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&mdash;/g, "—")
    .replace(/&ndash;/g, "–")
    .replace(/&rarr;/g, "→")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ");
}

function textOf(html: string): string {
  return decode(
    html
      .replace(/<script(?![^>]*ld\+json)[\s\S]*?<\/script>/g, " ")
      .replace(/<style[\s\S]*?<\/style>/g, " ")
      .replace(/<[^>]+>/g, " "),
  ).replace(/\s+/g, " ").replace(/ ([,.:;])/g, "$1").trim();
}

function tableWithHeader(html: string, header: string): string {
  const tables = [...html.matchAll(/<table[^>]*>[\s\S]*?<\/table>/g)].map(([table]) => table)
    .filter((table) => table.includes(`<th>${header}</th>`));
  assert.strictEqual(tables.length, 1, `the page has one table headed ${header}`);
  return tables[0];
}

function headersOf(table: string): string[] {
  return [...table.matchAll(/<th[^>]*>([\s\S]*?)<\/th>/g)].map(([, cell]) => textOf(cell));
}

function rowsOf(table: string): string[][] {
  return [...table.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)]
    .map(([, row]) => [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map(([, cell]) => cell))
    .filter((cells) => cells.length >= 2);
}

function nameOf(cell: string): string {
  return textOf(cell.replace(/<span[^>]*>[\s\S]*?<\/span>|<a [^>]*class="[^"]*"[^>]*>[\s\S]*?<\/a>|<a [^>]*style="display:inline-block[^>]*>[\s\S]*?<\/a>/g, ""));
}

function rowOf(table: string, vendor: string): string[] | undefined {
  const rows = rowsOf(table);
  return rows.find((cells) => nameOf(cells[0]) === vendor) ?? rows.find((cells) => nameOf(cells[0]).startsWith(`${vendor} (`));
}

function faqAnswers(html: string): string[] {
  const answers: string[] = [];
  for (const [, json] of html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)) {
    const data = JSON.parse(json);
    if (data["@type"] === "FAQPage") for (const entry of data.mainEntity) answers.push(entry.acceptedAnswer.text);
  }
  return answers;
}

function ownSections(html: string): string {
  const start = html.indexOf("<h1");
  const end = html.indexOf('id="faq"');
  return html.slice(start, end === -1 ? undefined : end);
}

async function routesIn(sitemap: string): Promise<string[]> {
  const xml = await (await fetch(`${base}${sitemap}`)).text();
  return [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map(([, loc]) => new URL(loc).pathname);
}

function nearAnAuthVendor(text: string, at: number, length: number): boolean {
  const window = text.slice(Math.max(0, at - 250), at + length + 250);
  return AUTH_VENDOR_NAMES.some((name) => window.includes(name));
}

describe("the auth comparison states each service's terms as the vendor does", () => {
  before(async () => {
    server = spawn("node", [path.join(REPO, "dist", "serve.js")], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, PORT: "0", BASE_URL: "http://localhost", TZ: "UTC" },
    });
    base = await new Promise<string>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Server startup timeout")), 30000);
      server.stderr!.on("data", (data: Buffer) => {
        const match = data.toString().match(/running on http:\/\/localhost:(\d+)/);
        if (match) {
          clearTimeout(timeout);
          resolve(`http://localhost:${match[1]}`);
        }
      });
      server.on("error", (err) => {
        clearTimeout(timeout);
        reject(err);
      });
    });
    const routes = new Set<string>([PAGE, ...Object.keys(REPEATED_ELSEWHERE)]);
    for (const sitemap of SITEMAPS_OF_GUIDES_AND_REPORTS) for (const route of await routesIn(sitemap)) routes.add(route);
    for (const route of routes) {
      const response = await fetch(`${base}${route}`);
      if (response.status === 200) served.set(route, await response.text());
    }
  });
  after(() => {
    server?.kill();
  });

  it("reads the page, the three pages that repeat its claims, and the rest of the guides and reports", () => {
    assert.ok(served.size > 60, `read ${served.size} routes`);
    for (const route of [PAGE, ...Object.keys(REPEATED_ELSEWHERE)]) assert.ok(served.has(route), `${route} renders`);
  });

  it("sets each table cell in its own column as the vendor's own pages state it", () => {
    const html = served.get(PAGE)!;
    const wrong = CELLS.flatMap(({ table, vendor, column, now }) => {
      const found = tableWithHeader(html, table);
      const row = rowOf(found, vendor);
      if (!row) return [`${table} / ${vendor}: no row`];
      const shown = column === "Provider" ? nameOf(row[0]) : textOf(row[headersOf(found).indexOf(column)] ?? "");
      return shown === now ? [] : [`${table} / ${vendor} / ${column}: ${shown}`];
    });
    assert.deepStrictEqual(wrong, []);
  });

  it("states every paragraph, card and FAQ answer as written", () => {
    const html = served.get(PAGE)!;
    const text = textOf(html);
    assert.deepStrictEqual(STATED_ON_THE_PAGE.filter((sentence) => !text.includes(sentence)), []);
    const answers = faqAnswers(html);
    for (const answer of [FAQ_BASIS, FAQ_LIMITS]) {
      assert.ok(text.includes(answer), `the page body does not state: ${answer}`);
      assert.ok(answers.some((a) => a.includes(answer)), `the FAQPage JSON-LD does not state: ${answer}`);
    }
    assert.ok(!answers.some((a) => a.includes("lock-in risk")), "an FAQ answer still names the lock-in column");
    assert.ok(!text.includes("CHEAPEST AT SCALE"), "the page still repeats a removed badge");
  });

  it("renders none of the rankings it withdrew, and no heading or badge of its own ranks a service", () => {
    const own = ownSections(served.get(PAGE)!);
    const text = textOf(own);
    assert.deepStrictEqual(WITHDRAWN_FROM_THE_PAGE.filter((phrase) => text.includes(phrase)), []);
    const ranking = [...own.matchAll(/<(h[1-4])[^>]*>([\s\S]*?)<\/\1>|<span class="winner-badge">([\s\S]*?)<\/span>/g)]
      .map(([, , heading, badge]) => textOf(heading ?? badge ?? ""))
      .filter((label) => /\b(best|most|cheapest)\b/i.test(label));
    assert.deepStrictEqual(ranking, []);
  });

  it("repeats none of the withdrawn figures near an auth vendor's name on any guide or report", () => {
    const found = [...served].flatMap(([route, html]) => {
      const text = textOf(html);
      return CENSUS.flatMap((claim) => {
        const hits: string[] = [];
        for (let at = text.indexOf(claim); at !== -1; at = text.indexOf(claim, at + 1)) {
          if (nearAnAuthVendor(text, at, claim.length)) hits.push(`${route}: ${claim}`);
        }
        return hits;
      });
    });
    assert.deepStrictEqual(found, []);
  });

  it("states the same costs and terms on the pages that repeat them", () => {
    const wrong = Object.entries(REPEATED_ELSEWHERE).flatMap(([route, { was, now }]) => {
      const text = textOf(served.get(route)!);
      return [...(text.includes(now) ? [] : [`${route}: missing ${now}`]), ...(text.includes(was) ? [`${route}: still ${was}`] : [])];
    });
    assert.deepStrictEqual(wrong, []);
  });

  it("keeps the figure badges and the Supabase pause card", () => {
    const html = served.get(PAGE)!;
    const main = tableWithHeader(html, "Service");
    assert.match(rowsOf(main).find((cells) => nameOf(cells[0]) === "WorkOS")?.[0] ?? "", /1M FREE/);
    const baas = tableWithHeader(html, "Platform");
    assert.match(rowsOf(baas).find((cells) => nameOf(cells[0]) === "Appwrite Auth")?.[0] ?? "", /75K FREE/);
    assert.match(textOf(html), /Supabase[^.]*pause/i);
  });

  it("gives Cognito's rows no badge from a record about another product", () => {
    const rows = [...served.get(PAGE)!.matchAll(/<tr[^>]*>\s*<td[^>]*>(?:<a [^>]*>)?AWS Cognito[\s\S]*?<\/tr>/g)].map(([row]) => row);
    assert.ok(rows.length >= 3, `found ${rows.length} Cognito rows`);
    const borrowed = rows.flatMap((row) => [...row.matchAll(/title="([^"]*)"[^>]*>CHANGED /g)].map(([, title]) => title))
      .filter((title) => !/for (?:AWS|Amazon) Cognito\b/.test(title));
    assert.deepStrictEqual(borrowed, []);
  });

  it("lists in its timeline only services the page tabulates", () => {
    const html = served.get(PAGE)!;
    const timeline = tableWithHeader(html, "Impact");
    const names = [...html.matchAll(/<td class="provider-col"[^>]*>([\s\S]*?)<\/td>/g)].map(([, cell]) => nameOf(cell));
    const formerly = names.flatMap((name) => name.match(/^(.+) \(formerly (.+)\)$/)?.slice(1) ?? []);
    const tabulated = new Set([...names, ...formerly].map((name) => name.toLowerCase()));
    const strangers = rowsOf(timeline).map((cells) => textOf(cells[1])).filter((vendor) => !tabulated.has(vendor.toLowerCase()));
    assert.deepStrictEqual(strangers, []);
  });
});
