import { PER_CHANGE_FEED } from "./change-feed.js";

export interface WatchRequest {
  request: string;
  description: string;
}

export const NO_PUSH_NOTICE =
  "We do not push notifications. Every change we record is readable the moment it lands, and the JSON answer carries an ETag — send it back as If-None-Match and an unchanged answer costs one 304.";

export function changeJsonRequest(vendorName: string, baseUrl: string): string {
  return `${baseUrl}/api/changes?vendor=${encodeURIComponent(vendorName)}`;
}

export function changeFeedRequest(vendorName: string, baseUrl: string): string {
  return `${baseUrl}${PER_CHANGE_FEED.path}?vendor=${encodeURIComponent(vendorName)}`;
}

export function watchRequestsFor(vendorNames: readonly string[], baseUrl: string): WatchRequest[] {
  return vendorNames.flatMap((vendor) => [
    {
      request: changeJsonRequest(vendor, baseUrl),
      description: `Every change we hold for ${vendor}, as JSON.`,
    },
    {
      request: changeFeedRequest(vendor, baseUrl),
      description: `The same records as an Atom feed, one entry per change.`,
    },
  ]);
}

export function watchCommandBlock(vendorNames: readonly string[], baseUrl: string): string {
  return watchRequestsFor(vendorNames, baseUrl)
    .map((w) => `curl ${w.request}`)
    .join("\n");
}
