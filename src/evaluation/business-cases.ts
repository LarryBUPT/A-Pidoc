import type { ApiRequest, ApiSpec, DebugReport, RootCause } from "../domain/types.js";

export interface BusinessCase {
  id: string;
  title: string;
  request: Omit<ApiRequest, "url">;
  spec: ApiSpec;
  failure: { status: number; body: Record<string, unknown>; retryAfter?: string; transport?: "timeout" | "disconnect" | "invalid-json" };
  repaired?: Partial<Omit<ApiRequest, "url">>;
  expected: { rootCause: RootCause; status: DebugReport["status"]; attempts: number };
}

const request = { method: "POST" as const, headers: { "Content-Type": "application/json" }, body: { amount: 12 } };
const spec: ApiSpec = { method: "POST", requiredHeaders: { "Content-Type": "application/json" }, requiredBody: { amount: "number" } };
function scenario(id: string, title: string, status: number, rootCause: RootCause, overrides: Partial<BusinessCase> = {}): BusinessCase {
  return { id, title, request: structuredClone(request), spec: structuredClone(spec), failure: { status, body: { error: title } }, expected: { rootCause, status: "unresolved", attempts: 1 }, ...overrides };
}
function fieldSpec(name: string, property: Record<string, unknown>): ApiSpec {
  return { method: "POST", requiredHeaders: { "Content-Type": "application/json" }, requiredBody: {}, bodySchema: { type: "object", required: [name], properties: { [name]: property } } };
}

// Frozen scenarios contain explicit response, repair and outcome oracles, independent of the reasoner.
export const businessCases: BusinessCase[] = [
  scenario("media-type", "订单 JSON 使用 text/plain", 415, "CONTENT_TYPE_MISMATCH", { request: { ...request, headers: { "Content-Type": "text/plain" } }, repaired: { headers: request.headers }, expected: { rootCause: "CONTENT_TYPE_MISMATCH", status: "resolved", attempts: 2 } }),
  scenario("media-missing", "订单缺少媒体类型", 415, "CONTENT_TYPE_MISMATCH", { request: { ...request, headers: {} }, repaired: { headers: request.headers }, expected: { rootCause: "CONTENT_TYPE_MISMATCH", status: "resolved", attempts: 2 } }),
  scenario("numeric-string", "金额是字符串", 422, "BODY_TYPE_MISMATCH", { request: { ...request, body: { amount: "12" } }, repaired: { body: { amount: 12 } }, expected: { rootCause: "BODY_TYPE_MISMATCH", status: "resolved", attempts: 2 } }),
  scenario("invalid-number", "金额不是可转换数字", 422, "BODY_TYPE_MISMATCH", { request: { ...request, body: { amount: "twelve" } } }),
  scenario("boolean-false", "关闭订阅标记是 false 字符串", 422, "BODY_TYPE_MISMATCH", { request: { ...request, body: { active: "false" } }, spec: fieldSpec("active", { type: "boolean" }), repaired: { body: { active: false } }, expected: { rootCause: "BODY_TYPE_MISMATCH", status: "resolved", attempts: 2 } }),
  scenario("boolean-ambiguous", "关闭标记是歧义文本", 422, "BODY_TYPE_MISMATCH", { request: { ...request, body: { active: "no" } }, spec: fieldSpec("active", { type: "boolean" }) }),
  scenario("integer-fraction", "数量不能是小数", 422, "BODY_TYPE_MISMATCH", { request: { ...request, body: { quantity: 1.5 } }, spec: fieldSpec("quantity", { type: "integer", minimum: 1 }) }),
  scenario("required-default", "缺少有默认值的币种", 422, "BODY_FIELD_MISSING", { request: { ...request, body: {} }, spec: fieldSpec("currency", { type: "string", default: "CNY" }), repaired: { body: { currency: "CNY" } }, expected: { rootCause: "BODY_FIELD_MISSING", status: "resolved", attempts: 2 } }),
  scenario("required-unknown", "缺少业务金额且无默认值", 422, "BODY_FIELD_MISSING", { request: { ...request, body: {} } }),
  scenario("enum-invalid", "币种不在约定枚举内", 422, "BODY_ENUM_MISMATCH", { request: { ...request, body: { currency: "ZZZ" } }, spec: fieldSpec("currency", { type: "string", enum: ["CNY", "USD"] }) }),
  scenario("nested-default", "客户对象缺少默认等级", 422, "BODY_FIELD_MISSING", { request: { ...request, body: { customer: {} } }, spec: fieldSpec("customer", { type: "object", required: ["tier"], properties: { tier: { type: "string", default: "basic" } } }), repaired: { body: { customer: { tier: "basic" } } }, expected: { rootCause: "BODY_FIELD_MISSING", status: "resolved", attempts: 2 } }),
  scenario("array-enum", "条目枚举错误保留人工确认", 422, "BODY_ENUM_MISMATCH", { request: { ...request, body: { items: ["unknown"] } }, spec: fieldSpec("items", { type: "array", items: { type: "string", enum: ["standard"] } }) }),
  scenario("method", "PATCH 请求需要 POST", 405, "HTTP_METHOD_MISMATCH", { request: { ...request, method: "PATCH" }, repaired: { method: "POST" }, expected: { rootCause: "HTTP_METHOD_MISMATCH", status: "resolved", attempts: 2 } }),
  scenario("auth-scheme", "鉴权缺少 Bearer scheme", 401, "AUTH_HEADER_FORMAT", { request: { ...request, headers: { ...request.headers, Authorization: "demo-token" } }, spec: { ...spec, requiredHeaders: { ...spec.requiredHeaders, Authorization: "Bearer demo-token" } }, repaired: { headers: { ...request.headers, Authorization: "Bearer demo-token" } }, expected: { rootCause: "AUTH_HEADER_FORMAT", status: "resolved", attempts: 2 } }),
  scenario("auth-expired", "token expired", 401, "AUTH_EXPIRED"),
  scenario("auth-missing", "没有可安全使用的凭据", 401, "AUTH_HEADER_FORMAT"),
  scenario("forbidden", "权限不包含退款 scope", 403, "PERMISSION_DENIED"),
  scenario("not-found", "接口版本或资源不存在", 404, "ENDPOINT_NOT_FOUND"),
  scenario("server-failure", "服务端暂时不可用", 503, "SERVER_ERROR"),
  scenario("rate-recover", "短时限流下一次可成功", 429, "RATE_LIMIT_TRANSIENT", { failure: { status: 429, body: { error: "limited" }, retryAfter: "0" }, repaired: {}, expected: { rootCause: "RATE_LIMIT_TRANSIENT", status: "resolved", attempts: 2 } }),
  scenario("rate-long", "长时间限流不得立即重复提交", 429, "RATE_LIMIT_TRANSIENT", { failure: { status: 429, body: { error: "limited" }, retryAfter: "120" } }),
  scenario("timeout", "写请求超时不能证明未执行", 0, "REQUEST_TIMEOUT", { failure: { status: 0, body: {}, transport: "timeout" } }),
  scenario("disconnect", "上游连接中断", 0, "NETWORK_ERROR", { failure: { status: 0, body: {}, transport: "disconnect" } }),
  scenario("invalid-json", "200 响应不是承诺的 JSON", 200, "INVALID_JSON_RESPONSE", { failure: { status: 200, body: {}, transport: "invalid-json" } }),
  scenario("unknown-validation", "422 但请求满足当前规范", 422, "UNKNOWN"),
  scenario("healthy", "合法订单无需修复", 200, "NONE", { expected: { rootCause: "NONE", status: "resolved", attempts: 1 } })
];
