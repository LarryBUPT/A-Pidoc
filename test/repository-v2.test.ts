import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import test from "node:test";
import { scanRepository } from "../src/repository/scanner.js";
import { buildRepositoryTasks, generateRepositoryPatchPlans, generateRepositoryTestPlans, runRepositoryTasks, verifyRepositoryPlan } from "../src/repository/workflow.js";
import { evaluateRepositories } from "../src/evaluation/repository-eval.js";

const root = resolve("test/fixtures/repository-v2");
async function document(): Promise<unknown> { return JSON.parse(await readFile(resolve(root, "openapi.json"), "utf8")); }

test("V2 scans Fetch, Axios, Requests and OkHttp with bounded findings", async () => {
  const report = await scanRepository({ root, openApiDocument: await document() });
  assert.equal(report.apiCalls.length, 4);
  assert.deepEqual(new Set(report.apiCalls.map((call) => call.client)), new Set(["fetch", "axios", "requests", "okhttp"]));
  assert.equal(report.summary.matchedOperations, 4);
  assert.equal(report.findings.filter((finding) => finding.code === "DYNAMIC_URL_UNSUPPORTED").length, 1);
  assert.equal(report.findings.filter((finding) => finding.code === "ENV_NOT_DECLARED").length, 1);
});

test("V2 builds reviewable debug tasks, test plans and patch plans", async () => {
  const report = await scanRepository({ root, openApiDocument: await document() });
  const tasks = buildRepositoryTasks(report, await document());
  assert.equal(tasks.filter((task) => task.debugTask).length, 4);
  assert.equal(generateRepositoryTestPlans(tasks).length, 4);
  assert.equal(generateRepositoryPatchPlans(report).length, 1);
  assert.match(generateRepositoryTestPlans(tasks)[0]!.content, /assert\.match/);
  assert.equal(report.apiCalls.find((call) => call.client === "fetch")?.headers.Authorization, "[REDACTED]");
  assert.doesNotMatch(JSON.stringify(report), /Bearer token/);
  assert.equal(report.apiCalls.find((call) => call.client === "fetch")?.body?.sku, "A-1");
});

test("V2 resolves an imported URL constant and keeps a source chain", async () => {
  const repairRoot = resolve("test/fixtures/repository-v2-repair");
  const spec = JSON.parse(await readFile(resolve(repairRoot, "openapi.json"), "utf8"));
  const report = await scanRepository({ root: repairRoot, openApiDocument: spec });
  const imported = report.apiCalls.find((call) => call.client === "axios");
  assert.equal(imported?.url, "https://api.example.test/users");
  assert.equal(imported?.sources.url.kind, "import");
  assert.deepEqual(imported?.sources.url.chain, [{ file: "src/shared.ts", line: 1 }]);
});

test("V2 applies approved patches and runs generated tests only in an isolated copy", async (context) => {
  const repairRoot = resolve("test/fixtures/repository-v2-repair");
  const spec = JSON.parse(await readFile(resolve(repairRoot, "openapi.json"), "utf8"));
  const parent = await mkdtemp(join(tmpdir(), "a-pidoc-v2-verify-"));
  context.after(() => rm(parent, { recursive: true, force: true }));
  const workspace = resolve(parent, "workspace");
  const result = await verifyRepositoryPlan({ root: repairRoot, workspace, openApiDocument: spec, approved: true });
  assert.equal(result.before.summary.errors, 1);
  assert.equal(result.before.summary.warnings, 1);
  assert.equal(result.after.summary.errors, 0);
  assert.equal(result.after.summary.warnings, 0);
  assert.equal(result.appliedPatches.length, 2);
  assert.equal(result.writtenTests.length, 2);
  assert.equal(result.testRun.passed, true, result.testRun.stderr);
  assert.equal(result.passed, true);
  assert.match(await readFile(resolve(workspace, "src/client.ts"), "utf8"), /v2\/orders/);
  assert.match(await readFile(resolve(repairRoot, "src/client.ts"), "utf8"), /v1\/orders/);
});

test("V2 verification refuses missing approval and an existing workspace", async (context) => {
  const repairRoot = resolve("test/fixtures/repository-v2-repair");
  const spec = JSON.parse(await readFile(resolve(repairRoot, "openapi.json"), "utf8"));
  await assert.rejects(() => verifyRepositoryPlan({ root: repairRoot, workspace: resolve("ignored"), openApiDocument: spec, approved: false }), /explicit approval/);
  const existing = await mkdtemp(join(tmpdir(), "a-pidoc-v2-existing-"));
  context.after(() => rm(existing, { recursive: true, force: true }));
  await assert.rejects(() => verifyRepositoryPlan({ root: repairRoot, workspace: existing, openApiDocument: spec, approved: true }), /already exists/);
});

test("V2 batch defaults to dry-run and never calls a network tool", async () => {
  const report = await scanRepository({ root, openApiDocument: await document() });
  const tasks = buildRepositoryTasks(report, await document());
  let calls = 0;
  const result = await runRepositoryTasks(tasks, { orchestrator: { run: async () => { calls += 1; throw new Error("must not run"); } } as never });
  assert.equal(result.mode, "dry-run");
  assert.equal(result.planned, 4);
  assert.equal(calls, 0);
});

test("V2 repository evaluation freezes three repositories and four clients", async () => {
  const result = await evaluateRepositories();
  assert.deepEqual(result, {
    passed: true,
    repositories: 3,
    calls: 8,
    unresolvedCalls: 2,
    clients: ["axios", "fetch", "okhttp", "requests"],
    repair: { beforeErrors: 1, afterErrors: 0, testsPassed: true }
  });
});

test("repo-verify CLI executes the isolated verification workflow", async (context) => {
  const repairRoot = resolve("test/fixtures/repository-v2-repair");
  const parent = await mkdtemp(join(tmpdir(), "a-pidoc-v2-cli-"));
  context.after(() => rm(parent, { recursive: true, force: true }));
  const output = await new Promise<{ code: number | null; stdout: string; stderr: string }>((done) => {
    const child = spawn(process.execPath, ["dist/src/cli.js", "repo-verify", "--root", repairRoot, "--document", resolve(repairRoot, "openapi.json"), "--workspace", resolve(parent, "workspace"), "--approved", "true"]);
    let stdout = ""; let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.on("close", (code) => done({ code, stdout, stderr }));
  });
  assert.equal(output.code, 0, output.stderr);
  assert.equal((JSON.parse(output.stdout) as { passed: boolean }).passed, true);
});
