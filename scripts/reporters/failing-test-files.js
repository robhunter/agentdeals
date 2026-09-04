import { relative } from "node:path";

export default async function* failingTestFiles(source) {
  const files = new Set();
  for await (const event of source) {
    if (event.type !== "test:fail") continue;
    const file = event.data?.file;
    if (typeof file === "string" && file.length > 0) files.add(relative(process.cwd(), file));
  }
  yield [...files].sort().map(f => `${f}\n`).join("");
}
