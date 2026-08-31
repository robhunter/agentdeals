import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let server: ChildProcess;
let base = "";

function startServer(): Promise<ChildProcess> {
  return new Promise((resolve, reject) => {
    const serverPath = path.join(__dirname, "..", "dist", "serve.js");
    const proc = spawn("node", [serverPath], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, PORT: "0", BASE_URL: "http://localhost" },
    });
    const timeout = setTimeout(() => {
      proc.kill();
      reject(new Error("Server startup timeout"));
    }, 15000);
    proc.stderr!.on("data", (data: Buffer) => {
      const match = data.toString().match(/running on http:\/\/localhost:(\d+)/);
      if (match) {
        base = `http://localhost:${match[1]}`;
        clearTimeout(timeout);
        resolve(proc);
      }
    });
    proc.on("error", (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });
}

type Region = { start: number; end: number; tag: string };

function regions(html: string, openPattern: string, closeTag: string): Region[] {
  const found: Region[] = [];
  const re = new RegExp(openPattern, "g");
  let match: RegExpExecArray | null;
  while ((match = re.exec(html)) !== null) {
    const start = match.index + match[0].length;
    const end = html.indexOf(closeTag, start);
    if (end === -1) break;
    found.push({ start, end, tag: match[0] });
    re.lastIndex = end;
  }
  return found;
}

function commentsIn(source: string, isJavaScript: boolean): string[] {
  const found: string[] = [];
  const stack: string[] = [isJavaScript ? "code" : "css"];
  let i = 0;
  let prev = "";
  while (i < source.length) {
    const state = stack[stack.length - 1];
    const c = source[i];
    const n = source[i + 1];

    if (state === "template") {
      if (c === "\\") { i += 2; continue; }
      if (c === "`") { stack.pop(); i++; prev = "`"; continue; }
      if (c === "$" && n === "{") { stack.push("code"); i += 2; prev = "{"; continue; }
      i++;
      continue;
    }

    if (c === '"' || c === "'") {
      const quote = c;
      i++;
      while (i < source.length) {
        if (source[i] === "\\") { i += 2; continue; }
        if (source[i] === quote) { i++; break; }
        i++;
      }
      prev = "s";
      continue;
    }
    if (state === "code" && c === "`") { stack.push("template"); i++; continue; }
    if (state === "code" && c === "}" && stack.length > 1) { stack.pop(); i++; prev = "}"; continue; }
    if (state === "code" && c === "/" && n === "/") {
      let end = source.indexOf("\n", i);
      if (end === -1) end = source.length;
      found.push(source.slice(i, end).trim());
      i = end;
      continue;
    }
    if (c === "/" && n === "*") {
      let end = source.indexOf("*/", i + 2);
      end = end === -1 ? source.length : end + 2;
      found.push(source.slice(i, end).trim());
      i = end;
      continue;
    }
    if (state === "code" && c === "/" && !/[\w$)\]]$/.test(prev)) {
      let j = i + 1;
      let inClass = false;
      let closed = false;
      while (j < source.length) {
        const d = source[j];
        if (d === "\\") { j += 2; continue; }
        if (d === "[") inClass = true;
        else if (d === "]") inClass = false;
        else if (d === "/" && !inClass) { closed = true; break; }
        else if (d === "\n") break;
        j++;
      }
      if (closed) { i = j + 1; prev = "r"; continue; }
    }
    if (!/\s/.test(c)) prev = c;
    i++;
  }
  return found;
}

function commentsInServedHtml(html: string): string[] {
  const found: string[] = [];
  for (const r of regions(html, "<style[^>]*>", "</style>")) {
    found.push(...commentsIn(html.slice(r.start, r.end), false));
  }
  for (const r of regions(html, "<script[^>]*>", "</script>")) {
    found.push(...commentsIn(html.slice(r.start, r.end), true));
  }
  return found;
}

