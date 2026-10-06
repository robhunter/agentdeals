import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const { findingOf, withoutQuotedModelBeliefs } = await import("../dist/model-beliefs.js");

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const ROUTE = "/free-tier-facts-ai-models-get-wrong";

type Grade = "outdated" | "current" | "other";
type Counts = Record<Grade, number>;

interface Fixture {
  run: { date: string; instruction: string; answers_per_model: number; temperature: number; via: string; grading: string; rerun: string; answer_text: string };
  models: Array<{ id: string; name: string; lab: string }>;
  facts: Array<{
    id: string;
    vendor: string;
    subject: string;
    page: string;
    question: string;
    outdated: string;
    current: string;
    changed: { date: string } | { from: string; to: string } | null;
    source: { url: string; quote: string; read_on: string };
    results: Record<string, Counts>;
  }>;
  answers: Array<{ model: string; fact: string; run: number; grade: Grade; text: string }>;
}

function counts(outdated: number, current: number, other: number): Counts {
  return { outdated, current, other };
}

function withAnswers(fixture: Omit<Fixture, "answers">): Fixture {
  const answers: Fixture["answers"] = [];
  for (const fact of fixture.facts) {
    for (const model of fixture.models) {
      const graded = (["outdated", "current", "other"] as Grade[]).flatMap((grade) => Array(fact.results[model.id][grade]).fill(grade) as Grade[]);
      graded.forEach((grade, i) => answers.push({ model: model.id, fact: fact.id, run: i + 1, grade, text: `${model.name} on ${fact.vendor}, run ${i + 1}, said something ${grade}` }));
    }
  }
  return { ...fixture, answers };
}

const RUN = {
  instruction: "Answer briefly from what you remember.",
  via: "a test double",
  grading: "by the first figure",
  rerun: "monthly, same questions",
  answer_text: "as given",
};

function source(vendor: string): Fixture["facts"][number]["source"] {
  return { url: `https://example.com/${vendor.toLowerCase().replace(/\W+/g, "-")}`, quote: `${vendor} states its current terms here.`, read_on: "2026-11-02" };
}

const THREE_MODELS = withAnswers({
  run: { ...RUN, date: "2026-11-03", answers_per_model: 3, temperature: 0.4 },
  models: [
    { id: "lab-one/alpha", name: "Model Alpha", lab: "Lab One" },
    { id: "lab-two/beta", name: "Model Beta", lab: "Lab Two" },
    { id: "lab-one/gamma", name: "Model Gamma", lab: "Lab One" },
  ],
  facts: [
    {
      id: "every_model_wrong", vendor: "Vendor Every", page: "/vendor/vendor-every", subject: "Vendor Every's starter credit",
      question: "What credit does Vendor Every give?", outdated: "$100 of credit", current: "$10 of credit",
      changed: { date: "2026-05-01" }, source: source("Vendor Every"),
      results: { "lab-one/alpha": counts(3, 0, 0), "lab-two/beta": counts(2, 0, 1), "lab-one/gamma": counts(2, 1, 0) },
    },
    {
      id: "bracketed_change", vendor: "Vendor Bracket", page: "/vendor-bracket-free-tier-2026", subject: "Vendor Bracket's free plan",
      question: "Does Vendor Bracket have a free plan?", outdated: "a free plan", current: "no free plan",
      changed: { from: "2026-02-01", to: "2026-02-09" }, source: source("Vendor Bracket"),
      results: { "lab-one/alpha": counts(1, 2, 0), "lab-two/beta": counts(3, 0, 0), "lab-one/gamma": counts(0, 3, 0) },
    },
    {
      id: "undated_change", vendor: "Vendor Undated", page: "/vendor/vendor-undated", subject: "Vendor Undated's free seats",
      question: "How many seats are free on Vendor Undated?", outdated: "5 seats", current: "3 seats",
      changed: null, source: source("Vendor Undated"),
      results: { "lab-one/alpha": counts(0, 3, 0), "lab-two/beta": counts(0, 3, 0), "lab-one/gamma": counts(1, 2, 0) },
    },
    {
      id: "planetscale_free", vendor: "PlanetScale", page: "/vendor/planetscale", subject: "PlanetScale's free plan",
      question: "Does PlanetScale currently offer a free plan?", outdated: "a free plan", current: "no free plan",
      changed: { date: "2025-04-08" }, source: source("PlanetScale"),
      results: { "lab-one/alpha": counts(0, 3, 0), "lab-two/beta": counts(1, 2, 0), "lab-one/gamma": counts(0, 3, 0) },
    },
  ],
});

