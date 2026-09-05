import type { Attempt, Evaluation, RootCause } from "../domain/types.js";

export class EvidenceReviewer {
  review(attempts: Attempt[], expectedRootCause: RootCause, observedRootCause: RootCause): Evaluation {
    const last = attempts.at(-1);
    const requestSucceeded = Boolean(last && last.result.status >= 200 && last.result.status < 300);
    const rootCauseMatched = observedRootCause === expectedRootCause;
    const evidenceComplete =
      expectedRootCause === "NONE" || attempts.some((attempt) => (attempt.diagnosis?.evidence.length ?? 0) >= 2);
    return {
      passed: requestSucceeded && rootCauseMatched && evidenceComplete,
      requestSucceeded,
      rootCauseMatched,
      evidenceComplete
    };
  }
}
