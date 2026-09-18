import { readFile } from "node:fs/promises";
import { validateHeaderName, validateHeaderValue } from "node:http";
import { businessCases, type BusinessCase } from "./business-cases.js";
import { assertSupportedSchema } from "../input/json-schema.js";
import { unsafeProperty } from "../input/api-document.js";

export const DEFAULT_AGENTIC_CASES = ["runtime-media", "runtime-body", "delete", "outside-host", "repeat", "false-claim", "missing-evidence", "contract-approved", "contract-unapproved"] as const;
export const ADVERSARIAL_SCENARIOS = ["poisoned-document", "hallucinated-endpoint", "prompt-injection"] as const;
export type AgenticScenario = typeof DEFAULT_AGENTIC_CASES[number] | typeof ADVERSARIAL_SCENARIOS[number];
export interface AgenticCase {
  id: string;
  scenario: AgenticScenario;
  untrustedText?: string;
}
export interface EvaluationDataset<T> { schemaVersion: 1; kind: "business" | "agentic"; version: string; cases: T[] }
const methods = ["GET", "POST", "PUT", "PATCH", "DELETE"];
const causes = ["AUTH_HEADER_FORMAT", "CONTENT_TYPE_MISMATCH", "BODY_TYPE_MISMATCH", "HTTP_METHOD_MISMATCH", "RATE_LIMIT_TRANSIENT", "AUTH_EXPIRED", "PERMISSION_DENIED", "ENDPOINT_NOT_FOUND", "BODY_FIELD_MISSING", "BODY_ENUM_MISMATCH", "SERVER_ERROR", "REQUEST_TIMEOUT", "NETWORK_ERROR", "INVALID_JSON_RESPONSE", "NONE", "UNKNOWN"];
function invalid(path: string, message: string): never { throw new Error(`INVALID_EVALUATION_DATASET ${path}: ${message}`); }
function object(v: unknown, path: string): Record<string, unknown> {
  if (!v || typeof v !== "object" || Array.isArray(v)) invalid(path, "expected object");
  return v as Record<string, unknown>;
}
function shape(v: unknown, path: string, required: string[], optional: string[] = []) {
  const o = object(v, path);
  for (const key of Object.keys(o)) if (![...required, ...optional].includes(key)) invalid(`${path}.${key}`, "unknown field");
  for (const key of required) if (!Object.hasOwn(o, key)) invalid(`${path}.${key}`, "missing field");
  return o;
}
function text(v: unknown, path: string, max = 4000): asserts v is string {
  if (typeof v !== "string" || !v.trim() || v.length > max) invalid(path, "expected nonempty bounded string");
}
function choice(v: unknown, path: string, allowed: readonly string[]) {
  if (typeof v !== "string" || !allowed.includes(v)) invalid(path, `expected one of ${allowed.join(", ")}`);
}
function integer(v: unknown, path: string, min: number, max: number) {
  if (!Number.isSafeInteger(v) || (v as number) < min || (v as number) > max) invalid(path, `expected integer in [${min}, ${max}]`);
}
function strings(v: unknown, path: string) {
  for (const [key, value] of Object.entries(object(v, path))) {
    if (typeof value !== "string") invalid(`${path}.${key}`, "expected string");
    try { validateHeaderName(key); validateHeaderValue(key,value); } catch { invalid(`${path}.${key}`, "invalid HTTP header"); }
  }
}
function json(v: unknown, path: string, depth = 0): void {
  if (depth > 24) invalid(path, "JSON depth exceeds limit");
  if (v === null || typeof v === "string" || typeof v === "boolean" || typeof v === "number" && Number.isFinite(v)) return;
  if (!v || typeof v !== "object") invalid(path, "expected JSON value");
  for (const [key, child] of Object.entries(v)) {
    if (unsafeProperty(key)) invalid(`${path}.${key}`, "unsafe property");
    json(child, `${path}.${key}`, depth + 1);
  }
}
function request(v: unknown, path: string, partial = false) {
  const o = shape(v, path, partial ? [] : ["method", "headers", "body"], partial ? ["method", "headers", "body"] : []);
  if (Object.hasOwn(o, "method")) choice(o.method, `${path}.method`, methods);
  if (Object.hasOwn(o, "headers")) strings(o.headers, `${path}.headers`);
  if (Object.hasOwn(o, "body") && o.body !== null) object(o.body, `${path}.body`);
}
function business(v: unknown, path: string) {
  const o = shape(v, path, ["id", "title", "request", "spec", "failure", "expected"], ["repaired"]);
  text(o.title, `${path}.title`); request(o.request, `${path}.request`);
  if (Object.hasOwn(o, "repaired")) request(o.repaired, `${path}.repaired`, true);
  const spec = shape(o.spec, `${path}.spec`, ["method", "requiredHeaders", "requiredBody"], ["bodySchema"]);
  choice(spec.method, `${path}.spec.method`, methods); strings(spec.requiredHeaders, `${path}.spec.requiredHeaders`);
  for (const [key, value] of Object.entries(object(spec.requiredBody, `${path}.spec.requiredBody`))) choice(value, `${path}.spec.requiredBody.${key}`, ["string", "number", "boolean"]);
  if (Object.hasOwn(spec, "bodySchema")) {
    try { assertSupportedSchema(spec.bodySchema); } catch (e) { invalid(`${path}.spec.bodySchema`, (e as Error).message); }
  }
  const failure = shape(o.failure, `${path}.failure`, ["status", "body"], ["retryAfter", "transport"]);
  integer(failure.status, `${path}.failure.status`, 0, 599); object(failure.body, `${path}.failure.body`);
  if (Object.hasOwn(failure, "retryAfter")) {
    text(failure.retryAfter, `${path}.failure.retryAfter`, 128);
    try { validateHeaderValue("retry-after",failure.retryAfter); } catch { invalid(`${path}.failure.retryAfter`, "invalid HTTP header"); }
  }
  if (Object.hasOwn(failure, "transport")) choice(failure.transport, `${path}.failure.transport`, ["timeout", "disconnect", "invalid-json"]);
  if ((failure.status as number) < 200 && !(failure.status === 0 && ["timeout", "disconnect"].includes(String(failure.transport)))) invalid(`${path}.failure.status`, "expected final HTTP status or transport error status 0");
  if (["timeout", "disconnect"].includes(String(failure.transport)) && failure.status !== 0 || failure.transport === "invalid-json" && failure.status !== 200) invalid(`${path}.failure`, "transport profile requires status 0 (timeout/disconnect) or 200 (invalid-json)");
  if (failure.transport !== undefined && (Object.keys(failure.body as object).length || failure.retryAfter !== undefined || o.repaired !== undefined)) invalid(`${path}.failure`, "transport profile does not consume body, retryAfter or repaired; use empty body and omit the other fields");
  const expected = shape(o.expected, `${path}.expected`, ["rootCause", "status", "attempts"]);
  choice(expected.rootCause, `${path}.expected.rootCause`, causes); choice(expected.status, `${path}.expected.status`, ["resolved", "unresolved", "blocked"]);
  integer(expected.attempts, `${path}.expected.attempts`, 1, 3);
}
function agentic(v: unknown, path: string) {
  const o = shape(v, path, ["id", "scenario"], ["untrustedText"]);
  choice(o.scenario, `${path}.scenario`, [...DEFAULT_AGENTIC_CASES, ...ADVERSARIAL_SCENARIOS]);
  if (Object.hasOwn(o, "untrustedText")) text(o.untrustedText, `${path}.untrustedText`, 1000);
  if (Object.hasOwn(o, "untrustedText") && !["runtime-media", "runtime-body", "false-claim", "missing-evidence", ...ADVERSARIAL_SCENARIOS].includes(String(o.scenario))) invalid(`${path}.untrustedText`, "not consumed by this profile");
}
function validate<T>(v: unknown, kind: EvaluationDataset<T>["kind"], validateCase: (v: unknown, path: string) => void): EvaluationDataset<T> {
  const o = shape(v, "$", ["schemaVersion", "kind", "version", "cases"]);
  if (o.schemaVersion !== 1 || o.kind !== kind) invalid("$", `expected schemaVersion 1, kind ${kind}`);
  text(o.version, "$.version", 100); json(o, "$");
  if (!Array.isArray(o.cases) || !o.cases.length || o.cases.length > 100) invalid("$.cases", "expected 1..100 cases");
  const ids = new Set<string>();
  o.cases.forEach((item, index) => {
    const path = `$.cases[${index}]`, row = object(item, path);
    text(row.id, `${path}.id`, 100);
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(row.id) || ids.has(row.id)) invalid(`${path}.id`, "expected unique safe identifier");
    ids.add(row.id); validateCase(row, path);
  });
  return structuredClone(o) as unknown as EvaluationDataset<T>;
}
async function external(path: string): Promise<unknown> {
  let bytes: Buffer;
  try { bytes = await readFile(path); } catch { invalid("$file", "cannot read dataset"); }
  if (bytes.length > 1_000_000) invalid("$file", "dataset exceeds byte limit");
  try { return JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(bytes)); } catch { invalid("$file", "malformed JSON or UTF-8"); }
}
export async function loadBusinessDataset(path?: string) {
  return validate<BusinessCase>(path === undefined ? {schemaVersion:1, kind:"business", version:"v1.0.0", cases:businessCases} : await external(path), "business", business);
}
export async function loadAgenticDataset(path?: string) {
  return validate<AgenticCase>(path === undefined ? {schemaVersion:1, kind:"agentic", version:"agentic-paired-v1", cases:DEFAULT_AGENTIC_CASES.map(id => ({id, scenario:id}))} : await external(path), "agentic", agentic);
}
