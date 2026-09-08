import { createHash } from "node:crypto";
import { scanRepository } from "../repository/scanner.js";
import { diffOpenApi } from "./openapi-diff.js";
import type { ContractChange, ContractImpact, ContractImpactReport, MigrationPatchPlan } from "./types.js";

function fieldName(path: string | null): string | null { if (!path?.startsWith("$.") || path.includes("[]")) return null; const parts = path.slice(2).split("."); return parts.length === 1 ? parts[0]! : null; }
function valueType(value: unknown): string { if (Array.isArray(value)) return "array"; if (value === null) return "null"; return typeof value; }
function impactsRequest(change: ContractChange, body: Record<string, unknown> | null): boolean {
  const name = fieldName(change.fieldPath); if (!name) return true; const has = body !== null && Object.hasOwn(body, name); const value = body?.[name];
  if (change.kind === "REQUEST_FIELD_ADDED") return change.breaking && !has;
  if (change.kind === "REQUEST_FIELD_REMOVED") return has;
  if (change.kind === "REQUEST_FIELD_REQUIRED_CHANGED") return change.after === true && !has;
  if (change.kind === "REQUEST_FIELD_TYPE_CHANGED") return has && valueType(value) !== change.after;
  return false;
}
function impactId(changeId: string, file: string, line: number): string { return createHash("sha256").update(`${changeId}|${file}|${line}`).digest("hex").slice(0, 12); }

export async function analyzeContractImpact(options: { root: string; previousDocument: unknown; nextDocument: unknown }): Promise<ContractImpactReport> {
  const diff = diffOpenApi(options.previousDocument, options.nextDocument); const repository = await scanRepository({ root: options.root, openApiDocument: options.previousDocument }); const impacts: ContractImpact[] = [];
  for (const call of repository.apiCalls) {
    if (!call.openApiOperation) continue;
    for (const change of diff.changes.filter((candidate) => candidate.operation === call.openApiOperation)) {
      const affected = change.kind === "OPERATION_REMOVED" || change.location === "response" && change.breaking || change.location === "request" && impactsRequest(change, call.body);
      if (!affected) continue;
      impacts.push({ id: impactId(change.id, call.file, call.line), changeId: change.id, severity: change.severity, reason: `${change.kind} affects ${call.client} call at ${call.file}:${call.line}`, call });
    }
  }
  const impactedCalls = new Set(impacts.map((impact) => `${impact.call.file}:${impact.call.line}`)).size;
  return { diff, impacts, summary: { calls: repository.apiCalls.length, impactedCalls, high: impacts.filter((impact) => impact.severity === "high").length, medium: impacts.filter((impact) => impact.severity === "medium").length, low: impacts.filter((impact) => impact.severity === "low").length } };
}

function safeLiteralReplacement(change: ContractChange, source: string): { before: string; after: string } | null {
  const name = fieldName(change.fieldPath); if (!name || change.kind !== "REQUEST_FIELD_TYPE_CHANGED") return null; const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (change.before === "string" && change.after === "number") { const match = source.match(new RegExp(`(["']?${escaped}["']?\\s*:\\s*)["'](-?\\d+(?:\\.\\d+)?)["']`)); if (match?.[0] && match[1] && match[2] && Number.isFinite(Number(match[2]))) return { before: match[0], after: `${match[1]}${match[2]}` }; }
  if (change.before === "string" && change.after === "boolean") { const match = source.match(new RegExp(`(["']?${escaped}["']?\\s*:\\s*)["'](true|false)["']`, "i")); if (match?.[0] && match[1] && match[2]) return { before: match[0], after: `${match[1]}${match[2].toLowerCase()}` }; }
  if (change.before === "number" && change.after === "string") { const match = source.match(new RegExp(`(["']?${escaped}["']?\\s*:\\s*)(-?\\d+(?:\\.\\d+)?)`)); if (match?.[0] && match[1] && match[2]) return { before: match[0], after: `${match[1]}"${match[2]}"` }; }
  return null;
}

export function generateMigrationPatchPlans(report: ContractImpactReport): MigrationPatchPlan[] {
  const changes = new Map(report.diff.changes.map((change) => [change.id, change])); const plans: MigrationPatchPlan[] = [];
  for (const impact of report.impacts) { const change = changes.get(impact.changeId); if (!change || impact.call.sources.body.kind !== "literal") continue; const replacement = safeLiteralReplacement(change, impact.call.sourceText); if (!replacement) continue; plans.push({ changeId: change.id, file: impact.call.file, line: impact.call.line, title: `Migrate ${change.fieldPath} from ${String(change.before)} to ${String(change.after)}`, before: replacement.before, after: replacement.after, rationale: "The old literal has an unambiguous lossless representation in the new primitive type", requiresApproval: true }); }
  return plans;
}
