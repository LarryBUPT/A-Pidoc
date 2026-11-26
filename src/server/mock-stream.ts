import type { StreamFn } from "@earendil-works/pi-agent-core";
import { createAssistantMessageEventStream, type AssistantMessage, type Model } from "@earendil-works/pi-ai";

export const MOCK_MODEL: Model<any> = {
  id: "mock-pi-demo",
  name: "Mock Pi Demo Model",
  api: "openai-completions",
  provider: "mock",
  baseUrl: "http://127.0.0.1",
  reasoning: false,
  input: ["text"],
  cost: { input: 0.27, output: 1.1, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 64_000,
  maxTokens: 4_096
};

interface MockTurnPlan {
  text?: string;
  toolCall?: { id: string; name: string; arguments: Record<string, unknown> };
  inputTokens?: number;
  outputTokens?: number;
}

function emitAssistantMessage(model: Model<any>, plan: MockTurnPlan) {
  const stream = createAssistantMessageEventStream();
  const content: AssistantMessage["content"] = [];
  if (plan.text) {
    content.push({ type: "text", text: plan.text });
  }
  if (plan.toolCall) {
    content.push({
      type: "toolCall",
      id: plan.toolCall.id,
      name: plan.toolCall.name,
      arguments: plan.toolCall.arguments
    });
  }

  const input = plan.inputTokens ?? 420;
  const output = plan.outputTokens ?? 140;
  const message: AssistantMessage = {
    role: "assistant",
    content,
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input,
      output,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: input + output,
      cost: { input: 0.0001, output: 0.00015, cacheRead: 0, cacheWrite: 0, total: 0.00025 }
    },
    stopReason: plan.toolCall ? "toolUse" : "stop",
    timestamp: Date.now()
  };

  queueMicrotask(() => {
    stream.push({ type: "start", partial: message });
    if (plan.text) {
      stream.push({ type: "text_start", contentIndex: 0, partial: message });
      stream.push({ type: "text_delta", contentIndex: 0, delta: plan.text, partial: message });
      stream.push({ type: "text_end", contentIndex: 0, content: plan.text, partial: message });
    }
    stream.push({ type: "done", reason: plan.toolCall ? "toolUse" : "stop", message });
    stream.end(message);
  });

  return stream;
}

/**
 * 免密钥离线演示 StreamFn：
 * 真实驱动 Pi Agent Loop、Skill 加载、OpenAPI 检索、真实 HTTP 靶场请求、
 * 人工审批挂起恢复、EvidenceGate 校验与 Independent Reviewer 复核。
 */
