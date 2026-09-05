import type { Diagnosis, Reasoner } from "../domain/types.js";

function ruleEvidence(rules: Parameters<Reasoner["diagnose"]>[0]["rules"]) {
  return rules.map((rule) => ({
    source: "knowledge_rule" as const,
    detail: `${rule.id}: ${rule.guidance}`
  }));
}

export class DeterministicReasoner implements Reasoner {
  async diagnose(input: Parameters<Reasoner["diagnose"]>[0]): Promise<Diagnosis> {
    const common = [
      { source: "http_response" as const, detail: `HTTP ${input.result.status}: ${JSON.stringify(input.result.body)}` },
      ...ruleEvidence(input.rules)
    ];

    if (input.result.status >= 200 && input.result.status < 300) {
      return {
        rootCause: "NONE",
        summary: "请求已经成功，无需修正。",
        action: { kind: "stop" },
        evidence: common
      };
    }

    if (input.result.status === 401) {
      return {
        rootCause: "AUTH_HEADER_FORMAT",
        summary: "Authorization 格式与接口规范不一致。",
        action: { kind: "set_header", name: "Authorization", value: input.spec.requiredHeaders.Authorization ?? "" },
        evidence: [...common, { source: "api_spec", detail: "规范要求 Authorization 使用 Bearer scheme。" }]
      };
    }
    if (input.result.status === 415) {
      return {
        rootCause: "CONTENT_TYPE_MISMATCH",
        summary: "JSON 请求体使用了错误的 Content-Type。",
        action: { kind: "set_header", name: "Content-Type", value: input.spec.requiredHeaders["Content-Type"] ?? "application/json" },
        evidence: [...common, { source: "api_spec", detail: "规范声明请求体为 application/json。" }]
      };
    }
    if (input.result.status === 422) {
      const field = String(input.result.body.field ?? "");
      const expected = input.spec.requiredBody[field];
      const current = input.request.body?.[field];
      const value = expected === "number" ? Number(current) : expected === "boolean" ? Boolean(current) : String(current);
      return {
        rootCause: "BODY_TYPE_MISMATCH",
        summary: `${field} 字段类型与接口规范不一致。`,
        action: { kind: "set_body", name: field, value },
        evidence: [...common, { source: "api_spec", detail: `规范要求 ${field} 类型为 ${expected}。` }]
      };
    }
    if (input.result.status === 405) {
      return {
        rootCause: "HTTP_METHOD_MISMATCH",
        summary: "请求方法与接口规范不一致。",
        action: { kind: "set_method", value: input.spec.method },
        evidence: [...common, { source: "api_spec", detail: `规范要求 HTTP ${input.spec.method}。` }]
      };
    }
    if (input.result.status === 429) {
      return {
        rootCause: "RATE_LIMIT_TRANSIENT",
        summary: "接口发生临时限流，按策略执行一次受控重试。",
        action: { kind: "retry" },
        evidence: common
      };
    }

    return {
      rootCause: "UNKNOWN",
      summary: "现有规范和规则不足以确定根因，停止自动修改。",
      action: { kind: "stop" },
      evidence: common
    };
  }
}
