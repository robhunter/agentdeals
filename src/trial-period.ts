const STATES_A_TRIAL_PERIOD = /\btrial\b|\bfor (?:the first )?\d+ (?:days?|weeks?|months?)\b/i;

export function statesATrialPeriod(text: string): boolean {
  return STATES_A_TRIAL_PERIOD.test(text);
}