export function createDemoMockStream(options: {
  baseUrl: string;
  scenario: "orders-debug" | "payment-approval";
}): { leadStreamFn: StreamFn; reviewerStreamFn: StreamFn } {
  let step = 0;
  const observedHttpIds: string[] = [];
  let contractEvidenceId = "";

  const leadStreamFn: StreamFn = (model, context) => {
    // 从上下文中提取真实生成的 Evidence ID，保证完全走真实门禁校验而非造假
    for (const message of context.messages) {
      if (message.role === "toolResult") {
        const raw = message.content.map((c) => (c.type === "text" ? c.text : "")).join("");
        const match = raw.match(/"evidenceId"\s*:\s*"([^"]+)"/);
        if (match?.[1]) {
          const id = match[1];
          if (id.startsWith("http_observation_") && !observedHttpIds.includes(id)) {
            observedHttpIds.push(id);
          }
          if (id.startsWith("api_operation_")) {
            contractEvidenceId = id;
          }
        }
      }
    }

    step += 1;

    if (options.scenario === "payment-approval") {
      if (step === 1) {
        return emitAssistantMessage(model, {
          text: "我将先按需加载 api-debug 技能规程，并检索支付接口契约。",
          toolCall: { id: "tc_1", name: "load_skill", arguments: { skillName: "api-debug" } }
        });
      }
      if (step === 2) {
        return emitAssistantMessage(model, {
          text: "正在检索 OpenAPI 中的 payment charge 接口规范。",
          toolCall: { id: "tc_2", name: "get_openapi_operation", arguments: { operationIdOrPath: "chargePayment" } }
        });
      }
      if (step === 3) {
        return emitAssistantMessage(model, {
          text: "支付扣款属于变更类写操作，我发起受控扣款请求并等待人工审批。",
          toolCall: {
            id: "tc_3",
            name: "execute_http_mutation",
            arguments: {
              url: `${options.baseUrl}/sandbox/payments/charge`,
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                "X-API-Client": "checkout-svc",
                "Idempotency-Key": "idem-demo-001"
              },
              body: { orderId: "ord_demo_2026", totalCents: 9900 }
            }
          }
        });
      }
      if (step === 4) {
        // 批准恢复后，精确重放同一调用
        return emitAssistantMessage(model, {
          text: "已收到人工批准，按完全一致的参数重新发起受控扣款请求。",
          toolCall: {
            id: "tc_4",
            name: "execute_http_mutation",
            arguments: {
              url: `${options.baseUrl}/sandbox/payments/charge`,
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                "X-API-Client": "checkout-svc",
                "Idempotency-Key": "idem-demo-001"
              },
              body: { orderId: "ord_demo_2026", totalCents: 9900 }
            }
          }
        });
      }
      if (step === 5) {
        return emitAssistantMessage(model, {
          text: "真实沙箱扣款已返回 200，正在提交带证据锚点的最终报告交由门禁与独立 Reviewer 审核。",
          toolCall: {
            id: "tc_5",
            name: "submit_completion",
            arguments: {
              proposal: {
                summary: "已核对支付接口契约，在获得人工审批后补齐 X-API-Client 与 Idempotency-Key 并完成 200 验证。",
                rootCause: "MISSING_AUTH_AND_IDEMPOTENCY_HEADERS",
                claims: [
                  {
                    statement: "OpenAPI 要求 POST /sandbox/payments/charge 携带 X-API-Client=checkout-svc 与 Idempotency-Key。",
                    evidenceIds: [contractEvidenceId || observedHttpIds[0] || "missing"]
                  },
                  {
                    statement: "经人工批准后执行受控扣款请求，服务端返回 HTTP 200。",
                    evidenceIds: [observedHttpIds.at(-1) || "missing"]
                  }
                ],
                verifiedHttpIds: observedHttpIds,
                recommendations: ["在调用方统一注入 X-API-Client 与幂等键，并对生产支付操作保持审批门禁。"]
              }
            }
          }
        });
      }
      return emitAssistantMessage(model, { text: "已完成支付扣款验证并结束调查。" });
    }

    // Default scenario: orders-debug (415 -> 201 完整真实排查闭环)
    if (step === 1) {
      return emitAssistantMessage(model, {
        text: "首先按需加载 api-debug 技能并检索 OpenAPI 中与 orders 相关的接口规范。",
        toolCall: { id: "tc_1", name: "load_skill", arguments: { skillName: "api-debug" } }
      });
    }
    if (step === 2) {
      return emitAssistantMessage(model, {
        text: "在多端点 OpenAPI 索引中搜索 orders 相关接口。",
        toolCall: { id: "tc_2", name: "search_openapi", arguments: { query: "orders amount", limit: 3 } }
      });
    }
    if (step === 3) {
      return emitAssistantMessage(model, {
        text: "获取 POST /sandbox/orders 的完整请求 Schema。",
        toolCall: { id: "tc_3", name: "get_openapi_operation", arguments: { operationIdOrPath: "createOrder" } }
      });
    }
    if (step === 4) {
      return emitAssistantMessage(model, {
        text: "先复现用户报告的失败请求（text/plain + 字符串 amount）以获取真实基线证据。",
        toolCall: {
          id: "tc_4",
          name: "execute_http",
          arguments: {
            url: `${options.baseUrl}/sandbox/orders`,
            method: "POST",
            headers: { "Content-Type": "text/plain" },
            body: { sku: "SKU-100", amount: "99", currency: "CNY" }
          }
        }
      });
    }
    if (step === 5) {
      return emitAssistantMessage(model, {
        text: "基线返回 415。根据 OpenAPI 契约同时修正 Content-Type 为 application/json 且将 amount 转为数字 99 后重新验证。",
        toolCall: {
          id: "tc_5",
          name: "execute_http",
          arguments: {
            url: `${options.baseUrl}/sandbox/orders`,
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: { sku: "SKU-100", amount: 99, currency: "CNY" }
          }
        }
      });
    }
    if (step === 6) {
      return emitAssistantMessage(model, {
        text: "修正后的请求已返回 HTTP 201，现提交结构化证据包供 EvidenceGate 与独立 Reviewer 复核。",
        toolCall: {
          id: "tc_6",
          name: "submit_completion",
          arguments: {
            proposal: {
              summary: "定位到 POST /sandbox/orders 因 Content-Type 误传 text/plain 且 amount 为字符串导致失败；按 OpenAPI 修正后实测返回 HTTP 201。",
              rootCause: "CONTENT_TYPE_AND_BODY_SCHEMA_MISMATCH",
              claims: [
                {
                  statement: "OpenAPI 规范要求 POST /sandbox/orders 使用 application/json 且 amount 为正数。",
                  evidenceIds: [contractEvidenceId || observedHttpIds[0] || "missing"]
                },
                {
                  statement: "基线复现请求返回 HTTP 415，修正后同端点返回 HTTP 201。",
                  evidenceIds: observedHttpIds
                }
              ],
              verifiedHttpIds: observedHttpIds,
              recommendations: ["在客户端序列化前增加 Zod/JSON Schema 校验，并固定 Content-Type: application/json。"]
            }
          }
        }
      });
    }
    return emitAssistantMessage(model, { text: "诊断流程已结束。" });
  };

  const reviewerStreamFn: StreamFn = (model) =>
    emitAssistantMessage(model, {
      text: JSON.stringify({
        verdict: "pass",
        rationale: "All claims cite verified SHA-256 Evidence Artifacts, baseline failure and 2xx verification are consistent.",
        issues: []
      }),
      inputTokens: 310,
      outputTokens: 65
    });

  return { leadStreamFn, reviewerStreamFn };
}
