import type { ApiSpec, FixAction, Reasoner, RootCause } from "../domain/types.js";
import { isSensitiveKey } from "../security/redaction.js";
import { unsafeProperty } from "../input/api-document.js";
import { fillDocumentedDefaults, validateSchema } from "../input/json-schema.js";

type Input = Parameters<Reasoner["diagnose"]>[0];
export function requestSchema(spec: ApiSpec): Record<string, unknown> {
  return spec.bodySchema ?? { type: "object", required: Object.keys(spec.requiredBody), properties: Object.fromEntries(Object.entries(spec.requiredBody).map(([key, type]) => [key, { type }])) };
}

export function classifyFault(input: Input): RootCause {
  const { result, request, spec } = input;
  if (result.errorType) return result.errorType;
  if (result.status >= 200 && result.status < 300) return "NONE";
  if (result.status === 401) return /expired|expiration/i.test(JSON.stringify(result.body)) ? "AUTH_EXPIRED" : "AUTH_HEADER_FORMAT";
  if (result.status === 403) return "PERMISSION_DENIED";
  if (result.status === 404) return "ENDPOINT_NOT_FOUND";
  if (result.status === 405) return "HTTP_METHOD_MISMATCH";
  if (result.status === 415) return "CONTENT_TYPE_MISMATCH";
  if (result.status === 429) return "RATE_LIMIT_TRANSIENT";
  if (result.status >= 500) return "SERVER_ERROR";
  if (result.status === 400 || result.status === 422) {
    const issues = validateSchema(request.body ?? {}, requestSchema(spec));
    if (issues.some((i) => i.message === "required property is missing")) return "BODY_FIELD_MISSING";
    if (issues.some((i) => i.message.includes("enum"))) return "BODY_ENUM_MISMATCH";
    if (issues.some((i) => i.message.startsWith("expected"))) return "BODY_TYPE_MISMATCH";
    return "UNKNOWN";
  }
  return "UNKNOWN";
}

const summaries: Record<RootCause, string> = {
  AUTH_HEADER_FORMAT: "鉴权被拒绝；检查请求与规范的凭据格式。",
  AUTH_EXPIRED: "响应指出凭据已过期；需要提供有效凭据后再运行。",
  PERMISSION_DENIED: "接口拒绝当前权限；不能靠修改业务参数获取权限。",
  ENDPOINT_NOT_FOUND: "接口路径或资源不存在；需确认文档、版本及资源标识。",
  CONTENT_TYPE_MISMATCH: "媒体类型与接口规范不一致。",
  BODY_TYPE_MISMATCH: "请求字段类型不符合规范。",
  BODY_FIELD_MISSING: "请求缺少规范要求的字段。",
  BODY_ENUM_MISMATCH: "字段取值不在规范枚举范围内。",
  HTTP_METHOD_MISMATCH: "请求方法被接口拒绝，应核对规范。",
  RATE_LIMIT_TRANSIENT: "接口限流；重试须遵守 Retry-After 和尝试预算。",
  SERVER_ERROR: "响应表明服务端失败；没有依据修改客户端业务值。",
  REQUEST_TIMEOUT: "HTTP 工具超时；本次不能确认服务端是否完成写操作。",
  NETWORK_ERROR: "HTTP 工具连接失败；检查地址、DNS 和服务可达性。",
  INVALID_JSON_RESPONSE: "响应声明 JSON，但内容不能解析为 JSON。",
  NONE: "请求成功。", UNKNOWN: "证据不足，停止自动修改。"
};
export function faultSummary(cause: RootCause): string { return summaries[cause]; }

export function safeBodyRepair(input: Input): FixAction {
  const schema = requestSchema(input.spec);
  const before = input.request.body ?? {};
  const properties = (schema.properties ?? {}) as Record<string, Record<string, unknown>>;
  const filled = fillDocumentedDefaults(before, schema) as Record<string, unknown>;
  for (const [name, property] of Object.entries(properties)) {
    if (isSensitiveKey(name) || unsafeProperty(name)) continue;
    const current = before[name];
    let value = filled[name];
    if (current !== undefined && (typeof current !== "object" || current === null)) {
      value = current;
      if ((property.type === "number" || property.type === "integer") && typeof current === "string" && /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(current)) value = Number(current);
      if (property.type === "boolean" && (current === "true" || current === "false")) value = current === "true";
      if (property.type === "string" && (typeof current === "number" || typeof current === "boolean")) value = String(current);
    }
    if (value === undefined || JSON.stringify(current) === JSON.stringify(value)) continue;
    if (validateSchema(value, property).length > 0) continue;
    return { kind: "set_body", name, value };
  }
  return { kind: "stop" };
}

export function proposedRepair(input: Input, cause = classifyFault(input)): FixAction {
  if (["BODY_FIELD_MISSING", "BODY_TYPE_MISMATCH", "BODY_ENUM_MISMATCH"].includes(cause)) return safeBodyRepair(input);
  if (cause === "HTTP_METHOD_MISMATCH" && input.request.method !== input.spec.method) return { kind: "set_method", value: input.spec.method };
  if (cause === "CONTENT_TYPE_MISMATCH") {
    const expected = Object.entries(input.spec.requiredHeaders).find(([name]) => name.toLowerCase() === "content-type");
    if (expected) return { kind: "set_header", name: expected[0], value: expected[1] };
  }
  if (cause === "AUTH_HEADER_FORMAT") {
    const expected = Object.entries(input.spec.requiredHeaders).find(([name]) => name.toLowerCase() === "authorization");
    const actual = Object.entries(input.request.headers).find(([name]) => name.toLowerCase() === "authorization");
    // Repair only the scheme around the same caller-provided token, never replace credentials.
    if (expected && actual && !actual[1].startsWith("Bearer ") && expected[1] === `Bearer ${actual[1]}`) return { kind: "set_header", name: expected[0], value: expected[1] };
  }
  if (cause === "RATE_LIMIT_TRANSIENT") return { kind: "retry" };
  return { kind: "stop" };
}

export function actionIsSupported(input: Input, action: FixAction): boolean {
  if (action.kind === "stop") return true;
  const expected = proposedRepair(input);
  // Key order is irrelevant; compare the fields of the allowed action.
  return action.kind === expected.kind && Object.entries(expected).every(([key, value]) =>
    JSON.stringify((action as unknown as Record<string, unknown>)[key]) === JSON.stringify(value));
}
