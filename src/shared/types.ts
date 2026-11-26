export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export type RuntimeEnvironment = "sandbox" | "staging" | "production";

export interface ApiRequest {
  method: HttpMethod;
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown> | null;
}

export interface HttpResult {
  status: number;
  headers: Record<string, string>;
  body: Record<string, unknown>;
  durationMs: number;
  errorType?: "REQUEST_TIMEOUT" | "NETWORK_ERROR" | "INVALID_JSON_RESPONSE";
}

export type ToolRiskLevel = "read" | "network_read" | "network_write" | "write";

export interface EvidenceArtifact {
  id: string;
  kind: string;
  toolCallId: string;
  toolName: string;
  sha256: string;
  createdAt: string;
  summary: string;
  data: unknown;
}
