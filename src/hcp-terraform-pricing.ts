export interface HcpTerraformEssentialsPrice {
  dollarsPerResourceMonth: number;
  dollarsPerResourceHour: number;
  exampleResources: number;
  readOn: string;
  pricingPage: string;
  billingDocs: string;
}

export const HCP_TERRAFORM_ESSENTIALS_PRICE: HcpTerraformEssentialsPrice = {
  dollarsPerResourceMonth: 0.1,
  dollarsPerResourceHour: 0.00013,
  exampleResources: 800,
  readOn: "2026-10-09",
  pricingPage: "https://www.hashicorp.com/en/pricing?tab=terraform",
  billingDocs: "https://developer.hashicorp.com/terraform/cloud-docs/overview",
};

export function dollarsAsWritten(amount: number): string {
  const decimals = String(amount).split(".")[1]?.length ?? 0;
  return `$${amount.toFixed(Math.max(2, decimals))}`;
}

export function hcpTerraformPastTheFreeTierHtml(price: HcpTerraformEssentialsPrice = HCP_TERRAFORM_ESSENTIALS_PRICE): string {
  const exampleMonth = Math.round(price.exampleResources * price.dollarsPerResourceMonth);
  return `To manage more than 500 resources, an organization needs a paid plan, such as <a href="${price.billingDocs}" target="_blank" rel="noopener">Essentials</a>, which bills every resource at ${dollarsAsWritten(price.dollarsPerResourceMonth)} a month or ${dollarsAsWritten(price.dollarsPerResourceHour)} an hour, based on the peak count in each hour, so ${price.exampleResources} resources cost about $${exampleMonth} a month.`;
}
