import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";

const FROM = Number(process.env.SWEEP_FROM ?? 0);
const TO = Number(process.env.SWEEP_TO ?? 30);
const OUT = process.env.SWEEP_OUT ?? "/tmp/sweep-1780.json";

const results = [];
for (let day = FROM; day <= TO; day++) {
  let output = "";
  let green = true;
  try {
    output = execFileSync("node", ["--test", "--test-concurrency", "1", "test/named-subsets.test.ts"], {
      encoding: "utf-8",
      stdio: "pipe",
      env: { ...process.env, AGENTDEALS_CLOCK_BASE_DAYS: String(day) },
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (err) {
    green = false;
    output = `${err.stdout ?? ""}${err.stderr ?? ""}`;
  }
  const failing = [...output.matchAll(/^✖ (.+?) \(\d/gm)].map(m => m[1]);
  const actuals = [...output.matchAll(/actual: (\[[\s\S]*?\]),\n\s+expected:/g)].map(m => m[1].replace(/\s+/g, " "));
  results.push({ day, green, failing, actuals });
  console.log(`day +${day}: ${green ? "green" : `RED — ${failing.join(" | ")}`}`);
  for (const a of actuals) console.log(`    ${a.slice(0, 600)}`);
  writeFileSync(OUT, JSON.stringify(results, null, 2));
}
const red = results.filter(r => !r.green);
console.log(`\n${red.length} of ${results.length} forward day-pairs red: ${red.map(r => `+${r.day}`).join(", ")}`);
