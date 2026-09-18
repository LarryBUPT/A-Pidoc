import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { RunSnapshot } from "../src/harness/trajectory-store.js";

function demo(args: string[] = [], input = "") {
  const result = spawnSync(process.execPath, ["scripts/harness-demo.mjs", ...args], {
    encoding: "utf8", input, timeout: 30_000, windowsHide: true
  });
  assert.equal(result.status, 0, `${result.error ?? ""}\n${result.stdout}\n${result.stderr}`);
  const directory = result.stdout.match(/运行记录目录：([^\r\n]+)/)?.[1];
  assert.ok(directory);
  const snapshot = JSON.parse(readFileSync(join(directory, "run.json"), "utf8")) as RunSnapshot;
  const report = JSON.parse(readFileSync(join(directory, "report.json"), "utf8"));
  assert.equal(report.modelMode, "scripted-demo");
  assert.equal(report.reviewerMode, "scripted-demo");
  assert.equal(report.liveEvidence, false);
  return { directory, snapshot, report, output: result.stdout };
}

test("免密钥 Harness 入口执行真实 HTTP 并通过证据门禁", () => {
  const { snapshot, output } = demo();
  assert.equal(snapshot.run.state, "resolved");
  assert.ok(snapshot.run.finalArtifact);
  assert.match(output, /http_observation-before：HTTP 415/);
  assert.match(output, /http_observation-after：HTTP 200/);
  assert.equal(snapshot.run.evidence.length, 3);
});

test("迁移演示两项明确审批后执行隔离修改和真实测试", () => {
  const { directory, snapshot, report } = demo(["--migration"], "yes\nyes\n");
  assert.equal(snapshot.run.state, "resolved");
  assert.equal(report.sourcePreserved, true);
  assert.equal(snapshot.run.steps.filter(step => step.kind === "approval" && (step.data as { type?: string }).type === "consumed").length, 2);
  const tests = snapshot.artifacts["test_run-tests"] as { data: { exitCode: number; testCount: number } };
  assert.equal(tests.data.exitCode, 0);
  assert.equal(tests.data.testCount, 1);
  assert.match(readFileSync(join(directory, "workspace/src/client.ts"), "utf8"), /amount: 42/);
});

test("迁移演示输入结束默认拒绝，未获批准时不创建隔离工作区", () => {
  const { directory, snapshot, report } = demo(["--migration"]);
  assert.equal(snapshot.run.state, "blocked");
  assert.equal(snapshot.pendingApproval?.status, "denied");
  assert.equal(snapshot.workspaceRevision, 0);
  assert.equal(report.sourcePreserved, true);
  assert.equal(existsSync(join(directory, "workspace")), false);
});

test("批准修改但拒绝测试时不运行测试也不宣称完成", () => {
  const { snapshot, report } = demo(["--migration"], "yes\nno\n");
  assert.equal(snapshot.run.state, "blocked");
  assert.equal(snapshot.pendingApproval?.toolName, "run_regression_tests");
  assert.equal(snapshot.pendingApproval?.status, "denied");
  assert.equal(snapshot.workspaceRevision, 1);
  assert.equal(snapshot.run.evidence.some(ref => ref.kind === "test_run"), false);
  assert.equal(snapshot.run.finalArtifact, undefined);
  assert.equal(report.sourcePreserved, true);
});
