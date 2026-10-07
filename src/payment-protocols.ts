import type { Offer, PaymentProtocol } from "./types.js";

function withCollapsedWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

export function sourceStatesTheCost(entry: PaymentProtocol): boolean {
  const cost = withCollapsedWhitespace(entry.example_cost ?? "");
  if (cost === "" || typeof entry.source_quote !== "string") return false;
  return withCollapsedWhitespace(entry.source_quote).includes(cost);
}

function withoutACostItsSourceDoesNotState(entry: PaymentProtocol): PaymentProtocol {
  if (entry.example_cost === undefined || sourceStatesTheCost(entry)) return entry;
  const { example_cost: _notInItsSourceQuote, ...rest } = entry;
  return rest;
}

export function withPaymentCostsTheirSourcesState(offer: Offer): Offer {
  if (!offer.payment_protocols) return offer;
  if (offer.payment_protocols.every(entry => entry.example_cost === undefined || sourceStatesTheCost(entry))) return offer;
  return { ...offer, payment_protocols: offer.payment_protocols.map(withoutACostItsSourceDoesNotState) };
}