const FOUR_OTHER_MODELS = withAnswers({
  run: { ...RUN, date: "2026-12-01", answers_per_model: 2, temperature: 1 },
  models: [
    { id: "lab-three/delta", name: "Model Delta", lab: "Lab Three" },
    { id: "lab-four/epsilon", name: "Model Epsilon", lab: "Lab Four" },
    { id: "lab-four/zeta", name: "Model Zeta", lab: "Lab Four" },
    { id: "lab-five/eta", name: "Model Eta", lab: "Lab Five" },
  ],
  facts: [
    {
      id: "first_fact", vendor: "Vendor First", page: "/vendor/vendor-first", subject: "Vendor First's free storage",
      question: "How much storage is free?", outdated: "9 GB", current: "5 GB",
      changed: { date: "2026-08-20" }, source: source("Vendor First"),
      results: { "lab-three/delta": counts(2, 0, 0), "lab-four/epsilon": counts(2, 0, 0), "lab-four/zeta": counts(2, 0, 0), "lab-five/eta": counts(2, 0, 0) },
    },
    {
      id: "second_fact", vendor: "Vendor Second", page: "/vendor/vendor-second", subject: "Vendor Second's free builds",
      question: "How many builds are free?", outdated: "100 builds", current: "500 builds",
      changed: { date: "2026-09-10" }, source: source("Vendor Second"),
      results: { "lab-three/delta": counts(0, 2, 0), "lab-four/epsilon": counts(1, 1, 0), "lab-four/zeta": counts(0, 1, 1), "lab-five/eta": counts(2, 0, 0) },
    },
  ],
});

type Change = Fixture["facts"][number]["changed"];

function runOfThreeModels(facts: Array<{ id: string; subject: string; old: [number, number, number]; changed?: Change }>): Fixture {
  const models = THREE_MODELS.models;
  return withAnswers({
    run: THREE_MODELS.run,
    models,
    facts: facts.map(({ id, subject, old, changed = { date: "2026-03-01" } }) => ({
      id, vendor: `Vendor ${id}`, subject, page: `/vendor/vendor-${id}`,
      question: `What does Vendor ${id} give for free?`, outdated: "the old term", current: "the current term",
      changed, source: source(`Vendor ${id}`),
      results: Object.fromEntries(models.map((model, i) => [model.id, counts(old[i], 3 - old[i], 0)])),
    })),
  });
}

const NO_FACT_EVERY_MODEL_GOT_WRONG = runOfThreeModels([
  { id: "credit", subject: "the first vendor's credit", old: [3, 3, 1] },
  { id: "storage", subject: "the second vendor's storage", old: [0, 2, 3] },
]);

const NUMBER_WORDS = [
  "zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten",
  "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen", "twenty",
];
const inWords = (n: number) => NUMBER_WORDS[n] ?? String(n);

const oldAnswersTo = (fixture: Fixture, fact: Fixture["facts"][number]) =>
  fixture.models.reduce((sum, model) => sum + fact.results[model.id].outdated, 0);
const oldAnswersFrom = (fixture: Fixture, modelId: string) =>
  fixture.facts.reduce((sum, fact) => sum + fact.results[modelId].outdated, 0);
