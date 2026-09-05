import type { DebugCase } from "../domain/types.js";

const baseSpec = {
  method: "POST" as const,
  requiredHeaders: {
    Authorization: "Bearer demo-token",
    "Content-Type": "application/json"
  },
  requiredBody: {
    amount: "number" as const,
    currency: "string" as const
  }
};

export const cases: DebugCase[] = [
  {
    id: "auth-header",
    title: "Authorization 缺少 Bearer 前缀",
    source: "fixture",
    behavior: "AUTH_HEADER_FORMAT",
    request: {
      method: "POST",
      url: "https://fixture.local/orders",
      headers: { Authorization: "demo-token", "Content-Type": "application/json" },
      body: { amount: 100, currency: "CNY" }
    },
    spec: baseSpec,
    expectedRootCause: "AUTH_HEADER_FORMAT"
  },
  {
    id: "content-type",
    title: "Content-Type 与 JSON 请求体不匹配",
    source: "fixture",
    behavior: "CONTENT_TYPE_MISMATCH",
    request: {
      method: "POST",
      url: "https://fixture.local/orders",
      headers: { Authorization: "Bearer demo-token", "Content-Type": "text/plain" },
      body: { amount: 100, currency: "CNY" }
    },
    spec: baseSpec,
    expectedRootCause: "CONTENT_TYPE_MISMATCH"
  },
  {
    id: "body-type",
    title: "amount 字段类型错误",
    source: "fixture",
    behavior: "BODY_TYPE_MISMATCH",
    request: {
      method: "POST",
      url: "https://fixture.local/orders",
      headers: { Authorization: "Bearer demo-token", "Content-Type": "application/json" },
      body: { amount: "100", currency: "CNY" }
    },
    spec: baseSpec,
    expectedRootCause: "BODY_TYPE_MISMATCH"
  },
  {
    id: "http-method",
    title: "HTTP 方法错误",
    source: "fixture",
    behavior: "HTTP_METHOD_MISMATCH",
    request: {
      method: "GET",
      url: "https://fixture.local/orders",
      headers: { Authorization: "Bearer demo-token", "Content-Type": "application/json" },
      body: { amount: 100, currency: "CNY" }
    },
    spec: baseSpec,
    expectedRootCause: "HTTP_METHOD_MISMATCH"
  },
  {
    id: "rate-limit",
    title: "第一次请求被限流，受控重试后成功",
    source: "fixture",
    behavior: "RATE_LIMIT_TRANSIENT",
    request: {
      method: "POST",
      url: "https://fixture.local/orders",
      headers: { Authorization: "Bearer demo-token", "Content-Type": "application/json" },
      body: { amount: 100, currency: "CNY" }
    },
    spec: baseSpec,
    expectedRootCause: "RATE_LIMIT_TRANSIENT"
  },
  {
    id: "healthy",
    title: "请求原本就是正确的",
    source: "fixture",
    behavior: "NONE",
    request: {
      method: "POST",
      url: "https://fixture.local/orders",
      headers: { Authorization: "Bearer demo-token", "Content-Type": "application/json" },
      body: { amount: 100, currency: "CNY" }
    },
    spec: baseSpec,
    expectedRootCause: "NONE"
  }
];

export function getCase(id: string): DebugCase {
  const found = cases.find((item) => item.id === id);
  if (!found) throw new Error(`Unknown fixture case: ${id}`);
  return structuredClone(found);
}
