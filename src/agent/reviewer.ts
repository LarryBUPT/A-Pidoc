import type { Attempt, Evaluation, RootCause } from "../domain/types.js";

export class EvidenceReviewer {
  review(attempts: Attempt[], observedRootCause: RootCause, expectedRootCause?: RootCause): Evaluation {
    const last = attempts.at(-1);
    const requestSucceeded = Boolean(last && last.result.status >= 200 && last.result.status < 300);
    const rootCauseMatched = expectedRootCause === undefined ? null : observedRootCause === expectedRootCause;
    const evidenceComplete =
      observedRootCause === "NONE" || attempts.some((attempt) => (attempt.diagnosis?.evidence.length ?? 0) >= 2);
    return {
      passed: requestSucceeded && rootCauseMatched !== false && evidenceComplete,
      requestSucceeded,
      rootCauseMatched,
      evidenceComplete
    };
  }
}
