import { randomUUID } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { userInfo } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { registerFauxProvider, streamSimple } from "@earendil-works/pi-ai/compat";
import { ApiHarnessRuntime } from "../dist/src/api-harness/runtime.js";
import { createDiagnosticSandbox, RuntimeApiBackend, RepositoryContractBackend, fingerprint } from "../dist/src/api-harness/tool-bundles.js";
import { TrajectoryStore } from "../dist/src/harness/trajectory-store.js";

const args = process.argv.slice(2);
if (args.some(arg => arg !== "--migration") || args.length > 1) {
  console.error("用法：npm run demo:harness [-- --migration]");
  process.exit(1);
}
const migration = args.includes("--migration");
const profile = migration ? "repository-contract" : "runtime-api";
const call = (name, parameters, id) => fauxAssistantMessage(fauxToolCall(name, parameters, { id }));
let cursor = 0;
function showSteps(snapshot) {
  for (const step of snapshot.run.steps.slice(cursor)) {
    if (step.kind === "tool_call") console.log(`  调用 ${step.data.name} ${JSON.stringify(step.data.args)}`);
    if (step.kind === "tool_result") console.log(`    ${step.data.isError ? "未执行或失败" : "已执行"}：${step.data.name}`);
    if (step.kind === "approval" && step.data.type === "pending") console.log(`  等待用户审批：${step.data.toolName}`);
    if (step.kind === "approval" && step.data.type === "consumed") console.log(`  准确参数已重发，审批已消费：${step.data.toolName}`);
    if (step.kind === "state_transition" && step.data.type === "evidence_gate") console.log(`  证据门禁：${step.data.status} ${step.data.reasons.join(", ")}`);
  }
  cursor = snapshot.run.steps.length;
  console.log(`  当前状态：${snapshot.run.state}；证据数：${snapshot.run.evidence.length}`);
}

