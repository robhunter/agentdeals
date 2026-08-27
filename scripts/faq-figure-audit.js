import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { statesVendorFigure } from "../dist/faq-provenance.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(__dirname, "..");

const PROVENANCE = /Figures compiled \d{4}-\d{2}-\d{2}, (?:not re-checked since|last checked \d{4}-\d{2}-\d{2})/;

function startServer(env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn("node", [path.join(REPO, "dist", "serve.js")], {
      cwd: REPO,
      stdio: ["ignore", "ignore", "pipe"],
      env: { ...process.env, PORT: "0", BASE_URL: "http://localhost:3000", ...env },
    });
    const timeout = setTimeout(() => { child.kill(); reject(new Error("timeout")); }, 60000);
    child.stderr.on("data", (d) => {
      const m = d.toString().match(/running on http:\/\/localhost:(\d+)/);
      if (m) { clearTimeout(timeout); resolve({ proc: child, port: parseInt(m[1], 10) }); }
    });
    child.on("error", (e) => { clearTimeout(timeout); reject(e); });
  });
}

export function faqAnswers(html) {
  const out = [];
  const re = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    let parsed;
    try { parsed = JSON.parse(m[1]); } catch { continue; }
    for (const block of Array.isArray(parsed) ? parsed : [parsed]) {
      if (!block || block["@type"] !== "FAQPage" || !Array.isArray(block.mainEntity)) continue;
      for (const q of block.mainEntity) {
        const text = q?.acceptedAnswer?.text;
        if (typeof text === "string") out.push({ question: q.name, answer: text });
      }
    }
  }
  return out;
}

export function hasProvenance(text) {
  return PROVENANCE.test(text);
}

export async function auditRegisterFaqs(env = {}) {
  const reviews = JSON.parse(readFileSync(path.join(REPO, "data", "page-reviews.json"), "utf-8"));
  const paths = reviews.pages.map((p) => p.path);
  const { proc, port } = await startServer(env);
  const pages = [];
  try {
    for (const p of paths) {
      const res = await fetch(`http://localhost:${port}${p}`);
      const items = faqAnswers(await res.text());
      if (items.length > 0) pages.push({ path: p, items });
    }
  } finally {
    proc.kill();
  }
  return { register_pages: paths.length, pages };
}

async function main() {
  const { register_pages, pages } = await auditRegisterFaqs();
  let answers = 0, figures = 0, covered = 0, digitsUncovered = 0;
  const perPage = [];
  const uncovered = [];
  for (const { path: p, items } of pages) {
    answers += items.length;
    const fig = items.filter((i) => statesVendorFigure(i.answer));
    const cov = fig.filter((i) => hasProvenance(i.answer));
    figures += fig.length;
    covered += cov.length;
    for (const i of items) {
      if (!statesVendorFigure(i.answer) && /\d/.test(i.answer)) {
        digitsUncovered += 1;
        uncovered.push({ path: p, question: i.question });
      }
    }
    perPage.push({ path: p, answers: items.length, figures: fig.length, covered: cov.length });
    for (const i of fig) if (!hasProvenance(i.answer)) console.error(`UNCOVERED ${p} :: ${i.question}`);
  }
  perPage.sort((a, b) => b.figures - a.figures || a.path.localeCompare(b.path));
  console.log(JSON.stringify({
    register_pages,
    pages_with_faq: pages.length,
    answers,
    answers_stating_a_figure: figures,
    answers_stating_a_figure_with_provenance: covered,
    answers_with_a_digit_and_no_figure: digitsUncovered,
    per_page: perPage,
    digit_but_no_figure: uncovered,
  }, null, 2));
}

if (process.argv[1] && process.argv[1].endsWith("faq-figure-audit.js")) await main();
