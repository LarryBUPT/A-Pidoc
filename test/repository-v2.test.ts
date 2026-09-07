import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import { scanRepository } from "../src/repository/scanner.js";
import { buildRepositoryTasks, generateRepositoryPatchPlans, generateRepositoryTestPlans, runRepositoryTasks } from "../src/repository/workflow.js";

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