async function locs(sitemap: string): Promise<string[]> {
  const body = await (await fetch(`${base}${sitemap}`)).text();
  return [...body.matchAll(/<loc>([^<]+)<\/loc>/g)].map(
    (m) => m[1].replace(/^https?:\/\/[^/]+/, "") || "/",
  );
}

async function sampledRoutes(): Promise<string[]> {
  const routes = new Set<string>(["/"]);
  for (const p of await locs("/sitemap-misc.xml")) routes.add(p);
  for (const p of await locs("/sitemap-reports.xml")) routes.add(p);
  for (const p of (await locs("/sitemap-pages.xml")).slice(0, 80)) routes.add(p);
  for (const p of (await locs("/sitemap-vendors.xml")).slice(0, 5)) routes.add(p);
  for (const p of (await locs("/sitemap-comparisons.xml")).slice(0, 5)) routes.add(p);
  return [...routes].filter((p) => !p.endsWith(".xml"));
}

describe("served html", () => {
  before(async () => {
    server = await startServer();
  });
  after(() => {
    server?.kill();
  });

  it("carries no comments in its style or script blocks", async () => {
    const routes = await sampledRoutes();
    assert.ok(routes.length > 100, `expected a broad sample, got ${routes.length}`);

    const offenders: string[] = [];
    for (const route of routes) {
      const response = await fetch(`${base}${route}`);
      if (!response.ok) continue;
      const found = commentsInServedHtml(await response.text());
      for (const c of found.slice(0, 3)) offenders.push(`${route}: ${c.slice(0, 80)}`);
    }

    assert.deepStrictEqual(offenders, []);
  });

  it("keeps comment-shaped text that is page content rather than markup", async () => {
    const html = await (await fetch(`${base}/`)).text();
    assert.ok(html.includes("// Local (recommended)"));
    assert.deepStrictEqual(commentsInServedHtml(html), []);
  });
});

function mcpRequest(proc: ChildProcess, request: object): Promise<any> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("MCP request timeout")), 15000);
    let buffer = "";
    const onData = (data: Buffer) => {
      buffer += data.toString();
      for (const line of buffer.split("\n")) {
        if (!line.trim()) continue;
        try {
          const parsed = JSON.parse(line.trim());
          clearTimeout(timeout);
          proc.stdout!.off("data", onData);
          resolve(parsed);
          return;
        } catch {
          continue;
        }
      }
    };
    proc.stdout!.on("data", onData);
    proc.stdin!.write(JSON.stringify(request) + "\n");
  });
}

describe("mcp app resources", () => {
  it("carry no comments in their style or script blocks", async () => {
    const serverPath = path.join(__dirname, "..", "dist", "index.js");
    const proc = spawn("node", [serverPath], { stdio: ["pipe", "pipe", "pipe"] });
    try {
      await mcpRequest(proc, {
        jsonrpc: "2.0", id: 1, method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "test", version: "0.0.1" },
        },
      });
      proc.stdin!.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");

      const listed = await mcpRequest(proc, {
        jsonrpc: "2.0", id: 2, method: "resources/list", params: {},
      });
      const uris = (listed.result.resources as { uri: string }[])
        .map((r) => r.uri)
        .filter((uri) => uri.startsWith("ui://"));
      assert.ok(uris.length >= 4, `expected ui:// resources, got ${uris.length}`);

      const offenders: string[] = [];
      let id = 3;
      for (const uri of uris) {
        const read = await mcpRequest(proc, {
          jsonrpc: "2.0", id: id++, method: "resources/read", params: { uri },
        });
        for (const content of read.result.contents as { text?: string }[]) {
          for (const c of commentsInServedHtml(content.text ?? "").slice(0, 3)) {
            offenders.push(`${uri}: ${c.slice(0, 80)}`);
          }
        }
      }
      assert.deepStrictEqual(offenders, []);
    } finally {
      proc.kill();
    }
  });
});
