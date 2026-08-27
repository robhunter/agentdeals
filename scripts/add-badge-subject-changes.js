#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CHANGES = path.join(__dirname, "..", "data", "deal_changes.json");

const RECORDS = [
  {
    vendor: "Amazon SES",
    change_type: "free_tier_removed",
    date: "2025-07-16",
    summary:
      "AWS restructured its Free Tier into expiring credits, which removed the per-service SES allowance for new accounts. The SES pricing page, read 2026-08-27, offers only 'up to $200 in AWS Free Tier credits' with 'the free plan will be available for 6 months after account creation' and no perpetual sending allowance from any source.",
    previous_state:
      "3,000 messages/month free, rising to 62,000 emails/month when sent from EC2, Lambda or Elastic Beanstalk; $0.10/1,000 from external servers",
    current_state:
      "No free sending allowance. Up to $200 in AWS Free Tier credits usable across eligible services, free plan for 6 months after account creation, credits expiring 12 months after account creation, then $0.10/1,000 emails from any source",
    impact: "high",
    source_url: "https://aws.amazon.com/about-aws/whats-new/2025/07/aws-free-tier-credits-month-free-plan/",
    category: "Email",
    alternatives: ["Resend", "Maileroo", "MailerSend", "Brevo", "Postal"],
  },
  {
    vendor: "Storj",
    change_type: "free_tier_removed",
    date: "2025-07-01",
    summary:
      "Storj introduced a $5 minimum monthly usage fee for all accounts, announced 2025-05-30 and effective 2025-07-01, leaving a 30-day trial where the free tier used to be. The pricing page, read 2026-08-27, offers '25GB free storage for 30 days' with 'no credit card required' and applies the minimum fee once the trial ends, except for accounts paying in STORJ token.",
    previous_state: "25 GB storage and 25 GB egress per month free with no time limit and no minimum spend",
    current_state:
      "25 GB free for 30 days as a trial, then $7/TB stored and $7/TB egress against a $5 minimum monthly fee; the minimum does not apply during the trial or to accounts paying in STORJ token",
    impact: "high",
    source_url: "https://forum.storj.io/t/new-minimum-usage-fee-starting-july-1/30057",
    category: "Storage",
    alternatives: ["Cloudflare R2", "Backblaze B2", "Tigris", "MinIO"],
  },
];

const text = readFileSync(CHANGES, "utf-8");
const data = JSON.parse(text);
const seen = new Set(data.changes.map((c) => `${c.vendor}|${c.date}|${c.change_type}`));

const pending = [];
for (const rec of RECORDS) {
  const key = `${rec.vendor}|${rec.date}|${rec.change_type}`;
  if (seen.has(key)) {
    console.log(`skip (already present): ${key}`);
    continue;
  }
  pending.push(rec);
  console.log(`added: ${key}`);
}

if (pending.length > 0) {
  const tail = text.lastIndexOf("\n  ]");
  if (tail < 0) throw new Error("could not find the end of the changes array");
  const block = pending
    .map((rec) => JSON.stringify(rec, null, 2).split("\n").map((l) => "    " + l).join("\n"))
    .join(",\n");
  writeFileSync(CHANGES, text.slice(0, tail) + ",\n" + block + text.slice(tail));
}
console.log(`\n${pending.length} added, ${data.changes.length + pending.length} changes total`);
