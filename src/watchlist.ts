import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { loadDealChanges } from "./data.js";
import type { DealChange } from "./types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WATCHLIST_PATH = path.join(__dirname, "..", "data", "watchlist.json");

const MAX_VENDORS_PER_WEBHOOK = 50;
const MAX_RETRIES = 3;

export interface WatchlistSubscription {
  id: string;
  vendor: string;
  webhook_url: string;
  secret: string;
  created_at: string;
  last_notified_change?: string;
}

interface WatchlistData {
  subscriptions: WatchlistSubscription[];
}

let cached: WatchlistData | null = null;

function load(): WatchlistData {
  if (cached) return cached;
  if (!fs.existsSync(WATCHLIST_PATH)) {
    cached = { subscriptions: [] };
    return cached;
  }
  try {
    const raw = fs.readFileSync(WATCHLIST_PATH, "utf-8");
    cached = JSON.parse(raw) as WatchlistData;
    if (!Array.isArray(cached!.subscriptions)) cached = { subscriptions: [] };
  } catch {
    cached = { subscriptions: [] };
  }
  return cached!;
}

function save(data: WatchlistData): void {
  fs.writeFileSync(WATCHLIST_PATH, JSON.stringify(data, null, 2), "utf-8");
  cached = data;
}

export function resetWatchlistCache(): void {
  cached = null;
}

export function subscribe(vendor: string, webhookUrl: string): WatchlistSubscription {
  const data = load();

  const countForUrl = data.subscriptions.filter(s => s.webhook_url === webhookUrl).length;
  if (countForUrl >= MAX_VENDORS_PER_WEBHOOK) {
    throw new Error("Maximum " + MAX_VENDORS_PER_WEBHOOK + " watched vendors per webhook URL");
  }

  const existing = data.subscriptions.find(
    s => s.vendor.toLowerCase() === vendor.toLowerCase() && s.webhook_url === webhookUrl
  );
  if (existing) {
    throw new Error("Already watching this vendor with this webhook URL");
  }

  const sub: WatchlistSubscription = {
    id: crypto.randomUUID(),
    vendor: vendor,
    webhook_url: webhookUrl,
    secret: crypto.randomBytes(32).toString("hex"),
    created_at: new Date().toISOString(),
  };

  data.subscriptions.push(sub);
  save(data);
  return sub;
}

export function getSubscription(id: string): WatchlistSubscription | null {
  return load().subscriptions.find(s => s.id === id) ?? null;
}

export function unsubscribe(id: string): boolean {
  const data = load();
  const idx = data.subscriptions.findIndex(s => s.id === id);
  if (idx === -1) return false;
  data.subscriptions.splice(idx, 1);
  save(data);
  return true;
}

export function listSubscriptions(webhookUrl?: string): WatchlistSubscription[] {
  const subs = load().subscriptions;
  if (webhookUrl) return subs.filter(s => s.webhook_url === webhookUrl);
  return [...subs];
}

export function getSubscriptionCount(): number {
  return load().subscriptions.length;
}

function signPayload(payload: string, secret: string): string {
  return crypto.createHmac("sha256", secret).update(payload).digest("hex");
}

async function deliverWebhook(
  sub: WatchlistSubscription,
  change: DealChange,
): Promise<boolean> {
  const payload = JSON.stringify({
    event: "pricing_change",
    subscription_id: sub.id,
    vendor: change.vendor,
    change_type: change.change_type,
    summary: change.summary,
    date: change.date,
    impact: change.impact,
    previous_state: change.previous_state,
    current_state: change.current_state,
    link: "https://agentdeals.dev/pricing-changes",
  });

  const signature = signPayload(payload, sub.secret);

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const resp = await fetch(sub.webhook_url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-AgentDeals-Signature": signature,
          "X-AgentDeals-Event": "pricing_change",
        },
        body: payload,
        signal: AbortSignal.timeout(10000),
      });
      if (resp.ok) return true;
    } catch {
      // retry
    }
    if (attempt < MAX_RETRIES) {
      await new Promise(r => setTimeout(r, Math.pow(2, attempt) * 1000));
    }
  }
  return false;
}

export async function checkAndNotify(): Promise<{ sent: number; failed: number }> {
  const data = load();
  if (data.subscriptions.length === 0) return { sent: 0, failed: 0 };

  const changes = loadDealChanges();
  const sorted = [...changes].sort((a, b) => b.date.localeCompare(a.date));

  let sent = 0;
  let failed = 0;

  for (const sub of data.subscriptions) {
    const vendorChanges = sorted.filter(
      c => c.vendor.toLowerCase() === sub.vendor.toLowerCase()
    );
    if (vendorChanges.length === 0) continue;

    const newChanges = sub.last_notified_change
      ? vendorChanges.filter(c => c.date > sub.last_notified_change!)
      : vendorChanges.slice(0, 1);

    for (const change of newChanges) {
      const ok = await deliverWebhook(sub, change);
      if (ok) {
        sent++;
        sub.last_notified_change = change.date;
      } else {
        failed++;
      }
    }
  }

  save(data);
  return { sent, failed };
}

export { signPayload as _signPayload };
