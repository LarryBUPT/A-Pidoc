import { spawn } from "node:child_process";
import { access, cp, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import type { DebugReport, DebugTask } from "../domain/types.js";
import { DebugOrchestrator } from "../core/orchestrator.js";
import { parseOpenApiOperation } from "../input/openapi-parser.js";
import { scanRepository } from "./scanner.js";
import { redactRequest } from "../security/redaction.js";
import type { RepositoryFindingCode, RepositoryPatchPlan, RepositoryReport, RepositoryTask, RepositoryTestPlan, RepositoryTestRun, RepositoryVerificationReport } from "./types.js";

export interface RepositoryBatchResult {
  mode: "dry-run" | "execute";
  planned: number;
  skipped: number;
  reports: DebugReport[];
  blocked: Array<{ taskId: string; reason: string }>;
}

function findingsFor(report: RepositoryReport, file: string, line: number): RepositoryFindingCode[] { return report.findings.filter((finding) => finding.file === file && finding.line === line).map((finding) => finding.code); }
function debugTaskFor(call: RepositoryReport["apiCalls"][number], document: unknown): DebugTask | null {
  if (!call.openApiOperation) return null; const split = call.openApiOperation.indexOf(" "); const method = call.openApiOperation.slice(0, split); const path = call.openApiOperation.slice(split + 1);
  try { const parsed = parseOpenApiOperation(document, { path, method, serverUrl: new URL(call.url).origin, headers: call.headers, body: call.body, id: `repository:${call.file}:${call.line}` }); return { ...parsed.task, title: `${call.client} ${call.method} ${call.url}`, request: { ...parsed.task.request, url: call.url } }; } catch { return null; }
}
export function buildRepositoryTasks(report: RepositoryReport, document: unknown): RepositoryTask[] { return report.apiCalls.map((call) => ({ id: `repository:${call.file}:${call.line}`, call, findingCodes: findingsFor(report, call.file, call.line), debugTask: debugTaskFor(call, document) })); }

export function generateRepositoryTestPlans(tasks: RepositoryTask[]): RepositoryTestPlan[] {
  return tasks.filter((task) => task.debugTask).map((task) => {
    const safe = task.id.replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "").toLowerCase(); const request = JSON.stringify(redactRequest(task.debugTask!.request), null, 2);
    return { path: `.a-pidoc/generated/${safe}.test.mjs`, callId: task.id, rationale: "Generated from a resolved client call matched to an OpenAPI operation; it checks the normalized contract without network access.", content: `import test from "node:test";\nimport assert from "node:assert/strict";\n\ntest(${JSON.stringify(task.debugTask!.title)}, () => {\n  const request = ${request};\n  assert.match(request.url, /^https?:\\/\\//);\n  assert.equal(request.method, ${JSON.stringify(task.debugTask!.request.method)});\n  assert.equal(new URL(request.url).pathname, ${JSON.stringify(new URL(task.debugTask!.request.url).pathname)});\n});\n` };
  });
}

function operationCandidates(document: unknown, method: string): string[] {
  if (!document || typeof document !== "object" || Array.isArray(document)) return [];
  const paths = (document as Record<string, unknown>).paths; if (!paths || typeof paths !== "object" || Array.isArray(paths)) return [];
  return Object.entries(paths).filter(([, value]) => value && typeof value === "object" && !Array.isArray(value) && method.toLowerCase() in value).map(([path]) => path);
}

export function generateRepositoryPatchPlans(report: RepositoryReport, document?: unknown): RepositoryPatchPlan[] {
  const plans: RepositoryPatchPlan[] = report.findings.filter((finding) => finding.code === "ENV_NOT_DECLARED").map((finding) => { const name = finding.message.split(" ")[0]!; return { kind: "append", findingCode: finding.code, file: ".env.example", line: 1, title: `Declare ${name} in the environment template`, before: "", after: `${name}=replace-me`, verification: [`rg -n '^${name}=' .env.example`, "npm run repo:plan"], requiresApproval: true }; });
  if (document !== undefined) for (const call of report.apiCalls.filter((candidate) => !candidate.openApiOperation && candidate.sources.url.kind === "literal")) {
    const candidates = operationCandidates(document, call.method); if (candidates.length !== 1) continue;
    const oldUrl = new URL(call.url); const replacement = new URL(oldUrl.toString()); replacement.pathname = candidates[0]!;
    plans.push({ kind: "replace", findingCode: "OPENAPI_OPERATION_MISSING", file: call.file, line: call.line, title: `Align ${call.method} URL with ${candidates[0]}`, before: call.url, after: replacement.toString().replace(/\/$/, candidates[0] === "/" ? "/" : ""), verification: ["npm run repo:plan", "node --test .a-pidoc/generated/*.test.mjs"], requiresApproval: true });
  }
  return plans;
}

