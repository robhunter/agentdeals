import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";

const repo = fileURLToPath(new URL("..", import.meta.url));
let child: ChildProcess;
let html = "";
let state = "";

const plain = (text: string): string => text
  .replace(/<a\b[^>]*class="[^"]*(?:figure-source|record-source|unsourced-tag|compiled-figure)[^"]*"[^>]*>[\s\S]*?<\/a>/g, "")
  .replace(/<span\b[^>]*class="[^"]*(?:unsourced-tag|compiled-figure)[^"]*"[^>]*>[\s\S]*?<\/span>/g, "")
  .replace(/<[^>]+>/g, " ")
  .replace(/&rsquo;|&#39;|&#x27;/g, "'")
  .replace(/&ndash;/g, "–").replace(/&mdash;/g, "—")
  .replace(/&amp;/g, "&").replace(/&nbsp;/g, " ")
  .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
  .replace(/\s+/g, " ").trim();

function table(id: string): string[][] {
  const at = html.indexOf(`id="${id}"`);
  assert.ok(at >= 0, id);
  const source = html.slice(at).match(/<table\b[^>]*>([\s\S]*?)<\/table>/)?.[1];
  assert.ok(source, id);
  return [...source.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/g)]
    .map(row => [...row[1].matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/g)]
      .map((cell, index) => plain(index === 0 ? cell[1]
        .replace(/<a\b[^>]*href="[^"]*#changes"[^>]*>[\s\S]*?<\/a>/g, "")
        .replace(/<span\b[^>]*class="[^"]*badge[^"]*"[^>]*>[\s\S]*?<\/span>/g, "") : cell[1])))
    .filter(row => row.length > 1);
}

function row(id: string, name: string): string[] {
  const found = table(id).filter(cells => cells[0] === name);
  assert.equal(found.length, 1, `${id}: ${name}`);
  return found[0];
}

function card(heading: string): string {
  const cards = [...html.matchAll(/<div class="diff-card">\s*<h3>([\s\S]*?)<\/h3>\s*<div class="diff-desc">([\s\S]*?)<\/div>\s*<\/div>/g)];
  const found = cards.filter(match => plain(match[1]).startsWith(heading));
  assert.equal(found.length, 1, heading);
  return plain(found[0][2]);
}

