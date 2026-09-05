export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export type RootCause =
  | "AUTH_HEADER_FORMAT"
  | "CONTENT_TYPE_MISMATCH"
  | "BODY_TYPE_MISMATCH"
  | "HTTP_METHOD_MISMATCH"
  | "RATE_LIMIT_TRANSIENT"
  | "NONE"
  | "UNKNOWN";

export interface ApiRequest {
  method: HttpMethod;
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown> | null;
}

export interface ApiSpec {
  method: HttpMethod;
  requiredHeaders: Record<string, string>;
  requiredBody: Record<string, "string" | "number" | "boolean">;
}

export interface HttpResult {
  status: number;
  body: Record<string, unknown>;
  headers: Record<string, string>;
  durationMs: number;
}

export interface Evidence {
  source: "http_response" | "api_spec" | "knowledge_rule" | "policy";
  detail: string;
}

export type FixAction =
  | { kind: "set_header"; name: string; value: string }
  | { kind: "set_body"; name: string; value: unknown }
  | { kind: "set_method"; value: HttpMethod }
  | { kind: "retry" }
  | { kind: "stop" };

export interface Diagnosis {
  rootCause: RootCause;
  summary: string;
  action: FixAction;
  evidence: Evidence[];
}

export interface KnowledgeRule {
  id: string;
  statuses: number[];
  keywords: string[];
  guidance: string;
}

export interface TraceEvent {
  seq: number;
  stage: string;
  status: "started" | "succeeded" | "failed";
  at: string;
  durationMs?: number;
  metadata?: Record<string, unknown>;
}

export interface Attempt {
  index: number;
  request: ApiRequest;
  result: HttpResult;
  diagnosis?: Diagnosis;
}

export interface DebugCase {
  id: string;
  title: string;
  behavior: RootCause;
  request: ApiRequest;
  spec: ApiSpec;
  expectedRootCause: RootCause;
}

export interface Evaluation {
  passed: boolean;
  requestSucceeded: boolean;
  rootCauseMatched: boolean;
  evidenceComplete: boolean;
}

export interface DebugReport {
  runId: string;
  caseId: string;
  status: "resolved" | "unresolved" | "blocked";
  originalRequest: ApiRequest;
  finalRequest: ApiRequest;
  attempts: Attempt[];
  rootCause: RootCause;
  summary: string;
  evaluation: Evaluation;
  trace: TraceEvent[];
}

export interface HttpTool {
  execute(caseData: DebugCase, request: ApiRequest): Promise<HttpResult>;
}

export interface Reasoner {
  diagnose(input: {
    request: ApiRequest;
    spec: ApiSpec;
    result: HttpResult;
    rules: KnowledgeRule[];
  }): Promise<Diagnosis>;
}
