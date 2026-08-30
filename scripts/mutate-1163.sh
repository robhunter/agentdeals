#!/usr/bin/env bash
set -u

REPO="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO" || exit 1

STORE="src/durable-store.ts"
AGENTS="src/agents.ts"
ATTRIB="src/referral-attribution.ts"
X402="src/x402.ts"
SERVE="src/serve.ts"
BACKUP_DIR="$(mktemp -d)"
cp "$STORE" "$BACKUP_DIR/durable-store.ts"
cp "$AGENTS" "$BACKUP_DIR/agents.ts"
cp "$ATTRIB" "$BACKUP_DIR/referral-attribution.ts"
cp "$X402" "$BACKUP_DIR/x402.ts"
cp "$SERVE" "$BACKUP_DIR/serve.ts"

restore() {
  cp "$BACKUP_DIR/durable-store.ts" "$STORE"
  cp "$BACKUP_DIR/agents.ts" "$AGENTS"
  cp "$BACKUP_DIR/referral-attribution.ts" "$ATTRIB"
  cp "$BACKUP_DIR/x402.ts" "$X402"
  cp "$BACKUP_DIR/serve.ts" "$SERVE"
}
trap restore EXIT

killed=0
survived=0
TESTS="test/durable-identity.test.ts test/marketplace-api.test.ts"

run_mutation() {
  local name="$1"
  shift
  echo "=== $name"
  restore
  "$@"
  if diff -q "$BACKUP_DIR/durable-store.ts" "$STORE" > /dev/null \
    && diff -q "$BACKUP_DIR/agents.ts" "$AGENTS" > /dev/null \
    && diff -q "$BACKUP_DIR/referral-attribution.ts" "$ATTRIB" > /dev/null \
    && diff -q "$BACKUP_DIR/x402.ts" "$X402" > /dev/null \
    && diff -q "$BACKUP_DIR/serve.ts" "$SERVE" > /dev/null; then
    echo "    NOT APPLIED: the mutation changed no file, so it proves nothing"
    survived=$((survived + 1))
    return
  fi
  if ! npm run build > /tmp/mutate-1163-build.log 2>&1; then
    echo "    NOT APPLIED: the mutation does not compile, so no test ran"
    tail -3 /tmp/mutate-1163-build.log
    survived=$((survived + 1))
    return
  fi
  if timeout 900 node --test --test-concurrency 1 $TESTS > /tmp/mutate-1163-test.log 2>&1; then
    echo "    SURVIVED"
    survived=$((survived + 1))
  else
    echo "    KILLED: $(grep -c '✖ ' /tmp/mutate-1163-test.log) failing assertion(s)"
    grep '✖ ' /tmp/mutate-1163-test.log | head -4
    killed=$((killed + 1))
  fi
}

py() { python3 - "$@"; }

m_an_unread_store_is_written_anyway() {
  py <<'PY'
p = "src/durable-store.ts"
s = open(p).read()
s = s.replace("""      lastWriteError = hydratedFromBackend
        ? `${opts.name} had to be read from durable storage first, so this change was not applied`
        : `${opts.name} was not read from durable storage, so writing would discard what is stored`;
      restoreLastPersisted();
      return { ok: false, error: lastWriteError };""", "")
open(p, "w").write(s)
PY
}

m_a_failed_write_is_reported_as_success() {
  py <<'PY'
p = "src/durable-store.ts"
s = open(p).read()
s = s.replace("""    if (!res.ok) {
      lastWriteError = res.error ?? "durable write failed";
      restoreLastPersisted();
      return { ok: false, error: lastWriteError };
    }""", "")
open(p, "w").write(s)
PY
}

m_a_failed_write_keeps_the_unstored_records() {
  py <<'PY'
p = "src/durable-store.ts"
s = open(p).read()
s = s.replace("""      lastWriteError = res.error ?? "durable write failed";
      restoreLastPersisted();""",
              """      lastWriteError = res.error ?? "durable write failed";""")
open(p, "w").write(s)
PY
}

m_a_failed_read_counts_as_an_empty_store() {
  py <<'PY'
p = "src/durable-store.ts"
s = open(p).read()
s = s.replace("""    if (!res.ok) {
      lastReadError = res.error ?? "durable read failed";
      hydratedFromBackend = false;
      return;
    }""",
              """    if (!res.ok) {
      lastReadError = res.error ?? "durable read failed";
      hydratedFromBackend = true;
      cache = [];
      persisted = serialize([]);
      return;
    }""")
open(p, "w").write(s)
PY
}

