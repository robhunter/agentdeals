export function alternativeAllowanceOpening(details: string): string {
  const stops = [...details.matchAll(/[.!?]["'”’)]*(?=\s|$)/g)];
  const endOfSecond = stops[1] ? stops[1].index + stops[1][0].length : details.length;
  const opening = details.slice(0, endOfSecond).trim();
  if (opening.length <= 300) return opening;
  let end = 299;
  while (end > 0 && !/\s/.test(opening[end])) end--;
  return `${opening.slice(0, end).trimEnd()}…`;
}
