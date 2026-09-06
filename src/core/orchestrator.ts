import { randomUUID } from "node:crypto";
import type {
  ApiRequest,
  Attempt,
  DebugReport,
  DebugTask,
  Diagnosis,
  EvaluationExpectation,
  HttpTool,
  HttpResult,
  Reasoner,
  RootCause
} from "../domain/types.js";
import { retrieveRules } from "../knowledge/rules.js";
import { TraceRecorder } from "../observability/trace.js";
import { RequestPolicy } from "../security/request-policy.js";
import { EvidenceReviewer } from "../agent/reviewer.js";
import { redactDiagnosis, redactRequest } from "../security/redaction.js";
import { PublicError, safeError } from "../security/errors.js";
import { actionIsSupported, classifyFault } from "../agent/fault-analysis.js";

function applyDiagnosis(request: ApiRequest, diagnosis: Diagnosis): ApiRequest {
  const next = structuredClone(request);
  switch (diagnosis.action.kind) {
    case "set_header":
      for (const existing of Object.keys(next.headers)) {
        if (existing.toLowerCase() === diagnosis.action.name.toLowerCase()) delete next.headers[existing];
      }
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

  async run(task: DebugTask, expectation?: EvaluationExpectation): Promise<DebugReport> {
    const trace = new TraceRecorder();
    const originalRequest = structuredClone(task.request);
    let current = structuredClone(task.request);
    const attempts: Attempt[] = [];
    let observedRootCause: RootCause = "UNKNOWN";
    let reasonerCalls = 0;

    try {
      await trace.span("normalize_input", async () => current, {
        taskId: task.id,
        inputSource: task.source,
        redacted: true
      });

      for (let index = 1; index <= this.policy.maxAttempts; index += 1) {
        await trace.span("policy_check", async () => this.policy.assertAllowed(current), {
          attempt: index,
          host: new URL(current.url).hostname
        });
        const result = await trace.span("http_tool", async (): Promise<HttpResult> => {
          try { return await this.httpTool.execute(current); } catch (error) {
            if (!(error instanceof PublicError) || !["REQUEST_TIMEOUT", "NETWORK_ERROR"].includes(error.code)) throw error;
            return { status: 0, body: { error: error.message }, headers: {}, durationMs: 0, errorType: error.code as "REQUEST_TIMEOUT" | "NETWORK_ERROR" };
          }
        }, {
          attempt: index,
          method: current.method,
          inputSource: task.source,
          redacted: true
        });
        const attempt: Attempt = { index, request: redactRequest(current), result };
        attempts.push(attempt);

        if (result.status >= 200 && result.status < 300 && !result.errorType) {
          if (attempts.length === 1) observedRootCause = "NONE";
          break;
        }

        const rules = await trace.span("knowledge_retrieval", async () => retrieveRules(result), {
          status: result.status
        });
        if (reasonerCalls >= this.policy.maxReasonerCalls) {
          throw new PublicError("MODEL_CALL_BUDGET_EXCEEDED", "Model call budget exceeded for this task", 429);
        }
        reasonerCalls += 1;
        const diagnosis = await trace.span(
          "diagnose_and_plan",
          () => this.reasoner.diagnose({ request: current, spec: task.spec, result, rules }),
          { ...this.reasoner.runtime }
        );
        if (diagnosis.rootCause !== classifyFault({ request: current, spec: task.spec, result, rules })) {
          throw new PublicError("UNSUPPORTED_DIAGNOSIS", "Diagnosis does not match the available evidence");
        }
        attempt.diagnosis = redactDiagnosis(diagnosis);
        if (observedRootCause === "UNKNOWN") observedRootCause = diagnosis.rootCause;
        if (diagnosis.action.kind === "stop") break;
        if (!actionIsSupported({ request: current, spec: task.spec, result, rules }, diagnosis.action)) {
          throw new PublicError("UNSUPPORTED_REPAIR", "Repair is not supported by the request and specification evidence");
        }
        if (index === this.policy.maxAttempts) break;
        if (diagnosis.action.kind === "retry") {
          const raw = result.headers["retry-after"];
          const delay = raw === undefined ? 200 * index : /^\d+(?:\.\d+)?$/.test(raw) ? Number(raw) * 1000 : Date.parse(raw) - Date.now();
          if (!Number.isFinite(delay) || delay > 1_000) break;
          await trace.span("retry_delay", () => new Promise<void>((resolve) => setTimeout(resolve, Math.max(0, delay))), { delayMs: Math.max(0, delay) });
        }
        current = applyDiagnosis(current, diagnosis);
      }

      const evaluation = await trace.span("evidence_review", async () =>
        this.reviewer.review(attempts, observedRootCause, expectation?.expectedRootCause)
      );
      return {
        runId: randomUUID(),
        taskId: task.id,
        inputSource: task.source,
        status: evaluation.passed ? "resolved" : "unresolved",
        originalRequest: redactRequest(originalRequest),
        finalRequest: redactRequest(current),
        attempts,
        rootCause: observedRootCause,
        summary: evaluation.passed ? "根因识别、修正和证据复核全部通过。" : "执行完成，但评测未全部通过。",
        evaluation,
        trace: trace.snapshot()
      };
    } catch (error) {
      const safe = safeError(error);
      return {
        runId: randomUUID(),
        taskId: task.id,
        inputSource: task.source,
        status: "blocked",
        originalRequest: redactRequest(originalRequest),
        finalRequest: redactRequest(current),
        attempts,
        rootCause: "UNKNOWN",
        summary: `${safe.code}: ${safe.message}`,
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