describe("security comparison plans, licences and hosted prices", () => {
  before(async () => {
    let stderr = "";
    child = spawn(process.execPath, ["dist/serve.js"], { cwd: repo, env: { ...process.env, PORT: "0", BASE_URL: "http://localhost", TZ: "UTC" }, stdio: ["ignore", "pipe", "pipe"] });
    child.stdout!.resume();
    const port = await new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error(stderr)); }, 60000);
      child.stderr!.on("data", chunk => {
        stderr += chunk;
        const match = stderr.match(/running on http:\/\/localhost:(\d+)/);
        if (match) { clearTimeout(timer); resolve(Number(match[1])); }
      });
      child.once("error", error => { clearTimeout(timer); reject(error); });
      child.once("exit", code => { clearTimeout(timer); reject(new Error(`server exited ${code}: ${stderr}`)); });
    });
    const read = async (route: string) => {
      const response = await fetch(`http://localhost:${port}${route}`, { redirect: "error" });
      assert.equal(response.status, 200);
      return response.text();
    };
    html = await read("/security-free-tier-comparison-2026");
    state = await read("/state-of-free-tiers");
  });
  after(() => child?.kill("SIGKILL"));

  it("withdraws obsolete limits, licences and price claims from the complete response", () => {
    for (const text of ["50 private repos", "50 repos", "Public only<", "MIT (engine)", "Unlimited for OSS projects", "420+", "April 2026", "first private repo", "10 remote networks", "free for all repositories", "widest price gap", "$50,000+", "$23,000", "$23K", "$49/committer", "(enterprise only)", "public-only on free tiers", "SonarCloud, CodeQL, and SOOS", "15+ languages", "cost thousands per year"]) {
      assert.ok(!html.toLowerCase().includes(text.toLowerCase()), text);
      assert.ok(!plain(html).toLowerCase().includes(text.toLowerCase()), text);
    }
  });

  it("retains every main-table provider", () => {
    assert.deepEqual(table("main-comparison").map(cells => cells[0]), ["Snyk", "Semgrep", "SonarCloud", "CodeQL", "aikido.dev", "GitGuardian", "Gitleaks", "TruffleHog", "Trivy", "Grype", "Checkov", "OWASP ZAP", "Nuclei", "StackHawk", "Probely", "Dependabot", "Renovate", "FOSSA", "Socket.dev", "SOOS", "Falco", "Tailscale", "Twingate", "Let's Encrypt"]);
  });

  it("limits hosted Semgrep to ten contributors and ten private repositories", () => {
    const cells = row("main-comparison", "Semgrep");
    assert.equal(cells[2], "10 contributors, 10 private repos (unlimited public)");
    assert.equal(cells[5], "✓ 10 repos");
    assert.ok(card("Semgrep —").includes("10 contributors, 10 private repos, unlimited public repos."));
  });

  it("gives SonarQube Cloud its free private allowance and language coverage", () => {
    const cells = row("main-comparison", "SonarCloud");
    assert.equal(cells[2], "Free for public projects; private up to 50k LOC");
    assert.equal(cells[5], "✓ Up to 50k LOC");
    assert.ok(card("SonarCloud / SonarQube —").includes("SonarQube Cloud (formerly SonarCloud) is free for open-source projects and for private projects up to 50k lines of code, with code quality, security analysis and CI/CD integration across 40+ languages and frameworks. Larger private codebases can self-host SonarQube Community Edition (free, open source)."));
  });

  it("distinguishes CodeQL's queries, CLI terms and private repository purchase", () => {
    assert.equal(row("main-comparison", "CodeQL")[3], "● Queries MIT; CLI under GitHub's CodeQL terms");
    assert.ok(card("CodeQL —").includes("Free for public repos; private repos need GitHub Code Security, $30 per active committer a month, sold on GitHub Team and Enterprise plans."));
    assert.equal(card("CodeQL is free only on public repositories"), "CodeQL scans public repositories free with no limits. For private repositories it needs GitHub Code Security at $30 per active committer a month, which GitHub sells only on its Team and Enterprise plans. SonarQube Cloud's free plan covers private projects up to 50k lines of code. For larger private codebases, Semgrep's open-source CLI has no repository limit.");
  });

  it("uses TruffleHog's AGPL licence in its row and card", () => {
    assert.equal(row("main-comparison", "TruffleHog")[3], "✓ AGPL-3.0");
    assert.match(card("TruffleHog —"), /^Open-source \(AGPL-3\.0\) with a unique advantage:/);
    assert.doesNotMatch(card("TruffleHog —"), /Apache/i);
  });

  it("updates GitGuardian's secret types and preserves its free team and history limits", () => {
    assert.equal(row("main-comparison", "GitGuardian")[2], "25 devs, 550+ secret types, unlimited real-time, 500 historical");
    assert.ok(card("GitGuardian —").includes("Free for up to 25 developers with 550+ secret types detected, unlimited real-time scanning, and 500 historical scan detections."));
  });

  it("retains StackHawk's historical allowance under the corrected removal period", () => {
    assert.equal(row("main-comparison", "StackHawk")[2], "Removed mid-2024 — was 1 app, unlimited scans");
    assert.ok(plain(html).includes("removed its free Developer plan in mid-2024 and now starts at $10/user/month."));
  });

  it("withdraws the superseded StackHawk date and sales-only claim", () => {
    for (const text of ["dated 2026-04-12", "enterprise sales model"]) {
      assert.ok(!html.toLowerCase().includes(text.toLowerCase()), text);
      assert.ok(!plain(html).toLowerCase().includes(text.toLowerCase()), text);
    }
  });

  it("distinguishes StackHawk's self-serve Wingman trial from Scale sales", () => {
    assert.ok(card("StackHawk is no longer a free option").includes("StackHawk's free plan ended in mid-2024. Wingman is self-serve: it starts with a 14-day free trial without a credit card and converts to $10/user/month for unlimited apps and 50 scans per user per month. Scale requires contacting StackHawk's sales team."));
  });

  it("gives Socket.dev unlimited repositories with one developer seat and a scan cap", () => {
    const cells = row("main-comparison", "Socket.dev");
    assert.equal(cells[2], "1 dev seat, unlimited repos, 1,000 scans/mo");
    assert.equal(cells[5], "✓ Unlimited");
    assert.ok(card("Socket.dev —").includes("The Free plan covers 1 dev seat, unlimited repositories and 1,000 scans a month."));
  });

  it("marks SOOS shut down and its CI integration historical", () => {
    const cells = row("main-comparison", "SOOS");
    assert.equal(cells[2], "Shut down in 2026 (soos.io returns HTTP 410)");
    assert.equal(cells[4], "Was included");
  });

  it("states Twingate's user and resource limits in its row and card", () => {
    assert.equal(row("main-comparison", "Twingate")[2], "5 users, 50 Resources");
    assert.ok(card("Twingate —").includes("Starter plan free forever: 5 users, 50 Resources."));
  });

  it("requires Gitleaks' free key for organization repositories", () => {
    assert.ok(card("Gitleaks —").includes("The GitHub Action is free; repositories owned by a GitHub organization need a free license key from gitleaks.io."));
  });

  it("gives each paid cost cell its vendor, plan and billing unit", () => {
    const expected = [
      ["SAST", "Semgrep Code $30/contributor/mo"],
      ["SCA", "Snyk Team from $25/mo (up to 10 devs)"],
      ["DAST", "StackHawk Wingman $10/user/mo"],
      ["Secrets", "Semgrep Secrets $15/contributor/mo"],
      ["Container", "Snyk Team from $25/mo (up to 10 devs)"],
      ["IaC", "Snyk Team from $25/mo (up to 10 devs)"],
      ["Total", "Per-developer or per-team list prices; GitGuardian Business on request"],
    ];
    assert.deepEqual(table("cost-trap").map(cells => [cells[0], cells[3]]), expected);
    assert.ok(plain(html).includes("The open-source tools cost $0 to run yourself. Hosted paid plans are priced per developer or per team. Semgrep Teams costs $30 a month per contributor for Code or Supply Chain and $15 for Secrets. StackHawk Wingman costs $10 per user a month. Snyk Team starts at $25 a month for teams of up to 10 developers. GitGuardian prices its Business plan on request."));
    assert.ok(plain(html).includes("The price difference buys convenience, not capability."));
    assert.ok(plain(html).includes("CodeQL is free on public repositories, and private code needs GitHub Code Security at $30 per active committer a month. SonarQube Cloud is free for public projects and for private projects up to 50k lines of code."));
  });

  it("states private repository prices without an unsupported annual minimum", () => {
    assert.ok(plain(html).includes("If it's private, CodeQL costs $30 per active committer a month and SonarQube Cloud charges past 50k lines of code."));
  });

  it("withdraws the unsupported hosted total from both state-of-free-tiers passages", () => {
    assert.doesNotMatch(state, /\$23K|73K/i);
    assert.ok(plain(state).includes("a $0 OSS stack matches paid hosted plans on capability."));
    assert.ok(plain(state).includes("matches the capability of paid hosted platforms."));
  });

  it("preserves the other free limits and open-source licences", () => {
    assert.equal(row("main-comparison", "Snyk")[2], "200 SCA + 100 SAST + 100 container + 300 IaC tests/mo");
    assert.equal(row("main-comparison", "Snyk")[5], "✓ Up to 5 projects");
    assert.equal(row("main-comparison", "FOSSA")[2], "5 projects, 10 devs, 1 release group");
    assert.equal(row("main-comparison", "aikido.dev")[2], "2 users, SAST + SCA + CSPM + DAST + Secrets + IaC + Container");
    assert.equal(row("main-comparison", "Tailscale")[2], "6 users, unlimited devices, MagicDNS");
    assert.equal(row("main-comparison", "Let's Encrypt")[2], "Unlimited free certificates");
    for (const name of ["Trivy", "Grype", "Checkov", "OWASP ZAP", "Falco"]) assert.equal(row("main-comparison", name)[3], "✓ Apache-2.0");
    for (const name of ["Gitleaks", "Nuclei"]) assert.equal(row("main-comparison", name)[3], "✓ MIT");
    assert.equal(row("main-comparison", "Semgrep")[3], "✓ LGPL-2.1");
    assert.equal(row("main-comparison", "Renovate")[3], "✓ AGPL-3.0");
  });
});
