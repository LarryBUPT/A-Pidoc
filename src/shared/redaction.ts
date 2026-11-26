import type { ApiRequest } from "./types.js";

const SENSITIVE_KEY_PATTERN = /authorization|api[-_]?key|token|secret|password|cookie/i;

const NON_SENSITIVE_METRIC_KEYS = new Set([
  "inputTokens",
  "outputTokens",
  "totalTokens",
  "maxTokens",
  "maxOutputTokens",
  "tokens"
]);

const INTEGRITY_HASH_KEYS = new Set([
  "sha256",
  "actionDigest",
  "commandDigest",
  "contractDigest",
  "sourceDigest",
  "workspaceDigest"
]);

export const REDACTED = "[REDACTED]";

const SENSITIVE_TEXT_PATTERNS: RegExp[] = [
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi,
  /\bsk-[A-Za-z0-9_-]{8,}/gi,
  /\b(?:api[-_]?key|token|secret|password)\s*[:=]\s*[^\s,;"']{4,}/gi,
  /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi,
  /(?<!\d)1[3-9]\d{9}(?!\d)/g,
  /\b[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g
];

export function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY_PATTERN.test(key);
}

export function redactText(value: string): string {
  return SENSITIVE_TEXT_PATTERNS.reduce(
    (current, pattern) => current.replace(pattern, REDACTED),
    value
  );
}

export function redactValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item));
  }
  if (typeof value === "string") {
    return redactText(value);
  }
  if (!value || typeof value !== "object") {
    return value;
  }

  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => {
      if (NON_SENSITIVE_METRIC_KEYS.has(key) && typeof item === "number") {
        return [key, item];
      }
      if (isSensitiveKey(key)) {
        return [key, REDACTED];
      }
      if (INTEGRITY_HASH_KEYS.has(key) && typeof item === "string" && /^[a-f0-9]{64}$/.test(item)) {
        return [key, item];
      }
      return [key, redactValue(item)];
    })
  );
}

export function redactRequest(request: ApiRequest): ApiRequest {
  const parsedUrl = new URL(request.url);
  if (parsedUrl.username) parsedUrl.username = REDACTED;
  if (parsedUrl.password) parsedUrl.password = REDACTED;

  for (const key of [...parsedUrl.searchParams.keys()]) {
    const values = parsedUrl.searchParams.getAll(key);
    parsedUrl.searchParams.delete(key);
    for (const value of values) {
      parsedUrl.searchParams.append(key, isSensitiveKey(key) ? REDACTED : redactText(value));
    }
  }

  const redactedHeaders = Object.fromEntries(
    Object.entries(request.headers).map(([key, value]) => [
      key,
      isSensitiveKey(key) ? REDACTED : redactText(value)
    ])
  );

  return {
    ...structuredClone(request),
    url: parsedUrl.toString(),
    headers: redactedHeaders,
    body: redactValue(request.body) as Record<string, unknown> | null
  };
}
