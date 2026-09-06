import type { ApiRequest, Diagnosis } from "../domain/types.js";

const SENSITIVE_KEY = /authorization|api[-_]?key|token|secret|password|cookie/i;
export const REDACTED = "[REDACTED]";

const TEXT_PATTERNS: RegExp[] = [
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi,
  /\bsk-[A-Za-z0-9_-]{8,}/gi,
  /\b(?:api[-_]?key|token|secret|password)\s*[:=]\s*[^\s,;"']{4,}/gi,
  /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi,
  /(?<!\d)1[3-9]\d{9}(?!\d)/g,
  /\b[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g
];

export function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY.test(key);
}

export function redactText(value: string): string {
  return TEXT_PATTERNS.reduce((result, pattern) => result.replace(pattern, REDACTED), value);
}

export function redactValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactValue);
  if (typeof value === "string") return redactText(value);
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
    const values = url.searchParams.getAll(key);
    url.searchParams.delete(key);
    for (const value of values) {
      url.searchParams.append(key, isSensitiveKey(key) ? REDACTED : redactText(value));
    }
  }
  return {
    ...structuredClone(request),
    url: url.toString(),
    headers: Object.fromEntries(
      Object.entries(request.headers).map(([key, value]) => [key, isSensitiveKey(key) ? REDACTED : redactText(value)])
    ),
    body: redactValue(request.body) as Record<string, unknown> | null
  };
}

export function redactDiagnosis(diagnosis: Diagnosis): Diagnosis {
  const clone = redactValue(structuredClone(diagnosis)) as Diagnosis;
  if (clone.action.kind === "set_header" && isSensitiveKey(clone.action.name)) {
    clone.action.value = REDACTED;
  }
  if (clone.action.kind === "set_body" && isSensitiveKey(clone.action.name)) {
    clone.action.value = REDACTED;
  }
  return clone;
}