m_the_file_is_written_even_with_a_backend() {
  py <<'PY'
p = "src/durable-store.ts"
s = open(p).read()
s = s.replace("""    cache = next;
    if (!backend) {
      writeFile(next);
      return;
    }
    unflushed = true;""",
              """    cache = next;
    writeFile(next);
    if (!backend) return;
    unflushed = true;""")
open(p, "w").write(s)
PY
}

m_a_save_is_never_marked_for_writing() {
  py <<'PY'
p = "src/durable-store.ts"
s = open(p).read()
s = s.replace("""    unflushed = true;
  }

  async function runFlush()""",
              """    unflushed = false;
  }

  async function runFlush()""")
open(p, "w").write(s)
PY
}

m_every_flush_spends_a_write() {
  py <<'PY'
p = "src/durable-store.ts"
s = open(p).read()
s = s.replace("    if (!backend || !unflushed) return { ok: true };",
              "    if (!backend) return { ok: true };")
open(p, "w").write(s)
PY
}

m_durability_is_claimed_without_reading_the_backend() {
  py <<'PY'
p = "src/durable-store.ts"
s = open(p).read()
s = s.replace("  const durable = backend !== null && stores.every(s => s.hydrated);",
              "  const durable = backend !== null;")
open(p, "w").write(s)
PY
}

m_a_stored_value_is_ignored_in_favour_of_the_file() {
  py <<'PY'
p = "src/durable-store.ts"
s = open(p).read()
s = s.replace("""      cache = stored;
      persisted = serialize(stored);""",
              """      cache = readFile();
      persisted = serialize(cache);""")
open(p, "w").write(s)
PY
}

m_a_store_reports_itself_hydrated_regardless() {
  py <<'PY'
p = "src/durable-store.ts"
s = open(p).read()
s = s.replace("      hydrated: backend ? hydratedFromBackend : cache !== null,",
              "      hydrated: true,")
open(p, "w").write(s)
PY
}

m_a_seeded_store_is_never_written_back() {
  py <<'PY'
p = "src/durable-store.ts"
s = open(p).read()
s = s.replace("    unflushed = seed.length > 0;",
              "    unflushed = false;")
open(p, "w").write(s)
PY
}

m_a_recovered_read_reports_the_dropped_change_as_saved() {
  py <<'PY'
p = "src/durable-store.ts"
s = open(p).read()
s = s.replace("""      lastWriteError = hydratedFromBackend
        ? `${opts.name} had to be read from durable storage first, so this change was not applied`
        : `${opts.name} was not read from durable storage, so writing would discard what is stored`;
      restoreLastPersisted();
      return { ok: false, error: lastWriteError };""",
              """      if (!hydratedFromBackend) {
        lastWriteError = `${opts.name} was not read from durable storage, so writing would discard what is stored`;
        restoreLastPersisted();
        return { ok: false, error: lastWriteError };
      }""")
open(p, "w").write(s)
PY
}

m_a_refused_write_leaves_the_records_in_memory() {
  py <<'PY'
p = "src/durable-store.ts"
s = open(p).read()
s = s.replace("""    if (persisted === null) {
      cache = null;
      return;
    }""",
              """    if (persisted === null) {
      return;
    }""")
open(p, "w").write(s)
PY
}

m_the_registry_is_always_readable() {
  py <<'PY'
p = "src/agents.ts"
s = open(p).read()
s = s.replace("  return agentStore.status().hydrated;",
              "  return true;")
open(p, "w").write(s)
PY
}

m_an_unrecognised_key_is_reported_as_no_key() {
  py <<'PY'
p = "src/referral-attribution.ts"
s = open(p).read()
s = s.replace("""  if (!agent) return outcome("key_not_recognised");
  return recordAttribution(agent, referral);""",
              """  if (!agent) return outcome("no_key");
  return recordAttribution(agent, referral);""")
open(p, "w").write(s)
PY
}

m_an_unstored_attribution_is_reported_as_recorded() {
  py <<'PY'
p = "src/referral-attribution.ts"
s = open(p).read()
s = s.replace("""  const persisted = await persistDurableStores();
  return outcome(persisted.ok ? "attributed" : "not_recorded");""",
              """  await persistDurableStores();
  return outcome("attributed");""")
open(p, "w").write(s)
PY
}

m_an_empty_bearer_counts_as_a_credential() {
  py <<'PY'
p = "src/referral-attribution.ts"
s = open(p).read()
s = s.replace("""  if (typeof authHeader === "string" && authHeader.startsWith("Bearer ") && authHeader.slice(7).trim()) {
    return true;
  }""",
              """  if (typeof authHeader === "string" && authHeader.startsWith("Bearer ")) {
    return true;
  }""")
open(p, "w").write(s)
PY
}

