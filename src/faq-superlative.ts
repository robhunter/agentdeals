export const SUPERLATIVE =
  /\b(?:the best|best free|best overall|best[- ]in[- ]class|the top|top free|top choice|top pick|most popular|most generous|stands out|the leading|number one|#1)\b/i;

const SENTENCE = /[^.!?]+[.!?]*/g;

const CURRENCY_FIGURE = /\$\s?([\d.,]+)\s?([KMB]?)\b/gi;

const SCALE: Record<string, number> = { K: 1e3, M: 1e6, B: 1e9 };

export function faqSentences(answer: string): string[] {
  return (answer.match(SENTENCE) ?? []).map(s => s.trim()).filter(s => s.length > 0);
}

export function namesASuperlative(sentence: string): boolean {
  return SUPERLATIVE.test(sentence);
}

export function printedQuantities(sentence: string): number[] {
  const values: number[] = [];
  for (const match of sentence.matchAll(CURRENCY_FIGURE)) {
    const scale = SCALE[match[2].toUpperCase()] ?? 1;
    values.push(parseFloat(match[1].replace(/,/g, "")) * scale);
  }
  return values;
}

export function ordersByAPrintedQuantity(sentence: string): boolean {
  if (!/\bby\s+[a-z]/i.test(sentence)) return false;
  const values = printedQuantities(sentence);
  if (values.length < 3) return false;
  return values.every((value, i) => i === 0 || value <= values[i - 1]);
}