console.log("API Doctor · Harness 免密钥演示");
console.log("模型决策与语义复核使用预设演示响应，不调用公网模型；工具、审批和证据门禁真实执行。");
await mkdir(resolve(".private/runs"), { recursive: true });
const directory = await mkdtemp(resolve(".private/runs/harness-demo-"));
const store = new TrajectoryStore(join(directory, "run.json"));
console.log(`运行记录目录：${directory}`);
const provider = registerFauxProvider({ provider: `harness-demo-${randomUUID()}`, models: [{ id: "scripted-demo", input: ["text"] }] });
let sandbox;
let input;
let lines;
try {
  let backend, policy, source, originalDigest;
  const workspace = join(directory, "workspace");
  if (migration) {
    source = join(directory, "source");
    await cp(resolve("test/fixtures/repository-v3-migration"), source, { recursive: true });
    originalDigest = await fingerprint(source);
    const previous = JSON.parse(await readFile(join(source, "old.json"), "utf8"));
    const next = JSON.parse(await readFile(join(source, "new.json"), "utf8"));
    backend = new RepositoryContractBackend(store, source, workspace, previous, next);
    policy = { hosts: [], ports: [], environments: ["sandbox"], credentialScopes: [] };
    console.log("场景：接口 amount 字段由字符串改为数字，调查调用影响并在独立副本中验证迁移。");
    provider.setResponses([
      call("scan_repository", {}, "scan"),
      call("compare_contracts", {}, "diff"),
      call("analyze_contract_impact", { contractDiffId: "contract_diff-diff" }, "impact"),
      call("propose_patch", { impactId: "contract_impact-impact" }, "proposal"),
      call("apply_patch_isolated", { proposalId: "patch_proposal-proposal" }, "pending-patch")
    ]);
    // Start reading before the run so piped input and EOF are both handled.
    input = createInterface({ input: process.stdin, terminal: false });
    lines = input[Symbol.asyncIterator]();
  } else {
    sandbox = await createDiagnosticSandbox();
    backend = new RuntimeApiBackend(sandbox.endpoint);
    policy = { hosts: ["127.0.0.1"], ports: [Number(new URL(sandbox.endpoint).port)], environments: ["sandbox"], credentialScopes: [] };
    console.log("场景：本地订单验证接口返回 415，读取接口约定后修正 Content-Type 并重试。");
    provider.setResponses([
      call("execute_http", { url: sandbox.endpoint, method: "POST", contentType: "text/plain", amount: 42 }, "before"),
      call("read_api_document", {}, "doc"),
      call("execute_http", { url: sandbox.endpoint, method: "POST", contentType: "application/json", amount: 42 }, "after"),
      call("submit_completion", { package: {
        claimRefs: [{ claim: "Correct media type yielded HTTP 200", evidenceIds: ["api_operation-doc", "http_observation-after"] }],
        httpObservationIds: ["http_observation-before", "http_observation-after"]
      } }, "finish")
    ]);
  }
  const actor = userInfo().username;
  const identity = { actorId: actor, source: "local-os-cli" };
  const runtime = new ApiHarnessRuntime(store, backend, policy,
    { model: provider.getModel(), streamFn: streamSimple },
    value => value.actorId === actor && value.source === "local-os-cli",
    async () => ({ verdict: "pass", reasons: ["Scripted demo semantic review; not live model review. Actual evidence gate remains required."] }));
  let snapshot = await runtime.start({
    id: randomUUID(), goal: migration ? "Investigate and verify the registered isolated contract migration with approvals." : "Investigate the failing local request and validate a corrected request with actual HTTP evidence.",
    taskFamily: profile, environment: "sandbox", inputArtifacts: [], allowedToolBundles: [profile, "shared"], risk: migration ? "high" : "low",
    budget: { maxModelCalls: 20, maxToolCalls: 40, maxTokens: 80_000, maxCostUsd: 1, maxDurationMs: 180_000 }
  });
  showSteps(snapshot);
  while (snapshot.run.state === "waiting_approval") {
    const pending = snapshot.pendingApproval;
    const patch = pending.toolName === "apply_patch_isolated";
    if (!patch && pending.toolName !== "run_regression_tests") throw new Error("演示遇到未预期的审批操作");
    console.log(`\n审批 ID：${pending.approvalId}`);
    console.log(`操作参数：${JSON.stringify(snapshot.approvedArgs)}`);
    if (patch) {
      console.log(`修改提案：${JSON.stringify(snapshot.artifacts["patch_proposal-proposal"].data, null, 2)}`);
      console.log(`将创建隔离目录：${workspace}`);
    } else {
      console.log(`将在 ${workspace} 生成固定契约断言并运行 Node 测试子进程。`);
    }
    process.stdout.write("批准这项操作？输入 yes 批准；其他输入或输入结束均拒绝 [默认拒绝]：");
    const answer = await lines.next();
    if (answer.done || answer.value.trim().toLowerCase() !== "yes") {
      await runtime.guardrail.approvals.deny(pending.approvalId, identity);
      snapshot = await store.load();
      console.log("\n已拒绝本项操作，任务停止；此前已批准的操作不会回滚。");
      showSteps(snapshot);
      break;
    }
    await runtime.guardrail.grant(pending.approvalId, identity);
    provider.setResponses(patch ? [
      call("apply_patch_isolated", { proposalId: "patch_proposal-proposal" }, "patch"),
      call("run_regression_tests", { patchArtifactId: "isolated_patch-patch" }, "pending-tests")
    ] : [
      call("run_regression_tests", { patchArtifactId: "isolated_patch-patch" }, "tests"),
      call("submit_completion", { package: {
        claimRefs: [{ claim: "Isolated amount literal migrated and generated contract test passed", evidenceIds: ["isolated_patch-patch", "test_run-tests"] }],
        httpObservationIds: [], contractDiffId: "contract_diff-diff", patchArtifactId: "isolated_patch-patch", testRunId: "test_run-tests", testExitCode: 0
      } }, "finish")
    ]);
    snapshot = await runtime.resume();
    showSteps(snapshot);
  }
  const sourcePreserved = migration ? await fingerprint(source) === originalDigest : null;
  if (migration) console.log(`源样例未改变：${sourcePreserved}`);
  for (const ref of snapshot.run.evidence) {
    const data = snapshot.artifacts[ref.id].data;
    console.log(`证据 ${ref.id}${data.response ? `：HTTP ${data.response.status}` : ""}${ref.kind === "test_run" ? `：退出码 ${data.exitCode}，测试数 ${data.testCount}` : ""}`);
  }
  const report = { profile, modelMode: "scripted-demo", reviewerMode: "scripted-demo", liveEvidence: false, actualToolExecution: true,
    runId: snapshot.run.runId, state: snapshot.run.state, usage: snapshot.run.usage, sourcePreserved,
    evidence: snapshot.run.evidence, finalArtifact: snapshot.run.finalArtifact ?? null };
  const reportFile = join(directory, "report.json");
  await writeFile(reportFile, JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
  console.log(`\n摘要：${reportFile}\n完整工具轨迹与证据：${store.file}`);
  if (!migration) console.log("下一步：npm run demo:harness -- --migration（体验逐项审批与隔离验证）");
  console.log("真实模型调查：配置 .env 后使用 agent-run，见 docs/guides/model-setup.md。");
  if (["failed", "unresolved"].includes(snapshot.run.state) || snapshot.run.state === "blocked" && snapshot.pendingApproval?.status !== "denied" || sourcePreserved === false) process.exitCode = 1;
} finally {
  input?.close();
  provider.unregister();
  await sandbox?.close();
}