const oldAnswersInRun = (fixture: Fixture) => fixture.facts.reduce((sum, fact) => sum + oldAnswersTo(fixture, fact), 0);
const answersInRun = (fixture: Fixture) => fixture.models.length * fixture.facts.length * fixture.run.answers_per_model;
const answersPerFact = (fixture: Fixture) => fixture.models.length * fixture.run.answers_per_model;
const answersPerModel = (fixture: Fixture) => fixture.facts.length * fixture.run.answers_per_model;

const ENTITIES: Record<string, string> = {
  "&amp;": "&", "&quot;": '"', "&#39;": "'", "&lt;": "<", "&gt;": ">", "&ldquo;": "“", "&rdquo;": "”",
  "&rsaquo;": "›", "&mdash;": "—", "&middot;": "·", "&rarr;": "→", "&nbsp;": " ",
};

function visible(html: string): string {
  return html
    .replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&[a-z#0-9]+;/gi, (e) => ENTITIES[e] ?? e)
    .replace(/\s+/g, " ")
    .replace(/ ([,.:;])/g, "$1")
    .trim();
}

function rowsOf(html: string, rowClass: string): string[][] {
  return [...html.matchAll(new RegExp(`<tr class="${rowClass}"[^>]*>([\\s\\S]*?)</tr>`, "g"))].map(([, row]) =>
    [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map(([, cell]) => cell));
}

function modelTotalRows(html: string): string[][] {
  const table = html.split(`class="pricing-table belief-model-totals"`)[1]?.split("</table>")[0] ?? "";
  return [...table.matchAll(/<tr>([\s\S]*?)<\/tr>/g)]
    .map(([, row]) => [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map(([, cell]) => visible(cell)))
    .filter((cells) => cells.length > 0);
}

function spawnServer(env: Record<string, string>): Promise<{ child: ChildProcess; base: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn("node", [path.join(REPO, "dist", "serve.js")], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, PORT: "0", BASE_URL: "http://localhost", TZ: "UTC", ...env },
    });
    const timeout = setTimeout(() => { child.kill(); reject(new Error("Server startup timeout")); }, 30000);
    child.stderr!.on("data", (data: Buffer) => {
      const m = data.toString().match(/running on http:\/\/localhost:(\d+)/);
      if (m) { clearTimeout(timeout); resolve({ child, base: `http://localhost:${m[1]}` }); }
    });
    child.on("error", (err) => { clearTimeout(timeout); reject(err); });
  });
}

function servedFrom(fixture: Fixture | null) {
  const state = { page: "", sitemap: "", guides: "", status: 0 };
  let scratch = "";
  let child: ChildProcess | null = null;
  before(async () => {
    const env: Record<string, string> = {};
    if (fixture) {
      scratch = mkdtempSync(path.join(tmpdir(), "model-beliefs-"));
      env.AGENTDEALS_MODEL_BELIEFS_PATH = path.join(scratch, "model-beliefs.json");
      writeFileSync(env.AGENTDEALS_MODEL_BELIEFS_PATH, JSON.stringify(fixture));
    }
    const server = await spawnServer(env);
    child = server.child;
    const response = await fetch(`${server.base}${ROUTE}`);
    state.status = response.status;
    state.page = await response.text();
    state.sitemap = await (await fetch(`${server.base}/sitemap-pages.xml`)).text();
    state.guides = await (await fetch(`${server.base}/guides`)).text();
  });
  after(() => {
    child?.kill();
    if (scratch) rmSync(scratch, { recursive: true, force: true });
  });
  return state;
}

function factRowsExpected(fixture: Fixture): string[][] {
  return fixture.facts
    .map((fact, order) => ({ fact, order, old: oldAnswersTo(fixture, fact) }))
    .sort((a, b) => b.old - a.old || a.order - b.order)
    .map(({ fact, old }) => {
      const changed = fact.changed === null ? "" : "from" in fact.changed ? `between ${fact.changed.from} and ${fact.changed.to}` : fact.changed.date;
      return [fact.vendor, fact.question, fact.outdated, `“${fact.source.quote}”, read on ${fact.source.read_on}`, changed, `${old} of ${answersPerFact(fixture)}`];
    });
}

