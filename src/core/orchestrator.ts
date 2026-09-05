import { randomUUID } from "node:crypto";
import type {
  ApiRequest,
  Attempt,
  DebugCase,
  DebugReport,
  Diagnosis,
  HttpTool,
  Reasoner,
  RootCause
} from "../domain/types.js";
import { retrieveRules } from "../knowledge/rules.js";
import { TraceRecorder } from "../observability/trace.js";
import { RequestPolicy } from "../security/request-policy.js";
import { EvidenceReviewer } from "../agent/reviewer.js";

function applyDiagnosis(request: ApiRequest, diagnosis: Diagnosis): ApiRequest {
  const next = structuredClone(request);
  switch (diagnosis.action.kind) {
    case "set_header":
      next.headers[diagnosis.action.name] = diagnosis.action.value;
      break;
    case "set_body":
      next.body ??= {};
      next.body[diagnosis.action.name] = diagnosis.action.value;
      break;
    case "set_method":
      next.method = diagnosis.action.value;
      break;
    case "retry":
    case "stop":
      break;
  }
  return next;
}

export class DebugOrchestrator {
  constructor(
    private readonly httpTool: HttpTool,
    private readonly reasoner: Reasoner,
    private readonly reviewer = new EvidenceReviewer(),
    private readonly policy = new RequestPolicy()
  ) {}

  async run(caseData: DebugCase): Promise<DebugReport> {
    const trace = new TraceRecorder();
    const originalRequest = structuredClone(caseData.request);
    let current = structuredClone(caseData.request);
    const attempts: Attempt[] = [];
    let observedRootCause: RootCause = "UNKNOWN";

    try {
      await trace.span("normalize_input", async () => current, { caseId: caseData.id });

      for (let index = 1; index <= this.policy.maxAttempts; index += 1) {
        await trace.span("policy_check", async () => this.policy.assertAllowed(current), {
          attempt: index,
          host: new URL(current.url).hostname
        });
        const result = await trace.span("http_tool", () => this.httpTool.execute(caseData, current), {
          attempt: index,
          method: current.method
        });
        const attempt: Attempt = { index, request: structuredClone(current), result };
        attempts.push(attempt);

        if (result.status >= 200 && result.status < 300) {
          if (attempts.length === 1) observedRootCause = "NONE";
          break;
        }

        const rules = await trace.span("knowledge_retrieval", async () => retrieveRules(result), {
          status: result.status
        });
        const diagnosis = await trace.span("diagnose_and_plan", () =>
          this.reasoner.diagnose({ request: current, spec: caseData.spec, result, rules })
        );
        attempt.diagnosis = diagnosis;
        if (observedRootCause === "UNKNOWN") observedRootCause = diagnosis.rootCause;
        if (diagnosis.action.kind === "stop") break;
        current = applyDiagnosis(current, diagnosis);
      }

      const evaluation = await trace.span("evidence_review", async () =>
        this.reviewer.review(attempts, caseData.expectedRootCause, observedRootCause)
      );
      const last = attempts.at(-1);
      return {
        runId: randomUUID(),
        caseId: caseData.id,
        status: evaluation.requestSucceeded ? "resolved" : "unresolved",
        originalRequest,
        finalRequest: structuredClone(current),
        attempts,
        rootCause: observedRootCause,
        summary: evaluation.passed ? "根因识别、修正和证据复核全部通过。" : "执行完成，但评测未全部通过。",
        evaluation,
        trace: trace.snapshot()
      };
    } catch (error) {
      return {
        runId: randomUUID(),
        caseId: caseData.id,
        status: "blocked",
        originalRequest,
        finalRequest: current,
        attempts,
        rootCause: "UNKNOWN",
        summary: error instanceof Error ? error.message : "unknown error",
        evaluation: {
          passed: false,
          requestSucceeded: false,
          rootCauseMatched: false,
          evidenceComplete: false
        },
        trace: trace.snapshot()
      };
    }
  }
}
