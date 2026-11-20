import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { guardShutdownLedger } from "../scripts/shutdown-ledger-guard.js";

describe("shutdown ledger guard", () => {
  it("requires a direct redirect to a currently listed page before forgetting an old page", async () => {
    const server = createServer((req, res) => {
      if (req.url === "/shutdowns/old") res.writeHead(301, { Location: "/shutdowns/current" });
      else if (req.url === "/shutdowns/chain") res.writeHead(301, { Location: "/shutdowns/old" });
      else if (req.url === "/shutdowns/temporary") res.writeHead(302, { Location: "/shutdowns/current" });
      else res.writeHead(404);
      res.end();
    }).listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const base = `http://127.0.0.1:${address.port}`;
    try {
      await guardShutdownLedger(["/shutdowns/old", "/shutdowns/current", "/other"], ["/shutdowns/current"], base);
      for (const path of ["/shutdowns/missing", "/shutdowns/chain", "/shutdowns/temporary"]) {
        await assert.rejects(guardShutdownLedger([path], ["/shutdowns/current"], base), /needs a direct redirect/);
      }
    } finally {
      server.close();
      await once(server, "close");
    }
  });
});
