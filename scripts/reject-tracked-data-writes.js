import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { constants } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const manifest = process.env.AGENTDEALS_DATA_GUARD_MANIFEST;
if (manifest) {
  const tracked = JSON.parse(fs.readFileSync(manifest, "utf8"));
  const append = fs.appendFileSync;
  const realpath = fs.realpathSync;
  const test = process.env.NODE_TEST_CONTEXT
    ? process.argv.find(argument => /\.test\.[cm]?[jt]s$/.test(argument))
    : null;
  if (test) process.env.AGENTDEALS_DATA_GUARD_TEST = resolve(test);
  const owner = process.env.AGENTDEALS_DATA_GUARD_TEST || process.argv[1] || "unknown test";

  function canonical(value) {
    const path = resolve(value instanceof URL ? fileURLToPath(value) : Buffer.isBuffer(value) ? value.toString() : value);
    try { return realpath(path); } catch { return path; }
  }

  const paths = tracked.map(file => ({ file, aliases: [...new Set([file, canonical(file)])] }));
  function reject(value, method, recursive = false) {
    if (typeof value !== "string" && !Buffer.isBuffer(value) && !(value instanceof URL)) return;
    const path = canonical(value);
    const match = paths.find(({ aliases }) => aliases.some(file => file === path || (recursive && file.startsWith(path + sep))));
    if (!match) return;
    const file = relative(process.cwd(), match.file);
    const record = { file: isAbsolute(file) ? match.file : file, test: owner, method };
    append(join(process.env.AGENTDEALS_DATA_GUARD_LOG, `${process.pid}.jsonl`), JSON.stringify(record) + "\n");
    throw new Error(`Tests attempted tracked data write: ${record.file} (${method}, ${owner})`);
  }

  function writable(flags = "r") {
    return typeof flags === "number"
      ? Boolean(flags & (constants.O_WRONLY | constants.O_RDWR | constants.O_APPEND | constants.O_CREAT | constants.O_TRUNC))
      : /[wa+]/.test(flags);
  }

  const methods = ["writeFile", "appendFile", "unlink", "truncate", "rm", "rmdir", "rename", "copyFile", "cp", "link", "symlink", "chmod", "chown", "utimes"];
  for (const api of [fs, fs.promises]) {
    for (const base of methods) {
      for (const method of api === fs ? [base, `${base}Sync`] : [base]) {
        if (typeof api[method] !== "function") continue;
        const native = api[method];
        api[method] = function (...args) {
          if (["copyFile", "cp", "symlink"].includes(base)) reject(args[1], method, base === "cp");
          else if (["rename", "link"].includes(base)) {
            reject(args[0], method, true);
            reject(args[1], method, true);
          } else reject(args[0], method, ["rm", "rmdir"].includes(base));
          return native.apply(this, args);
        };
      }
    }
    for (const method of api === fs ? ["open", "openSync"] : ["open"]) {
      const native = api[method];
      api[method] = function (...args) {
        if (writable(args[1])) reject(args[0], method);
        return native.apply(this, args);
      };
    }
  }
  const stream = fs.createWriteStream;
  fs.createWriteStream = function (path, options) {
    reject(path, "createWriteStream");
    return stream.call(this, path, options);
  };
  syncBuiltinESMExports();
}
