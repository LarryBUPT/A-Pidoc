import type { ApiRequest, Diagnosis } from "../domain/types.js";

const SENSITIVE_KEY = /authorization|api[-_]?key|token|secret|password|cookie/i;
export const REDACTED = "[REDACTED]";

export function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY.test(key);
}

export function redactValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, isSensitiveKey(key) ? REDACTED : redactValue(item)])
  );
}

export function redactRequest(request: ApiRequest): ApiRequest {
  const url = new URL(request.url);
  if (url.username) url.username = REDACTED;
  if (url.password) url.password = REDACTED;
  for (const key of [...url.searchParams.keys()]) {
    if (isSensitiveKey(key)) url.searchParams.set(key, REDACTED);
  }
  return {
    ...structuredClone(request),
    url: url.toString(),
    headers: Object.fromEntries(
      Object.entries(request.headers).map(([key, value]) => [key, isSensitiveKey(key) ? REDACTED : value])
    ),
    body: redactValue(request.body) as Record<string, unknown> | null
  };
}

export function redactDiagnosis(diagnosis: Diagnosis): Diagnosis {
  const clone = structuredClone(diagnosis);
  if (clone.action.kind === "set_header" && isSensitiveKey(clone.action.name)) {
    clone.action.value = REDACTED;
  }
  if (clone.action.kind === "set_body" && isSensitiveKey(clone.action.name)) {
    clone.action.value = REDACTED;
  }
  return clone;
}