export async function runRepositoryTasks(tasks: RepositoryTask[], options: { execute?: boolean; orchestrator?: DebugOrchestrator } = {}): Promise<RepositoryBatchResult> {
  const execute = options.execute === true; const runnable = tasks.filter((task) => task.debugTask && task.findingCodes.every((code) => code !== "DYNAMIC_URL_UNSUPPORTED" && code !== "OPENAPI_OPERATION_MISSING")); const blocked = tasks.filter((task) => !task.debugTask || task.findingCodes.some((code) => code === "DYNAMIC_URL_UNSUPPORTED" || code === "OPENAPI_OPERATION_MISSING")).map((task) => ({ taskId: task.id, reason: task.debugTask ? "requires review before execution" : "no OpenAPI operation" }));
  if (!execute) return { mode: "dry-run", planned: runnable.length, skipped: tasks.length - runnable.length, reports: [], blocked };
  if (!options.orchestrator) throw new Error("Explicit execution requires an approved orchestrator"); const reports: DebugReport[] = [];
  for (const task of runnable) reports.push(await options.orchestrator.run(task.debugTask!)); return { mode: "execute", planned: runnable.length, skipped: tasks.length - runnable.length, reports, blocked };
}

function assertWorkspace(sourceRoot: string, workspaceRoot: string): void {
  if (sourceRoot === workspaceRoot) throw new Error("Verification workspace must differ from source root");
  const insideSource = relative(sourceRoot, workspaceRoot); if (!isAbsolute(insideSource) && insideSource && !insideSource.startsWith("..") && !insideSource.startsWith(`..${sep}`)) throw new Error("Verification workspace must be outside the source repository");
}
async function pathExists(path: string): Promise<boolean> { try { await access(path); return true; } catch { return false; } }
function workspaceFile(workspaceRoot: string, file: string): string { const target = resolve(workspaceRoot, file); const relation = relative(workspaceRoot, target); if (relation.startsWith("..") || relation === "") throw new Error(`Unsafe repository artifact path: ${file}`); return target; }

async function applyPatch(workspaceRoot: string, plan: RepositoryPatchPlan): Promise<void> {
  const target = workspaceFile(workspaceRoot, plan.file); await mkdir(dirname(target), { recursive: true }); let source = await pathExists(target) ? await readFile(target, "utf8") : "";
  if (plan.kind === "append") { if (!source.split(/\r?\n/).includes(plan.after)) source = `${source.trimEnd()}${source.trim() ? "\n" : ""}${plan.after}\n`; }
  else { const occurrences = source.split(plan.before).length - 1; if (occurrences !== 1) throw new Error(`Patch expected exactly one occurrence in ${plan.file}, found ${occurrences}`); source = source.replace(plan.before, plan.after); }
  await writeFile(target, source, "utf8");
}

async function runGeneratedTests(workspaceRoot: string, tests: string[], timeoutMs: number): Promise<RepositoryTestRun> {
  const started = Date.now(); const args = ["--test", ...tests.map((file) => workspaceFile(workspaceRoot, file))];
  if (tests.length === 0) return { command: [process.execPath, ...args], exitCode: null, durationMs: 0, stdout: "", stderr: "No repository tests were generated", passed: false };
  return await new Promise((resolveResult) => {
    const child = spawn(process.execPath, args, { cwd: workspaceRoot, windowsHide: true }); let stdout = ""; let stderr = ""; let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, timeoutMs);
    child.stdout.on("data", (chunk) => { if (stdout.length < 65_536) stdout += String(chunk); }); child.stderr.on("data", (chunk) => { if (stderr.length < 65_536) stderr += String(chunk); });
    child.on("close", (exitCode) => { clearTimeout(timer); if (timedOut) stderr += "\nGenerated tests timed out"; resolveResult({ command: [process.execPath, ...args], exitCode, durationMs: Date.now() - started, stdout, stderr, passed: !timedOut && exitCode === 0 }); });
  });
}

export async function verifyRepositoryPlan(options: { root: string; workspace: string; openApiDocument: unknown; approved: boolean; timeoutMs?: number }): Promise<RepositoryVerificationReport> {
  if (!options.approved) throw new Error("Repository verification requires explicit approval"); const sourceRoot = await realpath(resolve(options.root)); const workspaceRoot = resolve(options.workspace); assertWorkspace(sourceRoot, workspaceRoot); if (await pathExists(workspaceRoot)) throw new Error("Verification workspace already exists");
  const before = await scanRepository({ root: sourceRoot, openApiDocument: options.openApiDocument }); const patches = generateRepositoryPatchPlans(before, options.openApiDocument); await cp(sourceRoot, workspaceRoot, { recursive: true }); for (const patch of patches) await applyPatch(workspaceRoot, patch);
  const after = await scanRepository({ root: workspaceRoot, openApiDocument: options.openApiDocument }); const tests = generateRepositoryTestPlans(buildRepositoryTasks(after, options.openApiDocument));
  for (const test of tests) { const target = workspaceFile(workspaceRoot, test.path); await mkdir(dirname(target), { recursive: true }); await writeFile(target, test.content, "utf8"); }
  const testRun = await runGeneratedTests(workspaceRoot, tests.map((test) => test.path), options.timeoutMs ?? 10_000); const passed = testRun.passed && after.summary.errors === 0 && after.summary.warnings <= before.summary.warnings;
  return { sourceRoot, workspaceRoot, before, after, appliedPatches: patches, writtenTests: tests.map((test) => test.path), testRun, passed };
}
