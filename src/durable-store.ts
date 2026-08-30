import fs from "node:fs";

export interface DurableBackend {
  get(key: string): Promise<{ ok: boolean; value: unknown; error?: string }>;
  set(key: string, value: unknown): Promise<{ ok: boolean; error?: string }>;
}

export type DurableStoreMode = "file" | "durable";

export interface DurableStoreStatus {
  name: string;
  mode: DurableStoreMode;
  hydrated: boolean;
  seeded_from_file: boolean;
  unflushed_writes: boolean;
  last_write_at: string | null;
  last_write_error: string | null;
  last_read_error: string | null;
}

export interface WriteOutcome {
  ok: boolean;
  error?: string;
}

export interface DurableStore<T> {
  read(): T[];
  save(next: T[]): void;
  hydrate(): Promise<void>;
  flush(): Promise<WriteOutcome>;
  reset(): void;
  status(): DurableStoreStatus;
}

export const DURABLE_KEY_PREFIX = "agentdeals:store:";

let backend: DurableBackend | null = null;
const registry: DurableStore<unknown>[] = [];

export function configureDurableBackend(next: DurableBackend | null): void {
  backend = next;
  for (const store of registry) store.reset();
}

export function durableBackendConfigured(): boolean {
  return backend !== null;
}

export function createDurableStore<T>(opts: {
  name: string;
  property: string;
  filePath: () => string;
}): DurableStore<T> {
  const redisKey = `${DURABLE_KEY_PREFIX}${opts.name}`;

  let cache: T[] | null = null;
  let persisted: string | null = null;
  let unflushed = false;
  let hydratedFromBackend = false;
  let seededFromFile = false;
  let lastWriteAt: string | null = null;
  let lastWriteError: string | null = null;
  let lastReadError: string | null = null;
  let flushChain: Promise<WriteOutcome> = Promise.resolve({ ok: true });

  function listOf(container: unknown): T[] | null {
    if (!container || typeof container !== "object") return null;
    const list = (container as Record<string, unknown>)[opts.property];
    return Array.isArray(list) ? (list as T[]) : null;
  }

  function serialize(value: T[]): string {
    return JSON.stringify({ [opts.property]: value }, null, 2);
  }

  function readFile(): T[] {
    const filePath = opts.filePath();
    if (!fs.existsSync(filePath)) return [];
    try {
      return listOf(JSON.parse(fs.readFileSync(filePath, "utf-8"))) ?? [];
    } catch {
      return [];
    }
  }

  function restoreLastPersisted(): void {
    unflushed = false;
    if (persisted === null) {
      cache = null;
      return;
    }
    try {
      cache = listOf(JSON.parse(persisted)) ?? [];
    } catch {
      cache = [];
    }
  }

  function writeFile(next: T[]): void {
    const body = serialize(next);
    try {
      fs.writeFileSync(opts.filePath(), body, "utf-8");
      persisted = body;
      lastWriteAt = new Date().toISOString();
      lastWriteError = null;
    } catch (err) {
      lastWriteError = err instanceof Error ? err.message : String(err);
      restoreLastPersisted();
    }
  }

  function read(): T[] {
    if (cache) return cache;
    cache = readFile();
    if (!backend) persisted = serialize(cache);
    return cache;
  }

  function save(next: T[]): void {
    cache = next;
    if (!backend) {
      writeFile(next);
      return;
    }
    unflushed = true;
  }

  async function runFlush(): Promise<WriteOutcome> {
    if (!backend || !unflushed) return { ok: true };
    if (!hydratedFromBackend) {
      await hydrate();
      lastWriteError = hydratedFromBackend
        ? `${opts.name} had to be read from durable storage first, so this change was not applied`
        : `${opts.name} was not read from durable storage, so writing would discard what is stored`;
      restoreLastPersisted();
      return { ok: false, error: lastWriteError };
    }
    const next = cache ?? [];
    const body = serialize(next);
    unflushed = false;
    const res = await backend.set(redisKey, { [opts.property]: next });
    if (!res.ok) {
      lastWriteError = res.error ?? "durable write failed";
      restoreLastPersisted();
      return { ok: false, error: lastWriteError };
    }
    persisted = body;
    lastWriteAt = new Date().toISOString();
    lastWriteError = null;
    return { ok: true };
  }

  function flush(): Promise<WriteOutcome> {
    const run = () => runFlush();
    flushChain = flushChain.then(run, run);
    return flushChain;
  }

  async function hydrate(): Promise<void> {
    if (!backend) {
      read();
      return;
    }
    const res = await backend.get(redisKey);
    if (!res.ok) {
      lastReadError = res.error ?? "durable read failed";
      hydratedFromBackend = false;
      return;
    }
    lastReadError = null;
    hydratedFromBackend = true;
    const stored = listOf(res.value);
    if (stored) {
      cache = stored;
      persisted = serialize(stored);
      seededFromFile = false;
      unflushed = false;
      return;
    }
    const seed = readFile();
    cache = seed;
    persisted = null;
    seededFromFile = true;
    unflushed = seed.length > 0;
  }

  function reset(): void {
    cache = null;
    persisted = null;
    unflushed = false;
    hydratedFromBackend = false;
    seededFromFile = false;
    lastWriteAt = null;
    lastWriteError = null;
    lastReadError = null;
    flushChain = Promise.resolve({ ok: true });
  }

  function status(): DurableStoreStatus {
    return {
      name: opts.name,
      mode: backend ? "durable" : "file",
      hydrated: backend ? hydratedFromBackend : cache !== null,
      seeded_from_file: seededFromFile,
      unflushed_writes: unflushed,
      last_write_at: lastWriteAt,
      last_write_error: lastWriteError,
      last_read_error: lastReadError,
    };
  }

  const store: DurableStore<T> = { read, save, hydrate, flush, reset, status };
  registry.push(store as DurableStore<unknown>);
  return store;
}

export async function hydrateDurableStores(): Promise<void> {
  for (const store of registry) await store.hydrate();
}

export async function persistDurableStores(): Promise<WriteOutcome> {
  let failure: WriteOutcome | null = null;
  for (const store of registry) {
    const res = await store.flush();
    if (!res.ok && !failure) failure = res;
  }
  return failure ?? { ok: true };
}

export function durableStoreStatuses(): DurableStoreStatus[] {
  return registry.map(store => store.status());
}

export interface IdentityStorageReport {
  durable: boolean;
  backend: "redis" | "container_filesystem";
  survives_deploy: boolean;
  stores: DurableStoreStatus[];
}

export function identityStorageReport(): IdentityStorageReport {
  const stores = durableStoreStatuses();
  const durable = backend !== null && stores.every(s => s.hydrated);
  return {
    durable,
    backend: backend ? "redis" : "container_filesystem",
    survives_deploy: durable,
    stores,
  };
}
