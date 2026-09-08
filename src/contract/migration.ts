import { spawn } from "node:child_process";
import { access, cp, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { scanRepository } from "../repository/scanner.js";
import type { RepositoryTestRun } from "../repository/types.js";
import { analyzeContractImpact, generateMigrationPatchPlans } from "./impact-analysis.js";
import type { ContractChange, ContractVerificationReport, MigrationPatchPlan } from "./types.js";
import { TraceRecorder } from "../observability/trace.js";

async function exists(path: string): Promise<boolean> { try { await access(path); return true; } catch { return false; } }
function safeFile(root: string, file: string): string { const target = resolve(root, file); const relation = relative(root, target); if (relation === "" || relation.startsWith("..") || isAbsolute(relation)) throw new Error(`Unsafe migration artifact path: ${file}`); return target; }
function assertWorkspace(source: string, workspace: string): void { if (source === workspace) throw new Error("Migration workspace must differ from source root"); const relation = relative(source, workspace); if (!isAbsolute(relation) && relation && !relation.startsWith("..") && !relation.startsWith(`..${sep}`)) throw new Error("Migration workspace must be outside the source repository"); }
async function applyMigrationPatch(root: string, plan: MigrationPatchPlan): Promise<void> { const file = safeFile(root, plan.file); const source = await readFile(file, "utf8"); const count = source.split(plan.before).length - 1; if (count !== 1) throw new Error(`Migration patch expected one occurrence in ${plan.file}, found ${count}`); await writeFile(file, source.replace(plan.before, plan.after), "utf8"); }
function fieldName(path: string | null): string | null { return path?.startsWith("$.") && !path.includes("[]") && !path.slice(2).includes(".") ? path.slice(2) : null; }
function testContent(title: string, body: Record<string, unknown> | null, changes: ContractChange[]): string {
  const assertions: string[] = [];
  for (const change of changes) { const name = fieldName(change.fieldPath); if (!name || change.location !== "request") continue; if (change.kind === "REQUEST_FIELD_TYPE_CHANGED") assertions.push(`assert.equal(typeof body[${JSON.stringify(name)}], ${JSON.stringify(change.after)});`); if (change.kind === "REQUEST_FIELD_ADDED" && change.breaking || change.kind === "REQUEST_FIELD_REQUIRED_CHANGED" && change.after === true) assertions.push(`assert.ok(Object.hasOwn(body, ${JSON.stringify(name)}));`); if (change.kind === "REQUEST_FIELD_REMOVED") assertions.push(`assert.equal(Object.hasOwn(body, ${JSON.stringify(name)}), false);`); }
  return `import test from "node:test";\nimport assert from "node:assert/strict";\n\ntest(${JSON.stringify(title)}, () => {\n  const body = ${JSON.stringify(body)};\n  ${assertions.join("\n  ")}\n});\n`;
}
async function runTests(root: string, files: string[], timeoutMs: number): Promise<RepositoryTestRun> {
  const started = Date.now(); const args = ["--test", ...files.map((file) => safeFile(root, file))];
  if (files.length === 0) return { command: [process.execPath, ...args], exitCode: null, durationMs: 0, stdout: "", stderr: "No contract tests were generated", passed: false };
  return await new Promise((done) => { const child = spawn(process.execPath, args, { cwd: root, windowsHide: true }); let stdout = ""; let stderr = ""; let timedOut = false; const timer = setTimeout(() => { timedOut = true; child.kill(); }, timeoutMs); child.stdout.on("data", (chunk) => { if (stdout.length < 65_536) stdout += String(chunk); }); child.stderr.on("data", (chunk) => { if (stderr.length < 65_536) stderr += String(chunk); }); child.on("close", (exitCode) => { clearTimeout(timer); if (timedOut) stderr += "\nContract tests timed out"; done({ command: [process.execPath, ...args], exitCode, durationMs: Date.now() - started, stdout, stderr, passed: !timedOut && exitCode === 0 }); }); });
}

export async function verifyContractMigration(options: { root: string; workspace: string; previousDocument: unknown; nextDocument: unknown; approved: boolean; timeoutMs?: number }): Promise<ContractVerificationReport> {
  if (!options.approved) throw new Error("Contract migration requires explicit approval");
  const trace = new TraceRecorder(); const sourceRoot = await realpath(resolve(options.root)); const workspaceRoot = resolve(options.workspace); assertWorkspace(sourceRoot, workspaceRoot); if (await exists(workspaceRoot)) throw new Error("Migration workspace already exists");
  const before = await trace.span("contract_impact_before", () => analyzeContractImpact({ root: sourceRoot, previousDocument: options.previousDocument, nextDocument: options.nextDocument })); const patches = generateMigrationPatchPlans(before);
  await trace.span("copy_isolated_workspace", () => cp(sourceRoot, workspaceRoot, { recursive: true }), { patches: patches.length });
  await trace.span("apply_migration_patches", async () => { for (const patch of patches) await applyMigrationPatch(workspaceRoot, patch); }, { patches: patches.length });
  const after = await trace.span("contract_impact_after", () => analyzeContractImpact({ root: workspaceRoot, previousDocument: options.previousDocument, nextDocument: options.nextDocument })); const repository = await scanRepository({ root: workspaceRoot, openApiDocument: options.previousDocument }); const files: string[] = [];
  await trace.span("generate_contract_tests", async () => { for (const call of repository.apiCalls) { if (!call.openApiOperation) continue; const changes = after.diff.changes.filter((change) => change.operation === call.openApiOperation); if (!changes.some((change) => change.location === "request")) continue; const file = `.a-pidoc/contract/${call.file.replace(/[^A-Za-z0-9]+/g, "-")}-${call.line}.test.mjs`; const target = safeFile(workspaceRoot, file); await mkdir(dirname(target), { recursive: true }); await writeFile(target, testContent(`${call.method} ${call.url} matches the next request contract`, call.body, changes), "utf8"); files.push(file); } }, { calls: repository.apiCalls.length });
  const testRun = await trace.span("run_contract_tests", () => runTests(workspaceRoot, files, options.timeoutMs ?? 10_000), { tests: files.length }); const passed = patches.length > 0 && testRun.passed && after.impacts.length < before.impacts.length;
  return { sourceRoot, workspaceRoot, before, after, appliedPatches: patches, writtenTests: files, testRun, trace: trace.snapshot(), passed };
}
