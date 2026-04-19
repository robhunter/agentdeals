#!/usr/bin/env node
/**
 * End-to-end integration test for all 4 referral marketplace phases.
 *
 * Exercises:
 *   Phase 1 — Platform referral code lookup (Railway)
 *   Phase 2 — Agent registration + attribution logging
 *   Phase 3 — Agent code submission with trust tier
 *   Phase 4 — Friendships + friend-code visibility
 *
 * Starts a self-contained dev server on a free port with isolated empty data
 * files, runs every step against real HTTP, and restores the originals on exit.
 *
 * Exit code: 0 if all steps pass, 1 if any fail.
 *
 * Usage:
 *   node scripts/test-referral-pipeline.ts
 *   npm run test:referral-pipeline
 */

import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const DATA_DIR = path.join(ROOT, "data");
const SERVER_JS = path.join(ROOT, "dist", "serve.js");

const ISOLATED_FILES = {
  agents: path.join(DATA_DIR, "agents.json"),
  codes: path.join(DATA_DIR, "referral_codes.json"),
  friends: path.join(DATA_DIR, "agent_friends.json"),
  requests: path.join(DATA_DIR, "referral_requests.json"),
  ledger: path.join(DATA_DIR, "ledger_entries.json"),
  balances: path.join(DATA_DIR, "agent_balances.json"),
};

const EMPTY_CONTENTS: Record<keyof typeof ISOLATED_FILES, string> = {
  agents: JSON.stringify({ agents: [] }),
  codes: JSON.stringify({ referral_codes: [] }),
  friends: JSON.stringify({ agent_friends: [] }),
  requests: JSON.stringify({ referral_requests: [] }),
  ledger: JSON.stringify({ ledger_entries: [] }),
  balances: JSON.stringify({ agent_balances: [] }),
};

let passed = 0;
let failed = 0;
const failures: string[] = [];

function record(step: string, ok: boolean, detail = ""): void {
  const prefix = ok ? "PASS" : "FAIL";
  const line = `[${prefix}] ${step}${detail ? " — " + detail : ""}`;
  console.log(line);
  if (ok) passed += 1;
  else {
    failed += 1;
    failures.push(step + (detail ? ": " + detail : ""));
  }
}

function saveOriginals(): Map<string, string | null> {
  const snapshot = new Map<string, string | null>();
  for (const filePath of Object.values(ISOLATED_FILES)) {
    snapshot.set(filePath, fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf-8") : null);
  }
  return snapshot;
}

function restoreOriginals(snapshot: Map<string, string | null>): void {
  for (const [filePath, contents] of snapshot) {
    if (contents === null) {
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    } else {
      fs.writeFileSync(filePath, contents, "utf-8");
    }
  }
}

function resetToEmpty(): void {
  for (const [key, filePath] of Object.entries(ISOLATED_FILES)) {
    fs.writeFileSync(filePath, EMPTY_CONTENTS[key as keyof typeof EMPTY_CONTENTS], "utf-8");
  }
}

function startServer(): Promise<{ proc: ChildProcess; port: number }> {
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(SERVER_JS)) {
      reject(new Error(`dist/serve.js not found. Run \`npm run build\` first.`));
      return;
    }

    const proc = spawn("node", [SERVER_JS], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, PORT: "0", BASE_URL: "http://localhost" },
    });

    const timeout = setTimeout(() => {
      proc.kill();
      reject(new Error("Server startup timeout (15s)"));
    }, 15000);

    proc.stderr!.on("data", (chunk: Buffer) => {
      const match = chunk.toString().match(/running on http:\/\/localhost:(\d+)/);
      if (match) {
        clearTimeout(timeout);
        resolve({ proc, port: parseInt(match[1], 10) });
      }
    });

    proc.on("error", err => {
      clearTimeout(timeout);
      reject(err);
    });
  });
}

async function req(
  method: string,
  url: string,
  opts: { body?: unknown; apiKey?: string; expectStatus?: number | number[] } = {},
): Promise<{ status: number; body: any }> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (opts.apiKey) headers.Authorization = `Bearer ${opts.apiKey}`;
  const res = await fetch(url, {
    method,
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const text = await res.text();
  let parsed: any = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = text;
  }
  return { status: res.status, body: parsed };
}

