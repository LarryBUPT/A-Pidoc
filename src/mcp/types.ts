import type { Environment } from "../harness/contracts.js";
import type { OpenApiDocumentDescription, OpenApiOperationDescription } from "../input/openapi-parser.js";

export interface McpServerConfig {
  document: unknown;
  allowedHosts: string[];
  allowedPorts: number[];
  runFile: string;
  environment?: Environment;
  timeoutMs?: number;
  maxResponseBytes?: number;
}

export interface ReadApiDocumentInput {
  operationId?: string;
}

export interface ExecuteHttpInput {
  operationId: string;
  headers?: Record<string, string>;
  query?: Record<string, string>;
  pathParams?: Record<string, string>;
  body?: Record<string, unknown> | null;
}

export interface ReadEvidenceInput {
  id: string;
}

export interface RegisteredApiDocument {
  id: string;
  document: Record<string, unknown>;
  description: OpenApiDocumentDescription;
  operations: Map<string, OpenApiOperationDescription>;
}

export interface McpCallTrace {
  type: "mcp_call_trace";
  toolName: string;
  callId: string;
  protocolRequestId?: string;
  startTime: string;
  endTime: string;
  durationMs: number;
  inputSummary: Record<string, unknown>;
  executionResult: "succeeded" | "failed";
  httpStatus: number | null;
  generatedArtifactId: string | null;
  artifactIds: string[];
  errorCode: string | null;
}

export interface McpToolOutput {
  callId: string;
  artifactId: string | null;
  artifactIds: string[];
  [key: string]: unknown;
}

export class McpToolCallError extends Error {
  constructor(readonly output: McpToolOutput) {
    super(String(output.errorCode ?? "MCP_TOOL_CALL_FAILED"));
    this.name = "McpToolCallError";
  }
}
