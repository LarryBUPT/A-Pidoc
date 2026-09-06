import type { Diagnosis, Reasoner } from "../domain/types.js";
import { classifyFault, faultSummary, proposedRepair } from "./fault-analysis.js";

export class DeterministicReasoner implements Reasoner {
  readonly runtime = { mode: "deterministic", fallback: "none" } as const;

  async diagnose(input: Parameters<Reasoner["diagnose"]>[0]): Promise<Diagnosis> {
    const rootCause = classifyFault(input);
    return {
      rootCause,
      summary: faultSummary(rootCause),
      action: proposedRepair(input, rootCause),
      evidence: [
        { source: input.result.errorType ? "tool_error" : "http_response", detail: `${input.result.errorType ?? `HTTP ${input.result.status}`}: ${JSON.stringify(input.result.body)}` },
        { source: "api_spec", detail: `规范方法 ${input.spec.method}；字段 ${Object.keys(input.spec.requiredBody).join(",") || "bodySchema/none"}。` },
        ...input.rules.map((rule) => ({ source: "knowledge_rule" as const, detail: `${rule.id}: ${rule.guidance}` }))
      ]
    };
  }
}
