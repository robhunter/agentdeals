interface ShutdownIndexRestriction {
  service: string;
  sourceUrl: string;
  sourceText: string[];
  knownOn: string;
  note: string;
}

const restrictions: readonly ShutdownIndexRestriction[] = [
  {
    "service": "pay-as-you-go API access to MiniMax-M2.7, MiniMax-M2.7-highspeed, MiniMax-M2.5 and MiniMax-M2.5-highspeed",
    "sourceUrl": "https://platform.minimax.io/docs/faq/models",
    "sourceText": [
      "These models are no longer available to new users from 2026-10-19 and are retired on 2026-11-18."
    ],
    "knownOn": "2026-10-19",
    "note": "closed to new users since October 19, 2026"
  },
  {
    "service": "Azure OpenAI o-series model retirement",
    "sourceUrl": "https://learn.microsoft.com/en-us/azure/foundry/openai/concepts/model-retirement-schedule",
    "sourceText": [
      "These models are deprecated, so new customers cannot deploy them."
    ],
    "knownOn": "2026-11-16",
    "note": "closed to new customers"
  },
  {
    "service": "Conductor Cloud",
    "sourceUrl": "https://www.conductor.build/changelog/0.93.0-conductor-is-joining-meta",
    "sourceText": [
      "It goes read-only on November 13, 2026: old chats can still be read and exported, but no new messages sent.",
      "Since November 4, 2026, new users cannot sign up or download the app."
    ],
    "knownOn": "2026-11-13",
    "note": "read-only since November 13, 2026"
  },
  {
    "service": "OpenAI Agent Builder, Evals platform and reusable prompts",
    "sourceUrl": "https://developers.openai.com/api/docs/deprecations",
    "sourceText": [
      "Existing evals become read-only on October 31, 2026."
    ],
    "knownOn": "2026-10-31",
    "note": "existing evals read-only since October 31, 2026"
  },
  {
    "service": "Zeabur",
    "sourceUrl": "https://zeabur.com/blogs/zeabur-is-shutting-down",
    "sourceText": [
      "New dedicated servers and domains can no longer be bought since October 17, 2026."
    ],
    "knownOn": "2026-11-12",
    "note": "no new dedicated servers or domains since October 17, 2026"
  },
  {
    "service": "AWS Infrastructure Composer's standalone console",
    "sourceUrl": "https://docs.aws.amazon.com/infrastructure-composer/latest/dg/infrastructure-composer-end-of-support.html",
    "sourceText": [
      "New customers have not been able to sign up since October 29, 2026.",
      "Existing customers can use the console until December 7, 2026."
    ],
    "knownOn": "2026-11-12",
    "note": "closed to new customers since October 29, 2026"
  },
  {
    "service": "Val Town",
    "sourceUrl": "https://blog.val.town/winding-down",
    "sourceText": [
      "Val Town announced on 2026-11-10 that it is winding down: new signups and plan upgrades ended that day, and Val Town becomes read-only on December 10, 2026, except SQLite and blob storage."
    ],
    "knownOn": "2026-11-11",
    "note": "no new signups or plan upgrades since November 10, 2026"
  },
  {
    "service": "Google Jules",
    "sourceUrl": "https://jules.google/docs/changelog",
    "sourceText": [
      "Jules, Google's asynchronous coding agent, has been read-only since November 11, 2026, and winds down on December 31, 2026."
    ],
    "knownOn": "2026-11-12",
    "note": "read-only since November 11, 2026"
  },
  {
    "service": "HCP Vagrant and the Vagrant Public Registry",
    "sourceUrl": "https://www.hashicorp.com/en/blog/hcp-vagrant-deprecation-important-dates-and-migration-guidance",
    "sourceText": [
      "new boxes and registries could not be created from October 1, 2026"
    ],
    "knownOn": "2026-11-12",
    "note": "no new boxes or registries since October 1, 2026"
  },
  {
    "service": "AWS support plans: Developer, Business and Enterprise On-Ramp",
    "sourceUrl": "https://docs.aws.amazon.com/awssupport/latest/user/support-plans-eos.html",
    "sourceText": [
      "Neither plan has accepted new subscriptions since December 2, 2025."
    ],
    "knownOn": "2026-11-15",
    "note": "closed to new subscriptions since December 2, 2025"
  },
  {
    "service": "Google's Custom Search JSON API",
    "sourceUrl": "https://developers.google.com/custom-search/v1/overview",
    "sourceText": [
      "It is closed to new customers."
    ],
    "knownOn": "2026-11-12",
    "note": "closed to new customers"
  },
  {
    "service": "creating fine-tuning jobs on OpenAI's self-serve platform",
    "sourceUrl": "https://developers.openai.com/api/docs/deprecations#update-to-openais-self-serve-fine-tuning",
    "sourceText": [
      "Since May 7, 2026, organizations that never ran fine-tuning cannot create jobs.",
      "Since July 2, 2026, organizations that have not run inference on a fine-tuned model in the past 60 days cannot either."
    ],
    "knownOn": "2026-11-13",
    "note": "since July 2, 2026 only organizations that used a fine-tuned model in the past 60 days can create jobs"
  },
  {
    "service": "Claude Opus 4.1 on Amazon Bedrock",
    "sourceUrl": "https://docs.aws.amazon.com/bedrock/latest/userguide/model-lifecycle-legacy.html",
    "sourceText": [
      "It has been Legacy on Bedrock since July 8, 2026.",
      "New customers cannot use it.",
      "Accounts that leave it unused for 15 days may lose access.",
      "Since October 8, 2026 it has been in public extended access."
    ],
    "knownOn": "2026-11-16",
    "note": "Legacy since July 8, 2026: closed to new customers"
  },
  {
    "service": "Heroku Postgres 15",
    "sourceUrl": "https://devcenter.heroku.com/changelog-items/3750",
    "sourceText": [
      "New Postgres 15 databases cannot be created since November 11, 2026, though forks and followers of existing ones can."
    ],
    "knownOn": "2026-11-15",
    "note": "no new databases since November 11, 2026, except forks and followers"
  },
  {
    "service": "Google App Engine standard: Python 2.7, Java 8, PHP 5.5 and Go 1.11",
    "sourceUrl": "https://cloud.google.com/appengine/docs/standard/lifecycle/support-schedule",
    "sourceText": [
      "Since January 31, 2026, apps on these four runtimes cannot be deployed or redeployed.",
      "This applies even in organizations that had re-enabled deployments with an organization policy.",
      "Their project configuration cannot be updated."
    ],
    "knownOn": "2026-11-15",
    "note": "no deploys or redeploys since January 31, 2026"
  },
  {
    "service": "Twilio Notify",
    "sourceUrl": "https://support.twilio.com/hc/en-us/articles/9198083260571-Transitioning-off-Notify",
    "sourceText": [
      "Twilio stopped selling Notify in 2022, so new customers cannot use it."
    ],
    "knownOn": "2026-11-14",
    "note": "closed to new customers since 2022"
  },
  {
    "service": "HubSpot's design manager serverless functions (/_hcms/api/)",
    "sourceUrl": "https://developers.hubspot.com/changelog/sunsetting-design-manager-serverless-functions-and-older-node.js-runtimes-for-custom-code-actions",
    "sourceText": [
      "No new functions can be created since November 3, 2026."
    ],
    "knownOn": "2026-11-17",
    "note": "no new functions since November 3, 2026, no edits since November 17"
  },
  {
    "service": "26 Amazon Bedrock models from DeepSeek, Google, Meta, Mistral AI, Qwen and others",
    "sourceUrl": "https://docs.aws.amazon.com/bedrock/latest/userguide/model-lifecycle-legacy.html",
    "sourceText": [
      "They have been Legacy on Bedrock since September 30, 2026.",
      "New customers cannot use them.",
      "Accounts that leave one unused for 15 days may lose access.",
      "No new Provisioned Throughput can be created."
    ],
    "knownOn": "2026-11-16",
    "note": "Legacy since September 30, 2026: closed to new customers"
  },
  {
    "service": "AWS WorkSpaces Thin Client",
    "sourceUrl": "https://docs.aws.amazon.com/workspaces-thin-client/latest/ug/workspacesthinclient-end-of-support.html",
    "sourceText": [
      "Closed to new customers since 2026-04-20."
    ],
    "knownOn": "2026-04-20",
    "note": "closed to new customers since April 20, 2026; existing customers can use it until then"
  },
  {
    "service": "Azure Cache for Redis Enterprise and Enterprise Flash tiers",
    "sourceUrl": "https://learn.microsoft.com/en-us/azure/azure-cache-for-redis/retirement-faq",
    "sourceText": [
      "Creating new Enterprise or Enterprise Flash caches has been blocked since April 1, 2026."
    ],
    "knownOn": "2026-11-15",
    "note": "no new caches since April 1, 2026"
  },
  {
    "service": "Gadget",
    "sourceUrl": "https://gadget.dev/blog/gadget-wind-down",
    "sourceText": [
      "New applications cannot be started since November 9, 2026, and first-time deploys to production are allowed until the end of November 2026."
    ],
    "knownOn": "2026-11-12",
    "note": "no new apps since November 9, 2026; existing apps keep running until then"
  },
  {
    "service": "Python 3.10 on Cloud Functions for Firebase and Cloud Run functions",
    "sourceUrl": "https://cloud.google.com/functions/docs/runtime-support",
    "sourceText": [
      "The Node.js 20 runtime of these products was already decommissioned on October 30, 2026.",
      "Node.js 20 functions can no longer be deployed."
    ],
    "knownOn": "2026-11-15",
    "note": "Node.js 20 functions cannot be deployed since October 30, 2026"
  },
  {
    "service": "Claude Sonnet 4.5 on Amazon Bedrock",
    "sourceUrl": "https://docs.aws.amazon.com/bedrock/latest/userguide/model-lifecycle-legacy.html",
    "sourceText": [
      "It has been Legacy on Bedrock since October 8, 2026.",
      "New customers cannot use it.",
      "Accounts that leave it unused for 15 days may lose access."
    ],
    "knownOn": "2026-11-16",
    "note": "Legacy since October 8, 2026: closed to new customers"
  },
  {
    "service": "Auth0 Hooks",
    "sourceUrl": "https://auth0.com/docs/customize/hooks",
    "sourceText": [
      "They have been read-only since November 18, 2024, and tenants created from October 16, 2023 never had them."
    ],
    "knownOn": "2026-10-12",
    "note": "read-only since November 18, 2024"
  },
  {
    "service": "Heroku's Heroku-22 stack",
    "sourceUrl": "https://help.heroku.com/NQNCQTEJ/heroku-22-end-of-life-faq",
    "sourceText": [
      "Since November 1, 2026, the first build of each Heroku-22 app in a 30-day period fails with a deprecation error; retrying it deploys as normal."
    ],
    "knownOn": "2026-11-15",
    "note": "since November 1, 2026 the first build in each 30 days fails, and a retry deploys"
  },
  {
    "service": "Google Cloud Deployment Manager",
    "sourceUrl": "https://docs.cloud.google.com/deployment-manager/docs/deprecations",
    "sourceText": [
      "Since June 30, 2026, new users cannot enable the Deployment Manager API or create a first deployment.",
      "Existing deployments can use Deployment Manager until June 30, 2027."
    ],
    "knownOn": "2026-11-13",
    "note": "closed to new users since June 30, 2026; existing deployments can use it until then"
  },
  {
    "service": "Amazon DevOps Guru",
    "sourceUrl": "https://docs.aws.amazon.com/devops-guru/latest/userguide/devops-guru-end-of-support.html",
    "sourceText": [
      "New customers have not been able to sign up since October 29, 2026.",
      "Existing customers can use it until September 30, 2027."
    ],
    "knownOn": "2026-11-13",
    "note": "closed to new customers since October 29, 2026; existing customers can use it until then"
  },
  {
    "service": "Auth0 Rules",
    "sourceUrl": "https://auth0.com/docs/customize/rules",
    "sourceText": [
      "They have been read-only since November 18, 2024, and tenants created from October 16, 2023 never had them."
    ],
    "knownOn": "2026-10-31",
    "note": "read-only since November 18, 2024"
  },
  {
    "service": "Azure Cache for Redis Basic, Standard and Premium tiers",
    "sourceUrl": "https://learn.microsoft.com/en-us/azure/azure-cache-for-redis/retirement-faq",
    "sourceText": [
      "Since April 1, 2026 new customers in Azure's public cloud cannot create caches in these tiers.",
      "A tenant that had any Azure Cache for Redis instance before April 1, 2026 can keep creating them until the retirement."
    ],
    "knownOn": "2026-11-15",
    "note": "since April 1, 2026 only tenants that already had a cache can create new ones"
  },
  {
    "service": "Azure Communication Services (ACS) standalone services",
    "sourceUrl": "https://learn.microsoft.com/en-us/azure/communication-services/acs-retirement-and-breaking-changes-guide",
    "sourceText": [
      "Customers without an ACS resource created before October 23, 2026 cannot acquire phone numbers for SMS or PSTN calling."
    ],
    "knownOn": "2026-11-13",
    "note": "since October 23, 2026 new customers cannot get SMS or calling numbers"
  }
];

export function shutdownIndexNote(entry: { service: string; what: string; dateSource?: string }, today: string): string {
  return restrictions.find(restriction => restriction.service === entry.service
    && restriction.sourceUrl === entry.dateSource
    && restriction.knownOn <= today
    && restriction.sourceText.every(text => entry.what.includes(text)))?.note ?? "";
}
