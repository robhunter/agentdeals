const USAGE_BEYOND_THE_FREE_TIER_IS_BILLED: readonly RegExp[] = [
  /\bbilled (?:at|for|only for)\b[^.]*?\b(?:beyond|past|above|over)\b/i,
  /\bbeyond the free (?:tier|allowance)\b[^.]*?\b(?:billed|charged|pay)/i,
  /\busage (?:beyond|past|above|over)\b[^.]*?\b(?:billed|charged)\b/i,
  /\bpay-as-you-go (?:beyond|after|past)\b/i,
  /\bcharged (?:at|for)\b[^.]*?\b(?:beyond|past|above|over) the free\b/i,
];

const THE_SERVICE_STOPS_AT_ITS_LIMIT: readonly RegExp[] = [
  /\b(?:stops?|stopped|pauses?|paused|blocks?|blocked|suspends?|suspended|shuts? off|cuts? off)\b[^.]*?\b(?:at|when|once|after|until)\b[^.]*?\b(?:limit|quota|allowance|credits?)\b/i,
  /\b(?:limit|quota|allowance|credits?)\b[^.]*?\b(?:is|are) (?:reached|hit|used up|exhausted|exceeded)\b[^.]*?\b(?:stops?|stopped|pauses?|paused|blocks?|blocked|suspends?|suspended|fails?|rejected)\b/i,
];

export function sentencesOf(texts: readonly string[]): string[] {
  return texts.flatMap(text => text.split(/(?<=[.!?])\s+/)).filter(sentence => sentence.trim() !== "");
}

export function statesUsageBeyondTheFreeTierIsBilled(texts: readonly string[]): boolean {
  const sentences = sentencesOf(texts);
  return sentences.some(sentence => USAGE_BEYOND_THE_FREE_TIER_IS_BILLED.some(pattern => pattern.test(sentence)))
    && !sentences.some(sentence => THE_SERVICE_STOPS_AT_ITS_LIMIT.some(pattern => pattern.test(sentence)));
}

export function listingStatements(listing: { description: string; conditions?: readonly { text: string }[] }): string[] {
  return [listing.description, ...(listing.conditions ?? []).map(condition => condition.text)];
}