async function main(): Promise<number> {
  console.log("Referral pipeline E2E test");
  console.log("==========================\n");

  const snapshot = saveOriginals();
  resetToEmpty();

  let serverProc: ChildProcess | null = null;

  const cleanup = () => {
    if (serverProc && !serverProc.killed) {
      serverProc.kill();
    }
    restoreOriginals(snapshot);
  };

  process.on("SIGINT", () => {
    cleanup();
    process.exit(130);
  });

  try {
    const started = await startServer();
    serverProc = started.proc;
    const base = `http://localhost:${started.port}`;

    // ---------- Phase 1: Referral code lookup ----------
    console.log("Phase 1 — Referral code lookup");

    const list = await req("GET", `${base}/api/referral-codes`);
    record(
      "1. GET /api/referral-codes returns ≥1 code (Railway)",
      list.status === 200 &&
        Array.isArray(list.body?.codes) &&
        list.body.codes.some((c: any) => c.vendor === "Railway"),
      `status=${list.status}, total=${list.body?.total ?? "n/a"}`,
    );

    const railway = await req("GET", `${base}/api/referral-codes/Railway`);
    record(
      "2. GET /api/referral-codes/Railway returns Railway code",
      railway.status === 200 &&
        railway.body?.vendor === "Railway" &&
        typeof railway.body?.code === "string" &&
        typeof railway.body?.referral_url === "string",
      `source=${railway.body?.source ?? "n/a"}`,
    );

    const offers = await req("GET", `${base}/api/offers?q=Railway&limit=5`);
    const railwayOffer = Array.isArray(offers.body?.offers)
      ? offers.body.offers.find((o: any) => o.vendor === "Railway")
      : null;
    record(
      "3. /api/offers Railway result has inline referral_code (search_deals parity)",
      !!railwayOffer && !!railwayOffer.referral_code && railwayOffer.referral_code.vendor === "Railway",
      railwayOffer ? `code=${railwayOffer.referral_code?.code ?? "null"}` : "no Railway offer in results",
    );

    // ---------- Phase 2: Agent registration + attribution ----------
    console.log("\nPhase 2 — Agent registration + attribution");

    const agentName = `dev-agent-test-${Date.now()}`;
    const reg = await req("POST", `${base}/api/agents/register`, { body: { name: agentName } });
    const apiKey = reg.body?.api_key;
    const agentId = reg.body?.id;
    record(
      "4. POST /api/agents/register issues an API key",
      reg.status === 201 && typeof apiKey === "string" && apiKey.startsWith("agd_") && typeof agentId === "string",
      `id=${agentId ?? "n/a"}`,
    );

    // Authenticated lookup — should log a referral request for attribution.
    const authedLookup = await req("GET", `${base}/api/referral/Railway`, { apiKey });
    record(
      "5. Authenticated GET /api/referral/Railway logs attribution",
      authedLookup.status === 200 && authedLookup.body?.attributed === true && authedLookup.body?.vendor === "Railway",
      `attributed=${authedLookup.body?.attributed}`,
    );

    // Balance is the current name of the "credits" endpoint.
    const balance = await req("GET", `${base}/api/agents/${encodeURIComponent(agentId)}/balance`, { apiKey });
    record(
      "6. GET /api/agents/:id/balance returns a balance record",
      balance.status === 200 &&
        typeof balance.body?.pending_balance === "number" &&
        typeof balance.body?.confirmed_balance === "number",
      `pending=${balance.body?.pending_balance}, confirmed=${balance.body?.confirmed_balance}`,
    );

    // ---------- Phase 3: Code submission ----------
    console.log("\nPhase 3 — Code submission");

    // Use a vendor without a platform code so our submission shows through in
    // the per-vendor lookup. Supabase is in the index but has no platform code.
    const submitVendor = "Supabase";
    const submitPayload = {
      vendor: submitVendor,
      code: `E2E-${Date.now()}`,
      referral_url: "https://supabase.com/?ref=e2e-test",
      description: "E2E test submission — safe to revoke",
    };
    const submit = await req("POST", `${base}/api/referral-codes`, { body: submitPayload, apiKey });
    const submittedCodeId = submit.body?.id;
    record(
      "7. POST /api/referral-codes submits a code (agent, active)",
      submit.status === 201 && typeof submittedCodeId === "string" && submit.body?.status === "active",
      `id=${submittedCodeId ?? "n/a"}, status=${submit.body?.status ?? "n/a"}`,
    );

    const listAfter = await req("GET", `${base}/api/referral-codes?source=agent`);
    const foundSubmitted = Array.isArray(listAfter.body?.codes)
      ? listAfter.body.codes.some((c: any) => c.vendor === submitVendor && c.code === submitPayload.code)
      : false;
    record(
      "8. Submitted code appears in GET /api/referral-codes?source=agent",
      listAfter.status === 200 && foundSubmitted,
      `agent_codes=${listAfter.body?.total ?? "n/a"}`,
    );

    record(
      "9. Submitted code records trust_tier=new for a brand-new agent",
      submit.body?.trust_tier_at_submission === "new",
      `trust_tier_at_submission=${submit.body?.trust_tier_at_submission ?? "n/a"}`,
    );

    // Revoke via DELETE — resubmit later to set up friend-priority test.
    if (submittedCodeId) {
      const del = await req("DELETE", `${base}/api/referral-codes/${submittedCodeId}`, { apiKey });
      record(
        "10. DELETE /api/referral-codes/:id revokes the test code",
        del.status === 200 && del.body?.status === "revoked",
        `status=${del.body?.status ?? "n/a"}`,
      );
    } else {
      record("10. DELETE /api/referral-codes/:id revokes the test code", false, "no code id returned from step 7");
    }

    // ---------- Phase 4: Friendships ----------
    console.log("\nPhase 4 — Friendships");

    const friendName = `dev-agent-test-friend-${Date.now()}`;
    const friendReg = await req("POST", `${base}/api/agents/register`, { body: { name: friendName } });
    const friendKey = friendReg.body?.api_key;
    const friendId = friendReg.body?.id;
    record(
      "11. Register second test agent",
      friendReg.status === 201 && typeof friendKey === "string" && typeof friendId === "string",
      `id=${friendId ?? "n/a"}`,
    );

    const addFriend = await req("POST", `${base}/api/friends`, { body: { agent_id: friendId }, apiKey });
    record(
      "12. POST /api/friends creates a friendship",
      addFriend.status === 201 && addFriend.body?.agent_id === agentId && addFriend.body?.friend_id === friendId,
      `status=${addFriend.status}`,
    );

    const friendsList = await req("GET", `${base}/api/friends`, { apiKey });
    const friendListed = Array.isArray(friendsList.body?.friends)
      ? friendsList.body.friends.some((f: any) => f.agent_id === friendId)
      : false;
    record(
      "13. GET /api/friends includes second agent",
      friendsList.status === 200 && friendListed,
      `friends=${friendsList.body?.friends?.length ?? 0}`,
    );

    // Friend submits a code for a vendor we don't carry as a platform code
    // so friend visibility isn't masked by platform ranking.
    const friendSubmitVendor = "Vercel";
    const friendSubmit = await req("POST", `${base}/api/referral-codes`, {
      body: {
        vendor: friendSubmitVendor,
        code: `E2E-FRIEND-${Date.now()}`,
        referral_url: "https://vercel.com/?ref=e2e-friend",
        description: "E2E friend submission",
      },
      apiKey: friendKey,
    });
    const friendCodeId = friendSubmit.body?.id;

    const friendCodes = await req("GET", `${base}/api/friends/codes`, { apiKey });
    const friendVendorListed = Array.isArray(friendCodes.body?.vendors)
      ? friendCodes.body.vendors.some(
          (v: any) =>
            v.vendor === friendSubmitVendor && Array.isArray(v.codes) && v.codes.some((c: any) => c.agent_id === friendId),
        )
      : false;
    record(
      "14. GET /api/friends/codes surfaces friend-submitted codes (friend priority)",
      friendCodes.status === 200 && friendVendorListed,
      `vendors=${friendCodes.body?.vendors?.length ?? 0}`,
    );

    // Cleanup: revoke friend code and remove friendship.
    let cleanupOk = true;
    const cleanupDetails: string[] = [];
    if (friendCodeId) {
      const delFriendCode = await req("DELETE", `${base}/api/referral-codes/${friendCodeId}`, { apiKey: friendKey });
      if (delFriendCode.status !== 200) {
        cleanupOk = false;
        cleanupDetails.push(`revoke friend code: status=${delFriendCode.status}`);
      }
    }
    const removeFriend = await req("DELETE", `${base}/api/friends/${encodeURIComponent(friendId)}`, { apiKey });
    if (removeFriend.status !== 200) {
      cleanupOk = false;
      cleanupDetails.push(`remove friend: status=${removeFriend.status}`);
    }
    record("15. Cleanup: revoke friend code and remove friendship", cleanupOk, cleanupDetails.join("; "));
  } catch (err: any) {
    record("runner", false, err.message);
  } finally {
    cleanup();
  }

  console.log(`\nResults: ${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.log("\nFailures:");
    for (const f of failures) console.log(`  - ${f}`);
  }
  return failed === 0 ? 0 : 1;
}

main().then(code => process.exit(code));
