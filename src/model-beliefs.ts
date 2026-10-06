import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const MODEL_BELIEFS_SLUG = "free-tier-facts-ai-models-get-wrong";
export const MODEL_BELIEFS_PATH = `/${MODEL_BELIEFS_SLUG}`;
export const MODEL_BELIEFS_TITLE = "Free-Tier Facts AI Models Get Wrong (2026)";
export const MODEL_BELIEFS_HEADING = "AI models give old free-tier terms";
export const MODEL_BELIEFS_CLOSING = "Check the vendor's page before relying on a figure an AI model gives from memory.";
export const MODEL_BELIEFS_RERUN_SENTENCE = "We re-run the same questions every month.";

export const MOSTLY_OLD_ANSWERS = 2;

export const QUOTED_MODEL_BELIEFS_CLASS = "quoted-model-beliefs";

export function quotedModelBeliefsSections(): RegExp {
  return new RegExp(`<section class="${QUOTED_MODEL_BELIEFS_CLASS}"[^>]*>[\\s\\S]*?</section>`, "g");
}

export function withoutQuotedModelBeliefs(html: string): string {
  return html.replace(quotedModelBeliefsSections(), (section) => " ".repeat(section.length));
}

export type BeliefGrade = "outdated" | "current" | "other";

export interface BeliefRun {
  date: string;
  instruction: string;
  answers_per_model: number;
  temperature: number;
  via: string;
  grading: string;
  rerun: string;
  answer_text: string;
}

export interface BeliefModel {
  id: string;
  name: string;
  lab: string;
}

export type BeliefChange = { date: string } | { from: string; to: string } | null;

export type BeliefCounts = Record<BeliefGrade, number>;

export interface BeliefFact {
  id: string;
  vendor: string;
  subject: string;
  page: string;
  question: string;
  outdated: string;
  current: string;
  changed: BeliefChange;
  source: { url: string; quote: string; read_on: string };
  results: Record<string, BeliefCounts>;
}

export interface BeliefAnswer {
  model: string;
  fact: string;
  run: number;
  grade: BeliefGrade;
  text: string;
}

export interface ModelBeliefs {
  run: BeliefRun;
  models: BeliefModel[];
  facts: BeliefFact[];
  answers: BeliefAnswer[];
}

export function modelBeliefsPath(): string {
  return process.env.AGENTDEALS_MODEL_BELIEFS_PATH || path.join(__dirname, "..", "data", "model-beliefs.json");
}

export function readModelBeliefs(file: string = modelBeliefsPath()): ModelBeliefs {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf-8");
  } catch (err) {
    throw new Error(`Cannot read what AI models said about free tiers at ${file}: ${(err as Error).message}`);
  }
  try {
    return JSON.parse(text) as ModelBeliefs;
  } catch (err) {
    throw new Error(`${file} is not valid JSON: ${(err as Error).message}`);
  }
}

const NUMBER_WORDS = [
  "zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten",
  "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen", "twenty",
];

export function numberWord(n: number): string {
  return NUMBER_WORDS[n] ?? String(n);
}

export function joinedWithAnd(items: string[]): string {
  if (items.length <= 2) return items.join(" and ");
  return `${items.slice(0, -1).join(", ")}, and ${items[items.length - 1]}`;
}

function countFor(fact: BeliefFact, model: BeliefModel, grade: BeliefGrade): number {
  return fact.results[model.id]?.[grade] ?? 0;
}

export function answersPerFact(beliefs: ModelBeliefs): number {
  return beliefs.models.length * beliefs.run.answers_per_model;
}

export function answersPerModel(beliefs: ModelBeliefs): number {
  return beliefs.facts.length * beliefs.run.answers_per_model;
}

export function answersInRun(beliefs: ModelBeliefs): number {
  return beliefs.models.length * beliefs.facts.length * beliefs.run.answers_per_model;
}

export function answersFor(beliefs: ModelBeliefs, fact: BeliefFact, grade: BeliefGrade): number {
  return beliefs.models.reduce((sum, model) => sum + countFor(fact, model, grade), 0);
}

