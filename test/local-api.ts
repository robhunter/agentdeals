import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

export interface LocalApi {
  url: string;
  stop(): void;
}

export function startLocalApi(): Promise<LocalApi> {
  return new Promise((resolve, reject) => {
    const child = spawn("node", [path.join(REPO, "dist", "serve.js")], {
      stdio: ["ignore", "ignore", "pipe"],
      env: { ...process.env, PORT: "0", BASE_URL: "http://localhost" },
    });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("the local API server did not start within 60 seconds"));
    }, 60000);
    let printed = "";
    let started = false;
    child.stderr!.on("data", (chunk: Buffer) => {
      if (started) return;
      printed += chunk.toString();
      const port = printed.match(/running on http:\/\/localhost:(\d+)/)?.[1];
      if (!port) return;
      started = true;
      clearTimeout(timer);
      resolve({ url: `http://localhost:${port}`, stop: () => { child.kill(); } });
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

export function startStdioServerAgainst(api: Pick<LocalApi, "url">): ChildProcess {
  return spawn("node", [path.join(REPO, "dist", "index.js")], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, AGENTDEALS_API_URL: api.url },
  });
}
