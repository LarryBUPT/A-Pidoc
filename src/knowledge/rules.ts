import type { HttpResult, KnowledgeRule } from "../domain/types.js";

export const knowledgeRules: KnowledgeRule[] = [
  {
    id: "http-401-bearer",
    statuses: [401],
    keywords: ["authorization", "bearer", "token"],
    guidance: "对照接口规范检查 Authorization 的 scheme 与 token，不要在日志中输出真实 token。"
  },
  {
    id: "http-415-content-type",
    statuses: [415],
    keywords: ["content-type", "json", "media type"],
    guidance: "JSON 请求体通常需要 application/json，并应以接口规范为最终依据。"
  },
  {
    id: "http-422-schema",
    statuses: [400, 422],
    keywords: ["field", "type", "schema", "validation"],
    guidance: "逐字段比较必填项和 JSON 类型，只修改有规范证据的字段。"
  },
  {
    id: "http-405-method",
    statuses: [405],
    keywords: ["method", "allow"],
    guidance: "以 OpenAPI 或响应 Allow 头为准修正 HTTP method。"
  },
  {
    id: "http-429-retry",
    statuses: [429],
    keywords: ["rate", "limit", "retry-after"],
    guidance: "遵守 Retry-After 并限制重试次数，避免形成重试风暴。"
  }
];

export function retrieveRules(result: HttpResult): KnowledgeRule[] {
  const text = JSON.stringify(result).toLowerCase();
  return knowledgeRules
    .map((rule) => ({
      rule,
      score:
        (rule.statuses.includes(result.status) ? 10 : 0) +
        rule.keywords.filter((keyword) => text.includes(keyword)).length
    }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3)
    .map((item) => item.rule);
}
