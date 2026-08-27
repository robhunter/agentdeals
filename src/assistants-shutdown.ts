export interface ShutdownFacts {
  date: string;
  isoDate: string;
  openaiSuccessor: string;
  azureSuccessor: string;
  azureInferenceApi: string;
  pages: string[];
}

export const ASSISTANTS_API_SHUTDOWN: ShutdownFacts = {
  date: "August 26, 2026",
  isoDate: "2026-08-26",
  openaiSuccessor: "Responses API",
  azureSuccessor: "Microsoft Foundry Agent Service",
  azureInferenceApi: "Azure OpenAI Responses API",
  pages: [
    "/openai-assistants-migration",
    "/openai-assistants-migration-2026",
    "/openai-assistants-alternatives",
  ],
};

const AZURE_SURVIVAL_PATTERNS: RegExp[] = [
  /not\s+been\s+deprecated/gi,
  /not\s+deprecated/gi,
  /not\s+announced\s+deprecation/gi,
  /no\s+deprecation\s+announced/gi,
  /may\s+not\s+be\s+deprecated/gi,
  /may\s+continue\s+(?:working|to\s+work)/gi,
  /may\s+maintain\s+(?:it|the\s+Assistants)/gi,
  /buys?\s+you\s+(?:more\s+)?time/gi,
  /(?:remains|stays|is\s+still)\s+available\s+on\s+Azure/gi,
  /Azure\s+is\s+(?:un|not\s+)affected/gi,
];

const SHUTDOWN_SUBJECT = /Azure|Assistants/i;

const SUBJECT_WINDOW = 200;

const HTML_TAG = /<\/?[a-zA-Z][^>]*>/g;

const AZURE_STATEMENT_WINDOW = 400;

const RETIREMENT_VERB = /retire[ds]?|retirement|shuts?\s?down|sunset/i;

const LONG_DATE = /\b(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},\s+\d{4}\b/;

export interface AzureRetirementStatement {
  date: string;
  namesSuccessor: boolean;
  sentence: string;
}

export function plainText(html: string): string {
  return html
    .replace(HTML_TAG, " ")
    .replace(/&mdash;/g, "—")
    .replace(/&middot;/g, "·")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

export function azureRetirementStatement(html: string): AzureRetirementStatement | null {
  const text = plainText(html);
  const azure = /Azure/g;
  for (let match = azure.exec(text); match !== null; match = azure.exec(text)) {
    const window = text.slice(match.index, match.index + AZURE_STATEMENT_WINDOW);
    if (!RETIREMENT_VERB.test(window)) continue;
    const date = window.match(LONG_DATE);
    if (!date) continue;
    const namesSuccessor = window.includes(ASSISTANTS_API_SHUTDOWN.azureSuccessor);
    if (!namesSuccessor) continue;
    return { date: date[0], namesSuccessor, sentence: window };
  }
  return null;
}

export function azureSurvivalClaims(text: string): string[] {
  const found = new Map<number, string>();
  for (const pattern of AZURE_SURVIVAL_PATTERNS) {
    pattern.lastIndex = 0;
    for (let match = pattern.exec(text); match !== null; match = pattern.exec(text)) {
      const from = Math.max(0, match.index - SUBJECT_WINDOW);
      const to = Math.min(text.length, match.index + match[0].length + SUBJECT_WINDOW);
      const window = text.slice(from, to);
      if (!SHUTDOWN_SUBJECT.test(window)) continue;
      if (found.has(match.index)) continue;
      found.set(match.index, window.replace(/\s+/g, " ").trim());
    }
  }
  return [...found.entries()].sort((a, b) => a[0] - b[0]).map(entry => entry[1]);
}
