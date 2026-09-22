import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

test("Issue #80 local audit metadata contracts pass within the existing unit gate", () => {
  // Node's test runner marks nested processes as workers unless this marker is removed.
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const result = spawnSync(process.execPath, ["--test", "--test-concurrency=1", resolve("test/audit-workflow.test.mjs")], {
    cwd: process.cwd(),
    encoding: "utf8",
    timeout: 60_000,
    env
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /(?:#|ℹ) tests 34\b/, "嵌套审计测试未实际运行 34 项");
});
