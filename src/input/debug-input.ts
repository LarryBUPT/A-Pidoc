import type { ApiSpec, DebugTask, HttpMethod } from "../domain/types.js";
import { parseCurl } from "./curl-parser.js";
import { assertSupportedSchema } from "./json-schema.js";
import {
  parseOpenApiOperation,
  type OpenApiOperationOptions,
  type ParsedOpenApiOperation
} from "./openapi-parser.js";

type JsonObject = Record<string, unknown>;
const METHODS = new Set<HttpMethod>(["GET", "POST", "PUT", "PATCH", "DELETE"]);
const BODY_TYPES = new Set(["string", "number", "boolean"]);

export interface CurlDebugInput {
  kind: "curl";
  command: string;
  spec: ApiSpec;
  id?: string;
  title?: string;
}

export interface OpenApiDebugInput {
  kind: "openapi";
  document: unknown;
  operation: OpenApiOperationOptions;
}

export type RealDebugInput = CurlDebugInput | OpenApiDebugInput;

function object(value: unknown, label: string): JsonObject {
  if (!value || Array.isArray(value) || typeof value !== "object") throw new Error(`${label} must be an object`);
  return value as JsonObject;
}

export function parseApiSpec(value: unknown): ApiSpec {
  const raw = object(value, "spec");
  const method = typeof raw.method === "string" ? raw.method.toUpperCase() as HttpMethod : undefined;
  if (!method || !METHODS.has(method)) throw new Error("spec.method must be GET, POST, PUT, PATCH, or DELETE");
  const headerObject = object(raw.requiredHeaders ?? {}, "spec.requiredHeaders");
  const requiredHeaders: Record<string, string> = {};
  for (const [name, expected] of Object.entries(headerObject)) {
    if (typeof expected !== "string") throw new Error(`spec.requiredHeaders.${name} must be a string`);
    requiredHeaders[name] = expected;
  }
  const bodyObject = object(raw.requiredBody ?? {}, "spec.requiredBody");
  const requiredBody: ApiSpec["requiredBody"] = {};
  for (const [name, expected] of Object.entries(bodyObject)) {
    if (typeof expected !== "string" || !BODY_TYPES.has(expected)) {
      throw new Error(`spec.requiredBody.${name} must be string, number, or boolean`);
    }
    requiredBody[name] = expected as ApiSpec["requiredBody"][string];
  }
  if (raw.bodySchema !== undefined) assertSupportedSchema(raw.bodySchema);
  return { method, requiredHeaders, requiredBody, ...(raw.bodySchema ? { bodySchema: raw.bodySchema as JsonObject } : {}) };
}

export function parseCurlTask(input: CurlDebugInput): DebugTask {
  if (typeof input.command !== "string" || !input.command.trim()) throw new Error("curl command is required");
  return {
    id: input.id ?? "curl:request",
    title: input.title ?? "curl API diagnosis",
    source: "curl",
    request: parseCurl(input.command),
    spec: parseApiSpec(input.spec)
  };
}

export function parseRealDebugInput(input: unknown): { task: DebugTask; schemaIssues: ParsedOpenApiOperation["schemaIssues"] } {
  const raw = object(input, "debug input");
  if (raw.kind === "curl") {
    return {
      task: parseCurlTask({
        kind: "curl",
        command: raw.command as string,
        spec: raw.spec as ApiSpec,
        ...(typeof raw.id === "string" ? { id: raw.id } : {}),
        ...(typeof raw.title === "string" ? { title: raw.title } : {})
      }),
      schemaIssues: []
    };
  }
  if (raw.kind === "openapi") {
    const operation = object(raw.operation, "operation") as unknown as OpenApiOperationOptions;
    return parseOpenApiOperation(raw.document, operation);
  }
  throw new Error("kind must be curl or openapi");
}
