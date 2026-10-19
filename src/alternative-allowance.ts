const sentences = new Intl.Segmenter("en", { granularity: "sentence" });

export function alternativeAllowanceOpening(details: string): string {
  const opening = [...sentences.segment(details)].slice(0, 2).map(part => part.segment).join("").trim();
  if (opening.length <= 300) return opening;
  let end = 299;
  while (end > 0 && !/\s/.test(opening[end])) end--;
  return `${opening.slice(0, end).trimEnd()}…`;
}
