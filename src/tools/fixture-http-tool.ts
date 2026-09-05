import type { ApiRequest, DebugCase, HttpResult, HttpTool } from "../domain/types.js";

export class FixtureHttpTool implements HttpTool {
  private calls = 0;

  constructor(private readonly caseData: DebugCase) {}

  async execute(request: ApiRequest): Promise<HttpResult> {
    const started = performance.now();
    const count = ++this.calls;
    const caseData = this.caseData;

    let status = 200;
    let body: Record<string, unknown> = { orderId: `order-${caseData.id}`, accepted: true };
    let headers: Record<string, string> = { "content-type": "application/json" };

    switch (caseData.behavior) {
      case "AUTH_HEADER_FORMAT":
        if (request.headers.Authorization !== caseData.spec.requiredHeaders.Authorization) {
          status = 401;
          body = { error: "invalid authorization: expected Bearer token" };
        }
        break;
      case "CONTENT_TYPE_MISMATCH":
        if (request.headers["Content-Type"] !== caseData.spec.requiredHeaders["Content-Type"]) {
          status = 415;
          body = { error: "unsupported media type: expected application/json" };
        }
        break;
      case "BODY_TYPE_MISMATCH":
        if (typeof request.body?.amount !== "number") {
          status = 422;
          body = { error: "validation failed", field: "amount", expectedType: "number" };
        }
        break;
      case "HTTP_METHOD_MISMATCH":
        if (request.method !== caseData.spec.method) {
          status = 405;
          headers = { ...headers, allow: caseData.spec.method };
          body = { error: `method not allowed: expected ${caseData.spec.method}` };
        }
        break;
      case "RATE_LIMIT_TRANSIENT":
        if (count === 1) {
          status = 429;
          headers = { ...headers, "retry-after": "0" };
          body = { error: "rate limit exceeded; retry-after=0" };
        }
        break;
      case "NONE":
      case "UNKNOWN":
        break;
    }

    return { status, body, headers, durationMs: Math.max(1, Math.round(performance.now() - started)) };
  }
}