export function oldAnswersFrom(beliefs: ModelBeliefs, model: BeliefModel): number {
  return beliefs.facts.reduce((sum, fact) => sum + countFor(fact, model, "outdated"), 0);
}

export function oldAnswersInRun(beliefs: ModelBeliefs): number {
  return beliefs.facts.reduce((sum, fact) => sum + answersFor(beliefs, fact, "outdated"), 0);
}

export function modelsMostlyOld(beliefs: ModelBeliefs, fact: BeliefFact): BeliefModel[] {
  return beliefs.models.filter((model) => countFor(fact, model, "outdated") >= MOSTLY_OLD_ANSWERS);
}

export function factsEveryModelGotWrong(beliefs: ModelBeliefs): BeliefFact[] {
  return beliefs.facts.filter((fact) => beliefs.models.length > 0 && modelsMostlyOld(beliefs, fact).length === beliefs.models.length);
}

function byMostOldAnswers<T>(items: T[], oldAnswers: (item: T) => number): T[] {
  return items
    .map((item, order) => ({ item, order, old: oldAnswers(item) }))
    .sort((a, b) => b.old - a.old || a.order - b.order)
    .map(({ item }) => item);
}

export function factsByOldAnswers(beliefs: ModelBeliefs): BeliefFact[] {
  return byMostOldAnswers(beliefs.facts, (fact) => answersFor(beliefs, fact, "outdated"));
}

export function modelsByOldAnswers(beliefs: ModelBeliefs): BeliefModel[] {
  return byMostOldAnswers(beliefs.models, (model) => oldAnswersFrom(beliefs, model));
}

export function changedLabel(changed: BeliefChange): string {
  if (!changed) return "";
  if ("from" in changed) return `between ${changed.from} and ${changed.to}`;
  return changed.date;
}

const PLANETSCALE_FACT = "planetscale_free";

function yearOf(isoDate: string): string {
  return isoDate.slice(0, 4);
}

function yearChanged(changed: BeliefChange): string {
  if (!changed) return "";
  if (!("from" in changed)) return yearOf(changed.date);
  return yearOf(changed.from) === yearOf(changed.to) ? yearOf(changed.to) : "";
}

function plural(n: number, word: string): string {
  return n === 1 ? word : `${word}s`;
}

export function metaDescriptionOf(beliefs: ModelBeliefs): string {
  return `${oldAnswersInRun(beliefs)} of ${answersInRun(beliefs)} AI answers gave old free-tier terms. Models answered without web access.`;
}

export function introOf(beliefs: ModelBeliefs): string {
  return `We asked ${numberWord(beliefs.models.length)} AI models about developer free tiers without web access. They answered from their own knowledge. ${oldAnswersInRun(beliefs)} of ${answersInRun(beliefs)} answers started with the old term.`;
}

export function findingOf(beliefs: ModelBeliefs): string {
  const sentences: string[] = [];
  const everyModelWrong = factsEveryModelGotWrong(beliefs);
  if (everyModelWrong.length > 0) {
    sentences.push(`All ${numberWord(beliefs.models.length)} models gave the old term for ${joinedWithAnd(everyModelWrong.map((fact) => fact.subject))}.`);
  }
  const planetscale = beliefs.facts.find((fact) => fact.id === PLANETSCALE_FACT);
  if (planetscale && yearChanged(planetscale.changed)) {
    sentences.push(`${answersFor(beliefs, planetscale, "current")} of ${answersPerFact(beliefs)} answers knew PlanetScale's free plan ended in ${yearChanged(planetscale.changed)}.`);
  }
  return sentences.join(" ");
}

export function methodOf(beliefs: ModelBeliefs): string {
  const perQuestion = beliefs.run.answers_per_model;
  return `The instruction was: "${beliefs.run.instruction}" Each model gave ${numberWord(perQuestion)} ${plural(perQuestion, "answer")} per question via OpenRouter at temperature ${beliefs.run.temperature}. We graded by the figure or YES/NO an answer started with.`;
}

export function testedOnOf(beliefs: ModelBeliefs): string {
  return `Tested on ${beliefs.run.date}.`;
}
