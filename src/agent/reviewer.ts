import type { Attempt, Evaluation, RootCause } from "../domain/types.js";

export class EvidenceReviewer {
  review(attempts: Attempt[], observedRootCause: RootCause, expectedRootCause?: RootCause): Evaluation {
    const last = attempts.at(-1);
    const requestSucceeded = Boolean(last && last.result.status >= 200 && last.result.status < 300 && !last.result.errorType);
    const rootCauseMatched = expectedRootCause === undefined ? null : observedRootCause === expectedRootCause;
    const evidenceComplete =
      observedRootCause === "NONE" ? attempts.length === 1 && requestSucceeded : attempts.some((attempt) => attempt.diagnosis?.rootCause === observedRootCause) &&
        attempts.every((attempt, index) => {
          const diagnosis = attempt.diagnosis;
          if (!diagnosis) return index === attempts.length - 1 && requestSucceeded;
          const source = attempt.result.errorType ? "tool_error" : "http_response";
          const marker = attempt.result.errorType ?? `HTTP ${attempt.result.status}`;
          if (!diagnosis.evidence.some((item) => item.source === source && item.detail.includes(marker)) ||
              !diagnosis.evidence.some((item) => item.source === "api_spec")) return false;
          const next = attempts[index + 1];
          if (!next) return true;
          if (diagnosis.action.kind === "stop") return false;
          const expected = structuredClone(attempt.request);
          const action = diagnosis.action;
          if (action.kind === "set_method") expected.method = action.value;
          if (action.kind === "set_body") { expected.body ??= {}; expected.body[action.name] = action.value; }
          if (action.kind === "set_header") {
            for (const name of Object.keys(expected.headers)) if (name.toLowerCase() === action.name.toLowerCase()) delete expected.headers[name];
            expected.headers[action.name] = action.value;
          }
          return JSON.stringify(expected) === JSON.stringify(next.request);
        });
    return {
      passed: requestSucceeded && rootCauseMatched !== false && evidenceComplete,
      requestSucceeded,
      rootCauseMatched,
      evidenceComplete
    };
  }
}