function modelRowsExpected(fixture: Fixture): string[][] {
  return fixture.models
    .map((model, order) => ({ model, order, old: oldAnswersFrom(fixture, model.id) }))
    .sort((a, b) => b.old - a.old || a.order - b.order)
    .map(({ model, old }) => [model.name, model.lab, `${old} of ${answersPerModel(fixture)}`]);
}

describe("the page of free-tier facts AI models get wrong, served from a three-model fixture", () => {
  const served = servedFrom(THREE_MODELS);

  it("gives the run's totals in the meta description and the intro", () => {
    const description = served.page.match(/<meta name="description" content="([^"]*)"/)?.[1] ?? "";
    assert.strictEqual(description, `${oldAnswersInRun(THREE_MODELS)} of ${answersInRun(THREE_MODELS)} AI answers gave old free-tier terms. Models answered without web access.`);
    assert.ok(visible(served.page).includes(`We asked three AI models about developer free tiers without web access. They answered from their own knowledge. ${oldAnswersInRun(THREE_MODELS)} of ${answersInRun(THREE_MODELS)} answers started with the old term.`));
  });

  it("names in the finding only the facts every model got wrong in at least two answers, and PlanetScale's count of current answers", () => {
    const planetscale = THREE_MODELS.facts.find((fact) => fact.id === "planetscale_free")!;
    const current = THREE_MODELS.models.reduce((sum, model) => sum + planetscale.results[model.id].current, 0);
    assert.ok(visible(served.page).includes(`All three models gave the old term for Vendor Every's starter credit. ${current} of ${answersPerFact(THREE_MODELS)} answers knew PlanetScale's free plan ended in 2025.`));
  });

  it("states the run's instruction, answers per question, temperature and date", () => {
    const text = visible(served.page);
    assert.ok(text.includes(`The instruction was: "${THREE_MODELS.run.instruction}" Each model gave three answers per question via OpenRouter at temperature 0.4.`));
    assert.ok(text.includes("Tested on 2026-11-03. We re-run the same questions every month."));
  });

  it("puts one row per fact in the facts table, most old answers first, with the vendor's words and when the terms changed", () => {
    const rows = rowsOf(served.page, "belief-fact").map((cells) => cells.map(visible));
    assert.deepStrictEqual(rows, factRowsExpected(THREE_MODELS));
  });

  it("prints no date for a fact whose change has none", () => {
    const row = rowsOf(served.page, "belief-fact").find((cells) => visible(cells[0]) === "Vendor Undated");
    assert.ok(row, "no row for the undated fact");
    assert.strictEqual(row![4].trim(), "");
  });

  it("links each vendor to its page and each quote to the vendor's source", () => {
    const rows = rowsOf(served.page, "belief-fact");
    const unlinked = THREE_MODELS.facts.filter((fact) => {
      const row = rows.find((cells) => visible(cells[0]) === fact.vendor);
      return !row || !row[0].includes(`href="${fact.page}"`) || !row[3].includes(`href="${fact.source.url}"`);
    });
    assert.deepStrictEqual(unlinked.map((fact) => fact.vendor), []);
  });

  it("names under each fact the models that gave the old term in at least two of their answers", () => {
    const named = rowsOf(served.page, "belief-models").map(([cell]) => visible(cell).match(/at least 2 of 3 answers: (.*?)\./)?.[1]);
    const expected = factRowsExpected(THREE_MODELS).map(([vendor]) => {
      const fact = THREE_MODELS.facts.find((f) => f.vendor === vendor)!;
      const names = THREE_MODELS.models.filter((model) => fact.results[model.id].outdated >= 2).map((model) => model.name);
      return names.length > 0 ? names.join(", ") : "none";
    });
    assert.deepStrictEqual(named, expected);
  });

  it("lists each model's old answers out of all its answers, most first", () => {
    assert.deepStrictEqual(modelTotalRows(served.page), modelRowsExpected(THREE_MODELS));
  });

  it("keeps its own sentences outside the section that quotes the models, so the site's checks still read them", () => {
    const ours = visible(withoutQuotedModelBeliefs(served.page));
    assert.ok(ours.includes(`${oldAnswersInRun(THREE_MODELS)} of ${answersInRun(THREE_MODELS)} answers started with the old term.`), "intro");
    assert.ok(ours.includes("All three models gave the old term for Vendor Every's starter credit."), "finding");
    assert.ok(ours.includes(`The instruction was: "${THREE_MODELS.run.instruction}"`), "method");
    assert.ok(ours.includes("Check the vendor's page before relying on a figure an AI model gives from memory."), "closing");
    assert.deepStrictEqual(modelTotalRows(served.page).length, THREE_MODELS.models.length);
    assert.ok(!ours.includes("$100 of credit"), "an old term is outside the quoted section");
    assert.ok(!ours.includes("graded outdated"), "an answer is outside the quoted section");
  });

  it("makes every answer readable under its fact, with its model, run and grade", () => {
    const sections = new Map(rowsOf(served.page, "belief-models").map(([cell], i) => [factRowsExpected(THREE_MODELS)[i][0], visible(cell)]));
    const nameOf = new Map(THREE_MODELS.models.map((model) => [model.id, model.name]));
    const missing = THREE_MODELS.answers.filter((answer) => {
      const vendor = THREE_MODELS.facts.find((fact) => fact.id === answer.fact)!.vendor;
      return !sections.get(vendor)?.includes(`${nameOf.get(answer.model)}, run ${answer.run}, graded ${answer.grade}: ${answer.text}`);
    });
    assert.deepStrictEqual(missing, []);
  });
});

