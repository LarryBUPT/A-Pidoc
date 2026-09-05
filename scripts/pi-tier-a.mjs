import { spawnSync } from "node:child_process";

const runs = 3;
const results = [];

for (let index = 1; index <= runs; index += 1) {
  const started = performance.now();
  const result = spawnSync(process.execPath, ["--test", "dist/test/pi-reasoner.test.js"], {
    encoding: "utf8"
  });
  results.push({
    run: index,
    passed: result.status === 0,
    durationMs: Math.round(performance.now() - started)
  });
  if (result.status !== 0) {
    process.stderr.write(result.stdout);
    process.stderr.write(result.stderr);
    break;
  }
}

console.table(results);
const passed = results.length === runs && results.every((result) => result.passed);
console.log(`Pi Tier A stability: ${results.filter((result) => result.passed).length}/${runs} runs passed`);
if (!passed) process.exitCode = 1;
