import { createHash } from "node:crypto";
import { readApiDocument } from "../input/api-document.js";
import type { ContractChange, ContractChangeKind, ContractDiffReport } from "./types.js";

type JsonObject = Record<string, unknown>;
interface FieldContract { type: string; required: boolean }
interface OperationContract { id: string; request: Map<string, FieldContract>; response: Map<string, FieldContract> }

const METHODS = ["get", "post", "put", "patch", "delete"] as const;
function object(value: unknown): JsonObject | null { return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : null; }
function schemaType(schema: JsonObject): string { if (typeof schema.type === "string") return schema.type; if (Array.isArray(schema.enum)) return "enum"; return "unknown"; }
function flattenSchema(schema: unknown, prefix = "$", required = true, result = new Map<string, FieldContract>()): Map<string, FieldContract> {
  const root = object(schema); if (!root) return result; const type = schemaType(root); result.set(prefix, { type, required });
  if (type === "object" || object(root.properties)) {
    const properties = object(root.properties) ?? {}; const requiredNames = new Set(Array.isArray(root.required) ? root.required.filter((item): item is string => typeof item === "string") : []);
    for (const [name, child] of Object.entries(properties)) flattenSchema(child, `${prefix}.${name}`, requiredNames.has(name), result);
  } else if (type === "array" && root.items !== undefined) flattenSchema(root.items, `${prefix}[]`, required, result);
  return result;
}
function mediaSchema(content: unknown): unknown {
  const map = object(content); if (!map) return undefined; const type = Object.keys(map).find((name) => name === "application/json" || name.endsWith("+json")); return type ? object(map[type])?.schema : undefined;
}
function operationContracts(document: unknown): Map<string, OperationContract> {
  const root = readApiDocument(document); if (typeof root.openapi !== "string" || !root.openapi.startsWith("3.")) throw new Error("Contract diff supports OpenAPI 3.x documents"); const paths = object(root.paths); if (!paths) throw new Error("OpenAPI paths must be an object"); const result = new Map<string, OperationContract>();
  for (const [path, rawPath] of Object.entries(paths)) { const pathItem = object(rawPath); if (!pathItem) continue; for (const method of METHODS) { const operation = object(pathItem[method]); if (!operation) continue; const requestBody = object(operation.requestBody); const request = flattenSchema(mediaSchema(requestBody?.content)); let responseSchema: unknown; const responses = object(operation.responses) ?? {}; for (const [status, rawResponse] of Object.entries(responses)) if (/^2\d\d$/.test(status) || status === "default") { responseSchema = mediaSchema(object(rawResponse)?.content); if (responseSchema) break; } const id = `${method.toUpperCase()} ${path}`; result.set(id, { id, request, response: flattenSchema(responseSchema) }); } }
  return result;
}
function changeId(kind: ContractChangeKind, operation: string, location: string, fieldPath: string | null): string { return createHash("sha256").update(`${kind}|${operation}|${location}|${fieldPath ?? ""}`).digest("hex").slice(0, 12); }
function add(changes: ContractChange[], input: Omit<ContractChange, "id">): void { changes.push({ id: changeId(input.kind, input.operation, input.location, input.fieldPath), ...input }); }
function compareFields(changes: ContractChange[], operation: string, location: "request" | "response", before: Map<string, FieldContract>, after: Map<string, FieldContract>): void {
  const paths = new Set([...before.keys(), ...after.keys()]); paths.delete("$");
  for (const fieldPath of [...paths].sort()) {
    const oldField = before.get(fieldPath); const newField = after.get(fieldPath);
    if (!oldField && newField) { const requestRequired = location === "request" && newField.required; add(changes, { kind: location === "request" ? "REQUEST_FIELD_ADDED" : "RESPONSE_FIELD_ADDED", severity: requestRequired ? "high" : "low", breaking: requestRequired, operation, location, fieldPath, before: null, after: newField, rationale: requestRequired ? "A new required request field can reject existing callers" : "An added optional/response field is backward compatible for tolerant clients" }); continue; }
    if (oldField && !newField) { add(changes, { kind: location === "request" ? "REQUEST_FIELD_REMOVED" : "RESPONSE_FIELD_REMOVED", severity: "high", breaking: true, operation, location, fieldPath, before: oldField, after: null, rationale: location === "request" ? "Existing callers may still send a field removed from the contract" : "Callers may read a response field that no longer exists" }); continue; }
    if (!oldField || !newField) continue;
    if (oldField.type !== newField.type) add(changes, { kind: location === "request" ? "REQUEST_FIELD_TYPE_CHANGED" : "RESPONSE_FIELD_TYPE_CHANGED", severity: "high", breaking: true, operation, location, fieldPath, before: oldField.type, after: newField.type, rationale: "The field type changed and existing serialization or consumers may be incompatible" });
    if (location === "request" && oldField.required !== newField.required) add(changes, { kind: "REQUEST_FIELD_REQUIRED_CHANGED", severity: newField.required ? "high" : "low", breaking: newField.required, operation, location, fieldPath, before: oldField.required, after: newField.required, rationale: newField.required ? "The field became required" : "The field became optional" });
  }
}

export function diffOpenApi(previousDocument: unknown, nextDocument: unknown): ContractDiffReport {
  const previous = operationContracts(previousDocument); const next = operationContracts(nextDocument); const changes: ContractChange[] = [];
  for (const operation of [...new Set([...previous.keys(), ...next.keys()])].sort()) {
    const oldOperation = previous.get(operation); const newOperation = next.get(operation);
    if (!oldOperation && newOperation) { add(changes, { kind: "OPERATION_ADDED", severity: "low", breaking: false, operation, location: "operation", fieldPath: null, before: null, after: operation, rationale: "A new operation does not break existing callers" }); continue; }
    if (oldOperation && !newOperation) { add(changes, { kind: "OPERATION_REMOVED", severity: "high", breaking: true, operation, location: "operation", fieldPath: null, before: operation, after: null, rationale: "Calls to the removed operation no longer have a contract" }); continue; }
    if (oldOperation && newOperation) { compareFields(changes, operation, "request", oldOperation.request, newOperation.request); compareFields(changes, operation, "response", oldOperation.response, newOperation.response); }
  }
  return { changes, summary: { total: changes.length, breaking: changes.filter((change) => change.breaking).length, high: changes.filter((change) => change.severity === "high").length, medium: changes.filter((change) => change.severity === "medium").length, low: changes.filter((change) => change.severity === "low").length } };
}
