import { spawnSync } from "node:child_process";
const files = ["dist/test/pi-loop-contract.test.js", "dist/test/approval-contract.test.js", "dist/test/workspace-evidence.test.js"];
const results = [];
for (let run = 1; run <= 3; run++) {
  const started = performance.now();
  const result = spawnSync(process.execPath, ["--test", "--test-concurrency=1", ...files], { encoding: "utf8", timeout: 120_000, windowsHide: true });
  results.push({ run, passed: result.status === 0, durationMs: Math.round(performance.now() - started) });
  if (result.status !== 0) { process.stderr.write(result.stdout ?? ""); process.stderr.write(result.stderr ?? ""); break; }
}
const passed = results.length === 3 && results.every(r => r.passed);
console.log(JSON.stringify({ dataset: "harness-contract-v1", provider: "faux", execution: "sequential", liveEvidence: false, passed, results }, null, 2));
if (!passed) process.exitCode = 1;
