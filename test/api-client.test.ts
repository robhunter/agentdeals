import { describe, it } from "node:test";
import assert from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverPath = path.join(__dirname, "..", "dist", "serve.js");

// Start local HTTP server and wait for it to be ready
async function startHttpServer(port: number): Promise<ChildProcess> {
  const proc = spawn("node", [serverPath], {
    env: { ...process.env, PORT: String(port) },
    stdio: ["pipe", "pipe", "pipe"],
  });

  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Server start timeout")), 5000);
    proc.stderr!.on("data", (chunk: Buffer) => {
      if (chunk.toString().includes("running on")) {
        clearTimeout(timeout);
        resolve();
      }
    });
    proc.on("error", (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });

  return proc;
}

describe("api-client against local HTTP server", () => {
  const PORT = 13579;

  it("fetchCategories returns array of categories", async () => {
    const proc = await startHttpServer(PORT);
    try {
      const { fetchCategories } = await import("../dist/api-client.js");
      process.env.AGENTDEALS_API_URL = `http://localhost:${PORT}`;
      try {
        const categories = await fetchCategories() as { name: string; count: number }[];
        assert.ok(Array.isArray(categories));
        assert.ok(categories.length > 0);
        assert.ok(typeof categories[0].name === "string");
        assert.ok(typeof categories[0].count === "number");
      } finally {
        delete process.env.AGENTDEALS_API_URL;
      }
    } finally {
      proc.kill();
    }
  });

  it("fetchOffers returns offers with pagination", async () => {
    const proc = await startHttpServer(PORT);
    try {
      const { fetchOffers } = await import("../dist/api-client.js");
      process.env.AGENTDEALS_API_URL = `http://localhost:${PORT}`;
      try {
        const data = await fetchOffers({ q: "database", limit: 5 }) as { offers: unknown[]; total: number };
        assert.ok(Array.isArray(data.offers));
        assert.ok(data.offers.length <= 5);
        assert.ok(typeof data.total === "number");
      } finally {
        delete process.env.AGENTDEALS_API_URL;
      }
    } finally {
      proc.kill();
    }
  });

  it("fetchOfferDetails returns offer object", async () => {
    const proc = await startHttpServer(PORT);
    try {
      const { fetchOfferDetails } = await import("../dist/api-client.js");
      process.env.AGENTDEALS_API_URL = `http://localhost:${PORT}`;
      try {
        const data = await fetchOfferDetails("Neon") as { offer: { vendor: string } };
        assert.ok(data.offer);
        assert.strictEqual(data.offer.vendor, "Neon");
      } finally {
        delete process.env.AGENTDEALS_API_URL;
      }
    } finally {
      proc.kill();
    }
  });

  it("fetchOfferDetails throws on unknown vendor", async () => {
    const proc = await startHttpServer(PORT);
    try {
      const { fetchOfferDetails } = await import("../dist/api-client.js");
      process.env.AGENTDEALS_API_URL = `http://localhost:${PORT}`;
      try {
        await assert.rejects(
          () => fetchOfferDetails("zzzznonexistent99999"),
          (err: Error) => {
            assert.ok(err.message.includes("404"));
            return true;
          }
        );
      } finally {
        delete process.env.AGENTDEALS_API_URL;
      }
    } finally {
      proc.kill();
    }
  });

  it("fetchCompare returns comparison for two known vendors", async () => {
    const proc = await startHttpServer(PORT);
    try {
      const { fetchCompare } = await import("../dist/api-client.js");
      process.env.AGENTDEALS_API_URL = `http://localhost:${PORT}`;
      try {
        const data = await fetchCompare("Neon", "Supabase") as { vendor_a: { vendor: string }; vendor_b: { vendor: string } };
        assert.ok(data.vendor_a);
        assert.ok(data.vendor_b);
      } finally {
        delete process.env.AGENTDEALS_API_URL;
      }
    } finally {
      proc.kill();
    }
  });

  it("handles unreachable API with descriptive error", async () => {
    const { fetchCategories } = await import("../dist/api-client.js");
    process.env.AGENTDEALS_API_URL = "http://localhost:19999";
    try {
      await assert.rejects(
        () => fetchCategories(),
        (err: Error) => {
          assert.ok(err.message.includes("unreachable") || err.message.includes("ECONNREFUSED"));
          return true;
        }
      );
    } finally {
      delete process.env.AGENTDEALS_API_URL;
    }
  });
});
