import { readFileSync, writeFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const INDEX = resolve(ROOT, "data/index.json");

const RENAMES = {
  Docs: "Zoho Docs",
  Projects: "Zoho Projects",
  Connect: "Zoho Connect",
  Meeting: "Zoho Meeting",
  Vault: "Zoho Vault",
  Showtime: "Zoho Showtime",
  Notebook: "Zoho Notebook",
  Wiki: "Zoho Wiki",
  Checkout: "Zoho Checkout",
  Desk: "Zoho Desk",
  Cliq: "Zoho Cliq",
  "filebase.com": "Filebase",
};

const RECATEGORIZE = {
  Zoho: "Productivity & Notes",
  "Zoho Assist": "Server Management",
  "Zoho Docs": "Productivity & Notes",
  "Zoho Projects": "Project Management",
  "Zoho Connect": "Team Collaboration",
  "Zoho Meeting": "Video",
  "Zoho Vault": "Password Managers",
  "Zoho Showtime": "Video",
  "Zoho Notebook": "Productivity & Notes",
  "Zoho Wiki": "Documentation",
  "Zoho Checkout": "Payments",
  "Zoho Desk": "Communication",
  "Zoho Cliq": "Messaging",
  "4EVERLAND": "Storage",
  "C2 Object Storage": "Storage",
  Filebase: "Storage",
  "Google Colab": "Notebooks & Data Science",
};

const RETAG = {
  "Productivity & Notes": ["productivity"],
  "Server Management": ["server-management"],
  "Project Management": ["project-management"],
  "Team Collaboration": ["collaboration"],
  Video: ["video"],
  "Password Managers": ["passwords", "security"],
  Documentation: ["documentation"],
  Payments: ["payments"],
  Communication: ["communication"],
  Messaging: ["messaging"],
  Storage: ["storage"],
  "Notebooks & Data Science": ["notebooks", "data-science"],
};

const doc = JSON.parse(readFileSync(INDEX, "utf8"));
const renamed = [];
const moved = [];

for (const offer of doc.offers) {
  if (offer.category !== "Cloud IaaS") continue;
  const newName = RENAMES[offer.vendor];
  if (newName) {
    renamed.push([offer.vendor, newName]);
    offer.vendor = newName;
  }
}

for (const offer of doc.offers) {
  const target = RECATEGORIZE[offer.vendor];
  if (!target || offer.category !== "Cloud IaaS") continue;
  moved.push([offer.vendor, offer.category, target]);
  offer.category = target;
  const drop = new Set(["cloud", "iaas"]);
  const kept = (offer.tags || []).filter((t) => !drop.has(t));
  for (const t of RETAG[target] || []) if (!kept.includes(t)) kept.unshift(t);
  offer.tags = kept;
}

writeFileSync(INDEX, JSON.stringify(doc, null, 2) + "\n");

console.log(`Renamed ${renamed.length}:`);
for (const [a, b] of renamed) console.log(`  ${a} -> ${b}`);
console.log(`\nRecategorized ${moved.length}:`);
for (const [v, a, b] of moved) console.log(`  ${v}: ${a} -> ${b}`);
const remaining = doc.offers.filter((o) => o.category === "Cloud IaaS").length;
console.log(`\nCloud IaaS: 40 -> ${remaining}`);
