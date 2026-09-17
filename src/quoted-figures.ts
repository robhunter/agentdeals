const UNIT_ALIASES: Record<string, string> = {
  kb: "kb",
  kib: "kb",
  mb: "mb",
  mib: "mb",
  gb: "gb",
  gib: "gb",
  tb: "tb",
  tib: "tb",
  ocpu: "ocpu",
  ocpus: "ocpu",
  vcpu: "vcpu",
  vcpus: "vcpu",
  cpu: "cpu",
  cpus: "cpu",
  core: "core",
  cores: "core",
  vm: "vm",
  vms: "vm",
  h: "hour",
  hr: "hour",
  hrs: "hour",
  hour: "hour",
  hours: "hour",
  min: "minute",
  mins: "minute",
  minute: "minute",
  minutes: "minute",
  day: "day",
  days: "day",
  mo: "month",
  month: "month",
  months: "month",
  yr: "year",
  year: "year",
  years: "year",
  req: "request",
  reqs: "request",
  request: "request",
  requests: "request",
  user: "user",
  users: "user",
  seat: "seat",
  seats: "seat",
  project: "project",
  projects: "project",
  service: "service",
  services: "service",
  site: "site",
  sites: "site",
  domain: "domain",
  domains: "domain",
  zone: "zone",
  zones: "zone",
  build: "build",
  builds: "build",
  replica: "replica",
  replicas: "replica",
};

const AMOUNT_WITH_UNIT = /(\d[\d,]*(?:\.\d+)?)\s*([A-Za-z]+)/g;
const MONEY = /([$€£])\s?(\d[\d,]*(?:\.\d+)?)/g;

function amount(digits: string): string {
  return digits.replace(/,/g, "");
}

export function statedQuantities(text: string): string[] {
  const found = new Set<string>();
  for (const match of text.matchAll(AMOUNT_WITH_UNIT)) {
    const unit = UNIT_ALIASES[match[2]!.toLowerCase()];
    if (unit) found.add(`${amount(match[1]!)}${unit}`);
  }
  for (const match of text.matchAll(MONEY)) found.add(`${match[1]}${amount(match[2]!)}`);
  return [...found];
}

export function quantitiesNotIn(claim: string, backing: readonly string[]): string[] {
  const held = new Set(backing.flatMap(statedQuantities));
  return statedQuantities(claim).filter(quantity => !held.has(quantity));
}

export function clausesOf(description: string): string[] {
  const clauses: string[] = [];
  let depth = 0;
  let start = 0;
  for (let at = 0; at < description.length; at += 1) {
    const character = description[at];
    if (character === "(") depth += 1;
    else if (character === ")") depth = Math.max(0, depth - 1);
    else if ((character === "," || character === ".") && depth === 0) {
      clauses.push(description.slice(start, at));
      start = at + 1;
    }
  }
  clauses.push(description.slice(start));
  return clauses.map(clause => clause.trim()).filter(clause => clause !== "");
}

export function clauseNaming(description: string, subject: string): string | null {
  const wanted = subject.toLowerCase();
  return clausesOf(description).find(clause => clause.toLowerCase().includes(wanted)) ?? null;
}
