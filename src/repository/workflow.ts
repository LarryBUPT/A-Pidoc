import type { DebugReport, DebugTask, HttpTool, Reasoner } from "../domain/types.js";
import { DebugOrchestrator } from "../core/orchestrator.js";
import { parseOpenApiOperation } from "../input/openapi-parser.js";
import type { RepositoryFindingCode, RepositoryPatchPlan, RepositoryReport, RepositoryTask, RepositoryTestPlan } from "./types.js";

export interface RepositoryBatchResult {
  mode: "dry-run" | "execute";
  planned: number;
  skipped: number;
  reports: DebugReport[];
  blocked: Array<{ taskId: string; reason: string }>;
}

function findingsFor(report: RepositoryReport, file: string, line: number): RepositoryFindingCode[] {
  return report.findings.filter((finding) => finding.file === file && finding.line === line).map((finding) => finding.code);
}

function debugTaskFor(call: RepositoryReport["apiCalls"][number], document: unknown): DebugTask | null {
  if (!call.openApiOperation) return null;
  const split = call.openApiOperation.indexOf(" ");
  const method = call.openApiOperation.slice(0, split);
  const path = call.openApiOperation.slice(split + 1);
  try {
    const parsed = parseOpenApiOperation(document, {
      path,
      method,
      serverUrl: new URL(call.url).origin,
      headers: call.headers,
      body: call.body,
      id: `repository:${call.file}:${call.line}`
    });
    return { ...parsed.task, title: `${call.client} ${call.method} ${call.url}`, request: { ...parsed.task.request, url: call.url } };
  } catch {
    return null;
  }
}

export function buildRepositoryTasks(report: RepositoryReport, document: unknown): RepositoryTask[] {
  return report.apiCalls.map((call) => ({
    id: `repository:${call.file}:${call.line}`,
    call,
    findingCodes: findingsFor(report, call.file, call.line),
    debugTask: debugTaskFor(call, document)
  }));
}

export function generateRepositoryTestPlans(tasks: RepositoryTask[]): RepositoryTestPlan[] {
  return tasks.filter((task) => task.debugTask).map((task) => {
    const safe = task.id.replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "").toLowerCase();
    const request = JSON.stringify(task.debugTask!.request, null, 2);
    return {
      path: `.a-pidoc/generated/${safe}.test.ts`,
      callId: task.id,
      rationale: "Generated from a literal client call matched to an OpenAPI operation; execute only after review.",
      content: `import test from "node:test";\nimport assert from "node:assert/strict";\n\ntest(${JSON.stringify(task.debugTask!.title)}, async () => {\n  const request = ${request};\n  assert.match(request.url, /^https?:\\/\\//);\n  assert.equal(request.method, ${JSON.stringify(task.debugTask!.request.method)});\n});\n`
    };
  });
}

export function generateRepositoryPatchPlans(report: RepositoryReport): RepositoryPatchPlan[] {
  return report.findings.filter((finding) => finding.code === "ENV_NOT_DECLARED").map((finding) => ({
    file: ".env.example",
    line: 1,
    title: `Declare ${finding.message.split(" ")[0]} in the environment template`,
    before: "",
    after: `${finding.message.split(" ")[0]}=replace-me`,
    verification: ["rg -n '^NAME=' .env.example", "npm run repo:plan"],
    requiresApproval: true
  }));
}

export async function runRepositoryTasks(
  tasks: RepositoryTask[],
  options: { execute?: boolean; orchestrator?: DebugOrchestrator } = {}
): Promise<RepositoryBatchResult> {
  const execute = options.execute === true;
  const runnable = tasks.filter((task) => task.debugTask && task.findingCodes.every((code) => code !== "DYNAMIC_URL_UNSUPPORTED" && code !== "OPENAPI_OPERATION_MISSING"));
  const blocked = tasks.filter((task) => !task.debugTask || task.findingCodes.some((code) => code === "DYNAMIC_URL_UNSUPPORTED" || code === "OPENAPI_OPERATION_MISSING"))
    .map((task) => ({ taskId: task.id, reason: task.debugTask ? "requires review before execution" : "no OpenAPI operation" }));
  if (!execute) return { mode: "dry-run", planned: runnable.length, skipped: tasks.length - runnable.length, reports: [], blocked };
  if (!options.orchestrator) throw new Error("Explicit execution requires an approved orchestrator");
  const reports: DebugReport[] = [];
  for (const task of runnable) reports.push(await options.orchestrator.run(task.debugTask!));
  return { mode: "execute", planned: runnable.length, skipped: tasks.length - runnable.length, reports, blocked };
}

export function repositoryOrchestratorGuard(httpTool: HttpTool, reasoner: Reasoner): DebugOrchestrator {
  return new DebugOrchestrator(httpTool, reasoner);
}
