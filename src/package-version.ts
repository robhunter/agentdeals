import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const manifestPath = join(dirname(fileURLToPath(import.meta.url)), "..", "package.json");

export const PACKAGE_MANIFEST: { version: string; license: string; repository: { url: string } } =
  JSON.parse(readFileSync(manifestPath, "utf-8"));

export const PKG_VERSION = PACKAGE_MANIFEST.version;

export const REPOSITORY_URL = PACKAGE_MANIFEST.repository.url.replace(/^git\+/, "").replace(/\.git$/, "");
