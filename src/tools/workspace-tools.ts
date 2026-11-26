import { execFile } from "node:child_process";
import { cp, lstat, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import { readApiDocument, type JsonObject } from "../shared/api-document.js";
import { sha256Digest } from "../shared/digest.js";
import type { HttpMethod } from "../shared/types.js";
import type { HarnessToolSpec } from "./registry.js";

const execFileAsync = promisify(execFile);

export interface ContractChange {
  id: string;
  operation: string;
  location: "operation" | "request" | "response";
  fieldPath: string;
  kind: "removed" | "added" | "type_changed" | "required_added";
  breaking: boolean;
  previousType?: string;
  nextType?: string;
  detail: string;
}

export interface ContractDiffReport {
  changes: ContractChange[];
  summary: {
    total: number;
    breaking: number;
    nonBreaking: number;
  };
}

export interface ScannedApiCall {
  file: string;
  line: number;
  client: "fetch" | "axios" | "requests" | "okhttp";
  method: HttpMethod;
  url: string;
  bodyText?: string;
  bodyObject?: Record<string, unknown>;
}

export interface PatchProposal {
  file: string;
  line: number;
  field: string;
  before: string;
  after: string;
  reason: string;
}

const IGNORED_DIRS = new Set([".git", "node_modules", "dist", "build", ".private", ".a-pidoc"]);
const SUPPORTED_EXTS = new Set([".ts", ".tsx", ".js", ".mjs", ".py", ".java"]);

function extractRequestFields(doc: JsonObject): Map<string, Map<string, { type: string; required: boolean }>> {
  const result = new Map<string, Map<string, { type: string; required: boolean }>>();
  const paths = (doc.paths ?? {}) as JsonObject;

  for (const [pathKey, rawItem] of Object.entries(paths)) {
    if (!rawItem || typeof rawItem !== "object") continue;
    for (const [methodKey, rawOp] of Object.entries(rawItem as JsonObject)) {
      if (!["get", "post", "put", "patch", "delete"].includes(methodKey.toLowerCase())) continue;
      const opKey = `${methodKey.toUpperCase()} ${pathKey}`;
      const fields = new Map<string, { type: string; required: boolean }>();

      const op = rawOp as JsonObject;
      const body = op.requestBody as JsonObject | undefined;
      const content = body?.content as JsonObject | undefined;
      const jsonMedia = content?.["application/json"] as JsonObject | undefined;
      const schema = jsonMedia?.schema as JsonObject | undefined;
      const props = (schema?.properties ?? {}) as JsonObject;
      const requiredSet = new Set(Array.isArray(schema?.required) ? (schema.required as string[]) : []);

      for (const [fieldName, rawProp] of Object.entries(props)) {
        const prop = (rawProp ?? {}) as JsonObject;
        fields.set(fieldName, {
          type: typeof prop.type === "string" ? prop.type : "unknown",
          required: requiredSet.has(fieldName)
        });
      }

      result.set(opKey, fields);
    }
  }
  return result;
}

/** 清晰版 OpenAPI 语义 Diff：识别接口删除、必填字段新增、请求字段类型变更 */
export function diffOpenApiContracts(previousRaw: unknown, nextRaw: unknown): ContractDiffReport {
  const prevDoc = readApiDocument(previousRaw);
  const nextDoc = readApiDocument(nextRaw);
  const prevOps = extractRequestFields(prevDoc);
  const nextOps = extractRequestFields(nextDoc);
  const changes: ContractChange[] = [];

  for (const [operation, prevFields] of prevOps.entries()) {
    const nextFields = nextOps.get(operation);
    if (!nextFields) {
      changes.push({
        id: `chg_${sha256Digest([operation, "removed"]).slice(0, 10)}`,
        operation,
        location: "operation",
        fieldPath: operation,
        kind: "removed",
        breaking: true,
        detail: `Operation "${operation}" was removed in the next contract.`
      });
      continue;
    }

    for (const [field, prevSpec] of prevFields.entries()) {
      const nextSpec = nextFields.get(field);
      if (!nextSpec) {
        changes.push({
          id: `chg_${sha256Digest([operation, field, "removed"]).slice(0, 10)}`,
          operation,
          location: "request",
          fieldPath: `$.${field}`,
          kind: "removed",
          breaking: false,
          previousType: prevSpec.type,
          detail: `Request field "${field}" removed from ${operation}.`
        });
        continue;
      }

      if (prevSpec.type !== nextSpec.type) {
        changes.push({
          id: `chg_${sha256Digest([operation, field, prevSpec.type, nextSpec.type]).slice(0, 10)}`,
          operation,
          location: "request",
          fieldPath: `$.${field}`,
          kind: "type_changed",
          breaking: true,
          previousType: prevSpec.type,
          nextType: nextSpec.type,
          detail: `Field "${field}" type changed from ${prevSpec.type} to ${nextSpec.type}.`
        });
      }

      if (!prevSpec.required && nextSpec.required) {
        changes.push({
          id: `chg_${sha256Digest([operation, field, "required_added"]).slice(0, 10)}`,
          operation,
          location: "request",
          fieldPath: `$.${field}`,
          kind: "required_added",
          breaking: true,
          nextType: nextSpec.type,
          detail: `Field "${field}" became required in ${operation}.`
        });
      }
    }

    for (const [field, nextSpec] of nextFields.entries()) {
      if (!prevFields.has(field)) {
        changes.push({
          id: `chg_${sha256Digest([operation, field, "added"]).slice(0, 10)}`,
          operation,
          location: "request",
          fieldPath: `$.${field}`,
          kind: nextSpec.required ? "required_added" : "added",
          breaking: nextSpec.required,
          nextType: nextSpec.type,
          detail: `New ${nextSpec.required ? "required " : ""}field "${field}" (${nextSpec.type}) added to ${operation}.`
        });
      }
    }
  }

  const breaking = changes.filter((item) => item.breaking).length;
  return {
    changes,
    summary: {
      total: changes.length,
      breaking,
      nonBreaking: changes.length - breaking
    }
  };
}

/** 受限只读仓库扫描：定位 Fetch / Axios / Python Requests / Java OkHttp 调用点 */
export async function scanRepositoryCalls(rootDir: string): Promise<ScannedApiCall[]> {
  const root = resolve(rootDir);
  const calls: ScannedApiCall[] = [];
  let visitedFiles = 0;

  async function walk(currentDir: string): Promise<void> {
    const entries = await readdir(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      if (visitedFiles >= 200) return;
      const fullPath = join(currentDir, entry.name);
      const stat = await lstat(fullPath);
      if (stat.isSymbolicLink()) continue;

      if (stat.isDirectory()) {
        if (!IGNORED_DIRS.has(entry.name)) {
          await walk(fullPath);
        }
        continue;
      }

      if (!SUPPORTED_EXTS.has(extname(entry.name)) || stat.size > 512_000) continue;
      visitedFiles += 1;

      const content = await readFile(fullPath, "utf8");
      const relFile = relative(root, fullPath).replaceAll("\\", "/");
      const lines = content.split(/\r?\n/);

      for (let index = 0; index < lines.length; index += 1) {
        const lineText = lines[index] ?? "";
        const windowText = lines.slice(index, index + 6).join(" ");

        // Match fetch("https://.../orders", { method: "POST", body: JSON.stringify({ amount: "42" }) })
        const fetchMatch = lineText.match(/fetch\(\s*["'`](https?:\/\/[^"'`]+|\/[^"'`]+)["'`]/);
        if (fetchMatch) {
          const methodMatch = windowText.match(/method\s*:\s*["'`](GET|POST|PUT|PATCH|DELETE)["'`]/i);
          const bodyMatch = windowText.match(/JSON\.stringify\(\s*(\{[^)]+\})\s*\)/);
          const parsedBody = tryParseLooseObject(bodyMatch?.[1]);
          calls.push({
            file: relFile,
            line: index + 1,
            client: "fetch",
            method: (methodMatch?.[1]?.toUpperCase() ?? "GET") as HttpMethod,
            url: fetchMatch[1]!,
            ...(bodyMatch?.[1] ? { bodyText: bodyMatch[1] } : {}),
            ...(parsedBody ? { bodyObject: parsedBody } : {})
          });
          continue;
        }

        // Match axios.post("...", { ... })
        const axiosMatch = lineText.match(/axios\.(get|post|put|patch|delete)\(\s*["'`]([^"'`]+)["'`]/i);
        if (axiosMatch) {
          const bodyMatch = windowText.match(/axios\.(?:post|put|patch)\([^,]+,\s*(\{[^)]+\})/i);
          const parsedBody = tryParseLooseObject(bodyMatch?.[1]);
          calls.push({
            file: relFile,
            line: index + 1,
            client: "axios",
            method: axiosMatch[1]!.toUpperCase() as HttpMethod,
            url: axiosMatch[2]!,
            ...(bodyMatch?.[1] ? { bodyText: bodyMatch[1] } : {}),
            ...(parsedBody ? { bodyObject: parsedBody } : {})
          });
          continue;
        }

        // Match Python requests.post("...", json={...})
        const pyMatch = lineText.match(/requests\.(get|post|put|patch|delete)\(\s*["']([^"']+)["']/i);
        if (pyMatch) {
          calls.push({
            file: relFile,
            line: index + 1,
            client: "requests",
            method: pyMatch[1]!.toUpperCase() as HttpMethod,
            url: pyMatch[2]!
          });
          continue;
        }

        // Match Java OkHttp Request.Builder().url("...")
        const javaMatch = lineText.match(/\.url\(\s*"([^"]+)"\s*\)/);
        if (javaMatch) {
          const methodMatch = windowText.match(/\.(post|put|patch|delete)\(/i);
          calls.push({
            file: relFile,
            line: index + 1,
            client: "okhttp",
            method: (methodMatch?.[1]?.toUpperCase() ?? "GET") as HttpMethod,
            url: javaMatch[1]!
          });
        }
      }
    }
  }

  await walk(root);
  return calls;
}

function tryParseLooseObject(raw?: string): Record<string, unknown> | undefined {
  if (!raw) return undefined;
  try {
    const normalized = raw
      .replace(/([{,]\s*)([A-Za-z_][A-Za-z0-9_]*)(\s*:)/g, '$1"$2"$3')
      .replace(/'/g, '"');
    const parsed = JSON.parse(normalized);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function extractPathFromUrl(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url.split("?")[0] ?? url;
  }
}

function assertSafeRelativePath(root: string, relFile: string): string {
  const full = resolve(root, relFile);
  const rel = relative(root, full);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(`PATH_ESCAPE:${relFile}`);
  }
  return full;
}

export interface WorkspaceToolsConfig {
  sourceDir: string;
  isolatedWorkspaceDir: string;
  previousOpenApi: unknown;
  nextOpenApi: unknown;
}

/**
 * 仓库契约迁移与隔离沙箱工具族：
 * - 只读工具（自动放行）：diff_openapi_contracts, scan_repository, propose_migration_patches
 * - 写操作工具（强制人工审批）：apply_patches_isolated, run_isolated_tests
 */
export function createWorkspaceMigrationTools(config: WorkspaceToolsConfig): HarnessToolSpec<any>[] {
  const emptySchema = z.object({});

  const diffTool: HarnessToolSpec<Record<string, never>> = {
    name: "diff_openapi_contracts",
    label: "Diff OpenAPI Contracts",
    description: "Compare previous and next OpenAPI contracts to detect breaking and non-breaking schema changes.",
    risk: "read",
    jsonSchema: { type: "object", properties: {}, additionalProperties: false },
    zodSchema: emptySchema,
    execute: async () => {
      const report = diffOpenApiContracts(config.previousOpenApi, config.nextOpenApi);
      return {
        summary: `Contract diff found ${report.summary.breaking} breaking and ${report.summary.nonBreaking} non-breaking change(s).`,
        evidenceKind: "contract_diff",
        data: report
      };
    }
  };

  const scanTool: HarnessToolSpec<Record<string, never>> = {
    name: "scan_repository",
    label: "Scan Repository API Calls",
    description: "Scan the registered source repository for Fetch/Axios/Requests/OkHttp calls and map breaking contract impacts.",
    risk: "read",
    jsonSchema: { type: "object", properties: {}, additionalProperties: false },
    zodSchema: emptySchema,
    execute: async () => {
      const calls = await scanRepositoryCalls(config.sourceDir);
      const diff = diffOpenApiContracts(config.previousOpenApi, config.nextOpenApi);
      const breakingOps = new Map<string, ContractChange[]>();

      for (const change of diff.changes.filter((item) => item.breaking)) {
        const list = breakingOps.get(change.operation) ?? [];
        list.push(change);
        breakingOps.set(change.operation, list);
      }

      const impactedCalls = calls
        .map((call) => {
          const opKey = `${call.method} ${extractPathFromUrl(call.url)}`;
          const matchedChanges = breakingOps.get(opKey) ?? [];
          return { call, operation: opKey, matchedChanges };
        })
        .filter((item) => item.matchedChanges.length > 0);

      return {
        summary: `Scanned ${calls.length} API call(s); ${impactedCalls.length} impacted by breaking changes.`,
        evidenceKind: "contract_impact",
        data: {
          sourceDir: config.sourceDir,
          totalCalls: calls.length,
          calls,
          impactedCalls
        }
      };
    }
  };

  const proposePatchTool: HarnessToolSpec<Record<string, never>> = {
    name: "propose_migration_patches",
    label: "Propose Lossless Migration Patches",
    description: "Generate deterministic lossless literal patches (e.g. string-to-number conversion) without modifying any files.",
    risk: "read",
    jsonSchema: { type: "object", properties: {}, additionalProperties: false },
    zodSchema: emptySchema,
    execute: async () => {
      const calls = await scanRepositoryCalls(config.sourceDir);
      const diff = diffOpenApiContracts(config.previousOpenApi, config.nextOpenApi);
      const patches: PatchProposal[] = [];

      for (const call of calls) {
        if (!call.bodyObject) continue;
        const opKey = `${call.method} ${extractPathFromUrl(call.url)}`;
        const typeChanges = diff.changes.filter(
          (item) => item.operation === opKey && item.kind === "type_changed"
        );

        for (const change of typeChanges) {
          const field = change.fieldPath.replace(/^\$\./, "");
          const currentValue = call.bodyObject[field];
          if (change.previousType === "string" && change.nextType === "number" && typeof currentValue === "string") {
            const numeric = Number(currentValue);
            if (Number.isFinite(numeric)) {
              patches.push({
                file: call.file,
                line: call.line,
                field,
                before: `"${currentValue}"`,
                after: String(numeric),
                reason: `Convert literal string "${currentValue}" to number ${numeric} for ${opKey} (${change.fieldPath}).`
              });
            }
          }
        }
      }

      return {
        summary: `Proposed ${patches.length} lossless migration patch(es).`,
        evidenceKind: "patch_proposal",
        data: { patches }
      };
    }
  };

  const applySchema = z.object({
    proposalEvidenceId: z.string().min(1).max(160)
  });

  const applyPatchTool: HarnessToolSpec<z.infer<typeof applySchema>> = {
    name: "apply_patches_isolated",
    label: "Apply Patches in Isolated Sandbox (Approval Required)",
    description:
      "Copy source repository into an isolated workspace directory and apply patches from a verified patch_proposal artifact. Requires human approval.",
    risk: "write",
    jsonSchema: {
      type: "object",
      properties: {
        proposalEvidenceId: { type: "string", description: "Evidence ID of kind patch_proposal" }
      },
      required: ["proposalEvidenceId"],
      additionalProperties: false
    },
    zodSchema: applySchema,
    execute: async (args, context) => {
      const artifact = context.snapshot.evidence.find(
        (item) => item.id === args.proposalEvidenceId && item.kind === "patch_proposal"
      );
      if (!artifact) {
        throw new Error(`PATCH_PROPOSAL_NOT_FOUND:${args.proposalEvidenceId}`);
      }
      const { patches } = artifact.data as { patches: PatchProposal[] };
      if (!patches.length) {
        throw new Error("NO_PATCHES_TO_APPLY");
      }

      const source = resolve(config.sourceDir);
      const workspace = resolve(config.isolatedWorkspaceDir);
      const relCheck = relative(source, workspace);
      if (!relCheck || (!relCheck.startsWith("..") && !isAbsolute(relCheck))) {
        throw new Error("ISOLATED_WORKSPACE_MUST_BE_OUTSIDE_SOURCE");
      }

      await rm(workspace, { recursive: true, force: true });
      await mkdir(dirname(workspace), { recursive: true });
      await cp(source, workspace, { recursive: true });

      for (const patch of patches) {
        const targetFile = assertSafeRelativePath(workspace, patch.file);
        const content = await readFile(targetFile, "utf8");
        const fieldRegex = new RegExp(`(${patch.field}\\s*:\\s*)${patch.before.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`);
        if (!fieldRegex.test(content)) {
          throw new Error(`PATCH_TARGET_NOT_FOUND:${patch.file}:${patch.field}`);
        }
        const updated = content.replace(fieldRegex, `$1${patch.after}`);
        await writeFile(targetFile, updated, "utf8");
      }

      return {
        summary: `Applied ${patches.length} patch(es) inside isolated workspace "${workspace}".`,
        evidenceKind: "isolated_patch",
        data: {
          isolated: true,
          applied: true,
          workspaceDir: workspace,
          patchCount: patches.length,
          patches
        }
      };
    }
  };

  const testSchema = z.object({
    patchEvidenceId: z.string().min(1).max(160)
  });

  const runTestsTool: HarnessToolSpec<z.infer<typeof testSchema>> = {
    name: "run_isolated_tests",
    label: "Run Regression Contract Tests in Sandbox (Approval Required)",
    description:
      "Generate and execute Node contract regression assertions against the isolated workspace. Requires human approval.",
    risk: "write",
    jsonSchema: {
      type: "object",
      properties: {
        patchEvidenceId: { type: "string", description: "Evidence ID of kind isolated_patch" }
      },
      required: ["patchEvidenceId"],
      additionalProperties: false
    },
    zodSchema: testSchema,
    execute: async (args, context) => {
      const artifact = context.snapshot.evidence.find(
        (item) => item.id === args.patchEvidenceId && item.kind === "isolated_patch"
      );
      if (!artifact) {
        throw new Error(`ISOLATED_PATCH_NOT_FOUND:${args.patchEvidenceId}`);
      }

      const workspace = resolve(config.isolatedWorkspaceDir);
      const calls = await scanRepositoryCalls(workspace);
      const diff = diffOpenApiContracts(config.previousOpenApi, config.nextOpenApi);

      const assertions: string[] = [
        'import test from "node:test";',
        'import assert from "node:assert/strict";'
      ];

      let testCount = 0;
      for (const call of calls) {
        if (!call.bodyObject) continue;
        const opKey = `${call.method} ${extractPathFromUrl(call.url)}`;
        const typeChanges = diff.changes.filter(
          (item) => item.operation === opKey && item.kind === "type_changed"
        );
        for (const change of typeChanges) {
          const field = change.fieldPath.replace(/^\$\./, "");
          const actualValue = call.bodyObject[field];
          testCount += 1;
          assertions.push(
            `test(${JSON.stringify(`${call.file}:${call.line} ${opKey} ${field} is ${change.nextType}`)}, () => {`,
            `  assert.equal(typeof ${JSON.stringify(actualValue)}, ${JSON.stringify(change.nextType)});`,
            `});`
          );
        }
      }

      const testFile = join(workspace, ".a-pidoc-regression.test.mjs");
      await writeFile(testFile, `${assertions.join("\n")}\n`, "utf8");

      let exitCode = 0;
      let stdout = "";
      let stderr = "";
      try {
        const execResult = await execFileAsync(process.execPath, ["--test", testFile], {
          cwd: workspace,
          timeout: 10_000
        });
        stdout = execResult.stdout;
        stderr = execResult.stderr;
      } catch (error) {
        const failed = error as { code?: number; stdout?: string; stderr?: string };
        exitCode = typeof failed.code === "number" ? failed.code : 1;
        stdout = failed.stdout ?? "";
        stderr = failed.stderr ?? "";
      }

      return {
        summary: `Executed ${testCount} isolated contract test(s) with exitCode=${exitCode}.`,
        evidenceKind: "test_run",
        data: {
          patchEvidenceId: args.patchEvidenceId,
          testCount,
          exitCode,
          passed: exitCode === 0 && testCount > 0,
          commandDigest: sha256Digest(["node", "--test", ".a-pidoc-regression.test.mjs"]),
          stdout: stdout.slice(0, 2_000),
          stderr: stderr.slice(0, 1_000)
        }
      };
    }
  };

  return [diffTool, scanTool, proposePatchTool, applyPatchTool, runTestsTool];
}