describe("the same page served from a fixture with a different model list", () => {
  const served = servedFrom(FOUR_OTHER_MODELS);

  it("names that list's models and labs with that list's totals", () => {
    const text = visible(served.page);
    assert.ok(text.includes(`We asked four AI models about developer free tiers without web access. They answered from their own knowledge. ${oldAnswersInRun(FOUR_OTHER_MODELS)} of ${answersInRun(FOUR_OTHER_MODELS)} answers started with the old term.`));
    assert.ok(text.includes("All four models gave the old term for Vendor First's free storage."));
    assert.ok(text.includes("Each model gave two answers per question via OpenRouter at temperature 1."));
    assert.deepStrictEqual(modelTotalRows(served.page), modelRowsExpected(FOUR_OTHER_MODELS));
    assert.deepStrictEqual(rowsOf(served.page, "belief-fact").map((cells) => cells.map(visible)), factRowsExpected(FOUR_OTHER_MODELS));
  });

  it("leaves out the PlanetScale sentence when the run asked nothing about PlanetScale", () => {
    assert.doesNotMatch(visible(served.page), /PlanetScale's free plan ended/);
  });
});

describe("the finding sentence, computed from the facts every model got wrong", () => {
  it("is left out when no fact drew two or more old answers from every model", () => {
    assert.strictEqual(findingOf(NO_FACT_EVERY_MODEL_GOT_WRONG), "");
  });

  it("joins two facts with 'and', in file order", () => {
    const run = runOfThreeModels([
      { id: "credit", subject: "the first vendor's credit", old: [2, 3, 2] },
      { id: "storage", subject: "the second vendor's storage", old: [3, 1, 3] },
      { id: "seats", subject: "the third vendor's seats", old: [2, 2, 2] },
    ]);
    assert.strictEqual(findingOf(run), "All three models gave the old term for the first vendor's credit and the third vendor's seats.");
  });

  it("lists three or more facts with commas and a final ', and', in file order", () => {
    const run = runOfThreeModels([
      { id: "credit", subject: "the first vendor's credit", old: [3, 3, 3] },
      { id: "storage", subject: "the second vendor's storage", old: [2, 2, 2] },
      { id: "builds", subject: "the third vendor's builds", old: [3, 2, 1] },
      { id: "seats", subject: "the fourth vendor's seats", old: [2, 3, 2] },
      { id: "minutes", subject: "the fifth vendor's minutes", old: [2, 2, 3] },
    ]);
    assert.strictEqual(findingOf(run), "All three models gave the old term for the first vendor's credit, the second vendor's storage, the fourth vendor's seats, and the fifth vendor's minutes.");
  });
});

describe("the PlanetScale sentence, computed from the planetscale_free fact", () => {
  const planetscale = (changed: Change) =>
    runOfThreeModels([{ id: "planetscale_free", subject: "PlanetScale's free plan", old: [0, 1, 0], changed }]);

  it("counts current answers out of every answer to that fact, with the year of a change bracketed inside one year", () => {
    assert.strictEqual(findingOf(planetscale({ from: "2025-11-02", to: "2025-11-20" })), "8 of 9 answers knew PlanetScale's free plan ended in 2025.");
  });

  it("is left out when the change is bracketed across a new year, or undated", () => {
    assert.strictEqual(findingOf(planetscale({ from: "2025-12-20", to: "2026-01-05" })), "");
    assert.strictEqual(findingOf(planetscale(null)), "");
  });
});

describe("the page served from a run with no finding to state", () => {
  const served = servedFrom(NO_FACT_EVERY_MODEL_GOT_WRONG);

  it("prints neither finding sentence nor an empty paragraph in their place", () => {
    assert.strictEqual(served.status, 200);
    assert.doesNotMatch(visible(served.page), /gave the old term for|PlanetScale's free plan ended/);
    assert.doesNotMatch(served.page, /<p class="section-intro">\s*<\/p>/);
  });
});

describe("the page served from the committed run", () => {
  const served = servedFrom(null);
  const committed = JSON.parse(readFileSync(path.join(REPO, "data", "model-beliefs.json"), "utf8")) as Fixture;

  it("answers 200 with the title, heading and closing it was given", () => {
    assert.strictEqual(served.status, 200);
    assert.ok(served.page.includes("<title>Free-Tier Facts AI Models Get Wrong (2026) — AgentDeals</title>"));
    assert.ok(served.page.includes("<h1>AI models give old free-tier terms</h1>"));
    assert.ok(visible(served.page).includes("Check the vendor's page before relying on a figure an AI model gives from memory."));
  });

  it("names a subject for every fact, for the finding to list", () => {
    assert.deepStrictEqual(committed.facts.filter((fact) => typeof fact.subject !== "string" || fact.subject.trim() === "").map((fact) => fact.id), []);
  });

  it("prints the finding computed from the committed run", () => {
    assert.ok(visible(served.page).includes(findingOf(committed)));
  });

  it("is listed in the pages sitemap and on /guides", () => {
    assert.ok(served.sitemap.includes(`<loc>http://localhost${ROUTE}</loc>`), "not in /sitemap-pages.xml");
    assert.ok(served.guides.includes(`href="${ROUTE}"`), "not on /guides");
  });

  it("states the committed run's counts in the intro and in both tables", () => {
    assert.ok(visible(served.page).includes(`We asked ${inWords(committed.models.length)} AI models about developer free tiers without web access. They answered from their own knowledge. ${oldAnswersInRun(committed)} of ${answersInRun(committed)} answers started with the old term.`));
    assert.deepStrictEqual(rowsOf(served.page, "belief-fact").map((cells) => cells.map(visible)), factRowsExpected(committed));
    assert.deepStrictEqual(modelTotalRows(served.page), modelRowsExpected(committed));
  });
});