m_a_missing_credential_is_reported_as_unrecognised() {
  py <<'PY'
p = "src/referral-attribution.ts"
s = open(p).read()
s = s.replace("""  if (!hasAuthCredential(headers)) return outcome("no_key");
  if (!agentRegistryReadable()) return outcome("registry_unavailable");
  return outcome("key_not_recognised");""",
              """  if (!agentRegistryReadable()) return outcome("registry_unavailable");
  return outcome("key_not_recognised");""")
open(p, "w").write(s)
PY
}

m_payouts_are_always_available() {
  py <<'PY'
p = "src/x402.ts"
s = open(p).read()
s = s.replace("  return transferFn !== defaultTransferFn;",
              "  return true;")
open(p, "w").write(s)
PY
}

m_payouts_are_never_available() {
  py <<'PY'
p = "src/x402.ts"
s = open(p).read()
s = s.replace("  return transferFn !== defaultTransferFn;",
              "  return false;")
open(p, "w").write(s)
PY
}

m_registration_answers_before_the_write_is_durable() {
  py <<'PY'
p = "src/serve.ts"
s = open(p).read()
s = s.replace("""      if (!(await identityWritePersisted(res))) return;
      res.writeHead(201, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*", ...registrationHeaders });""",
              """      res.writeHead(201, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*", ...registrationHeaders });""")
open(p, "w").write(s)
PY
}

m_the_stats_endpoint_stops_reporting_storage() {
  py <<'PY'
p = "src/serve.ts"
s = open(p).read()
s = s.replace("    res.end(JSON.stringify({ ...getConnectionStats(sessions.size), identity_storage: identityStorageReport() }));",
              "    res.end(JSON.stringify(getConnectionStats(sessions.size)));")
open(p, "w").write(s)
PY
}

m_the_payout_endpoint_drops_its_capability_check() {
  py <<'PY'
p = "src/serve.ts"
s = open(p).read()
s = s.replace("""    if (!payoutsAvailable()) {
      res.writeHead(501, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      res.end(JSON.stringify({ error: PAYOUTS_UNAVAILABLE_REASON, payouts_available: false }));
      return;
    }

""", "")
open(p, "w").write(s)
PY
}

run_mutation "an unread store is written anyway" m_an_unread_store_is_written_anyway
run_mutation "a failed write is reported as success" m_a_failed_write_is_reported_as_success
run_mutation "a failed write keeps the unstored records" m_a_failed_write_keeps_the_unstored_records
run_mutation "a failed read counts as an empty store" m_a_failed_read_counts_as_an_empty_store
run_mutation "the file is written even with a backend" m_the_file_is_written_even_with_a_backend
run_mutation "a save is never marked for writing" m_a_save_is_never_marked_for_writing
run_mutation "every flush spends a write" m_every_flush_spends_a_write
run_mutation "durability is claimed without reading the backend" m_durability_is_claimed_without_reading_the_backend
run_mutation "a stored value is ignored in favour of the file" m_a_stored_value_is_ignored_in_favour_of_the_file
run_mutation "a store reports itself hydrated regardless" m_a_store_reports_itself_hydrated_regardless
run_mutation "a seeded store is never written back" m_a_seeded_store_is_never_written_back
run_mutation "a recovered read reports the dropped change as saved" m_a_recovered_read_reports_the_dropped_change_as_saved
run_mutation "a refused write leaves the records in memory" m_a_refused_write_leaves_the_records_in_memory
run_mutation "the registry is always readable" m_the_registry_is_always_readable
run_mutation "an unrecognised key is reported as no key" m_an_unrecognised_key_is_reported_as_no_key
run_mutation "an unstored attribution is reported as recorded" m_an_unstored_attribution_is_reported_as_recorded
run_mutation "an empty bearer counts as a credential" m_an_empty_bearer_counts_as_a_credential
run_mutation "a missing credential is reported as unrecognised" m_a_missing_credential_is_reported_as_unrecognised
run_mutation "payouts are always available" m_payouts_are_always_available
run_mutation "payouts are never available" m_payouts_are_never_available
run_mutation "registration answers before the write is durable" m_registration_answers_before_the_write_is_durable
run_mutation "the stats endpoint stops reporting storage" m_the_stats_endpoint_stops_reporting_storage
run_mutation "the payout endpoint drops its capability check" m_the_payout_endpoint_drops_its_capability_check

restore
npm run build > /dev/null 2>&1
echo
echo "killed: $killed  survived: $survived"
[ "$survived" -eq 0 ]
