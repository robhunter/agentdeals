#!/usr/bin/env node

import { spawn } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { delimiter, join } from "node:path";

export const READ_BY_RENDERING = "rendered";
export const RENDERER_PATH_ENV = "AGENTDEALS_RENDERER";
export const RENDERER_ARGS_ENV = "AGENTDEALS_RENDERER_ARGS";
export const RENDER_TIMEOUT_MS = 45_000;
export const VIRTUAL_TIME_BUDGET_MS = 20_000;
export const MAX_RENDERED_BYTES = 16_000_000;

export const NO_RENDERING_CLIENT = "no rendering client is installed";
export const RENDER_TIMED_OUT = "the rendering client did not finish in time";
export const RENDERED_ITS_OWN_ERROR_PAGE =
  "the rendering client could not reach the site and showed its own error page";

const ERROR_PAGE_BODY_CLASSES = new Set([
  "neterror",
  "ssl",
  "captiveportal",
  "main-frame-blocked",
  "insecure-form",
  "lookalike-url",
  "https-only",
  "enterprise-block",
  "supervised-user-block",
  "safe-browsing",
]);

export const RENDERED_THE_CHALLENGE_AGAIN =
  "the rendering client was served the site's bot challenge instead of the page";

const CHALLENGE_PAGE_TITLES = [
  "just a moment",
  "attention required",
  "security checkpoint",
  "checking your browser",
  "verifying you are human",
  "are you a robot",
  "access denied",
];

export function documentTitle(html) {
  const found = String(html ?? "").match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1];
  return found ? found.replace(/\s+/g, " ").trim() : "";
}

export function theSitesBotChallenge(html) {
  const title = documentTitle(html).toLowerCase();
  return title.length > 0 && CHALLENGE_PAGE_TITLES.some((phrase) => title.includes(phrase));
}

export function theRenderingClientsOwnErrorPage(html) {
  const text = String(html ?? "");
  const body = text.match(/<body\b[^>]*>/i)?.[0];
  if (!body) return false;
  const classes = body.match(/\bclass\s*=\s*["']([^"']*)["']/i)?.[1]?.split(/\s+/) ?? [];
  if (!classes.some((name) => ERROR_PAGE_BODY_CLASSES.has(name))) return false;
  return /\bid\s*=\s*["']main-message["']/i.test(text);
}

export const RENDER_USER_AGENT =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const ENV_VARS_HOLDING_A_PATH = [
  RENDERER_PATH_ENV,
  "CHROME_PATH",
  "CHROME_BIN",
  "PUPPETEER_EXECUTABLE_PATH",
];

const EXECUTABLE_NAMES = [
  "google-chrome-stable",
  "google-chrome",
  "chromium-browser",
  "chromium",
  "headless_shell",
];

function isExecutable(path) {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function rendererCandidates(env = process.env) {
  const named = ENV_VARS_HOLDING_A_PATH.map((name) => env[name]).filter(Boolean);
  const directories = String(env.PATH ?? "").split(delimiter).filter(Boolean);
  const onPath = directories.flatMap((directory) =>
    EXECUTABLE_NAMES.map((name) => join(directory, name))
  );
  return [...named, ...onPath];
}

export function findRenderer(env = process.env) {
  return rendererCandidates(env).find(isExecutable) ?? null;
}

export function environmentArguments(env = process.env) {
  return String(env[RENDERER_ARGS_ENV] ?? "").split(/\s+/).filter(Boolean);
}

export function renderArguments(url, options = {}) {
  return [
    "--headless",
    "--disable-gpu",
    "--no-sandbox",
    "--disable-dev-shm-usage",
    "--disable-background-networking",
    "--disable-extensions",
    "--no-first-run",
    "--no-default-browser-check",
    `--user-agent=${options.userAgent ?? RENDER_USER_AGENT}`,
    ...environmentArguments(options.env),
    `--virtual-time-budget=${options.virtualTimeBudgetMs ?? VIRTUAL_TIME_BUDGET_MS}`,
    "--dump-dom",
    url,
  ];
}

export function dumpDom(binary, args, limits = {}) {
  const timeoutMs = limits.timeoutMs ?? RENDER_TIMEOUT_MS;
  const maxBytes = limits.maxBytes ?? MAX_RENDERED_BYTES;
  return new Promise((settle) => {
    let child;
    try {
      child = spawn(binary, args, { stdio: ["ignore", "pipe", "ignore"] });
    } catch (err) {
      settle({ ok: false, error: err.message });
      return;
    }
    const chunks = [];
    let bytes = 0;
    let done = false;
    const finish = (result) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      settle(result);
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish({ ok: false, error: RENDER_TIMED_OUT });
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      bytes += chunk.length;
      if (bytes > maxBytes) {
        child.kill("SIGKILL");
        finish({ ok: false, error: `rendered page over ${maxBytes} bytes` });
        return;
      }
      chunks.push(chunk);
    });
    child.on("error", (err) => finish({ ok: false, error: err.message }));
    child.on("close", (code) => {
      if (code !== 0) return finish({ ok: false, error: `the rendering client exited ${code}` });
      finish({ ok: true, html: Buffer.concat(chunks).toString("utf-8") });
    });
  });
}

export async function withoutARenderingClient() {
  return { ok: false, error: NO_RENDERING_CLIENT };
}

let oneAtATime = Promise.resolve();

export function renderPageHtml(url, options = {}) {
  const queued = oneAtATime.then(async () => {
    const binary = options.renderer ?? findRenderer(options.env);
    if (!binary) return { ok: false, error: NO_RENDERING_CLIENT };
    const dumped = await (options.dump ?? dumpDom)(binary, renderArguments(url, options), {
      timeoutMs: options.timeoutMs,
      maxBytes: options.maxBytes,
    });
    if (dumped.ok && theRenderingClientsOwnErrorPage(dumped.html)) {
      return { ok: false, error: RENDERED_ITS_OWN_ERROR_PAGE };
    }
    if (dumped.ok && theSitesBotChallenge(dumped.html)) {
      return { ok: false, error: RENDERED_THE_CHALLENGE_AGAIN };
    }
    return dumped;
  });
  oneAtATime = queued.then(
    () => undefined,
    () => undefined
  );
  return queued;
}
