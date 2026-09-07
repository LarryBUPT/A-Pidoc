import type { HttpMethod } from "../domain/types.js";

export interface SourceLocation {
  file: string;
  line: number;
}

export interface DiscoveredApiCall extends SourceLocation {
  client: "fetch" | "axios" | "requests" | "okhttp";
  method: HttpMethod;
  url: string;
  openApiOperation: string | null;
  headers: Record<string, string>;
  body: Record<string, unknown> | null;
  sourceText: string;
}

export interface EnvironmentReference extends SourceLocation {
  name: string;
  declaredInExample: boolean;
}

export type RepositoryFindingCode =
  | "OPENAPI_OPERATION_MISSING"
  | "ENV_NOT_DECLARED"
  | "DYNAMIC_FETCH_UNSUPPORTED"
  | "FILE_TOO_LARGE"
  | "UNSUPPORTED_CLIENT_SYNTAX"
  | "DYNAMIC_URL_UNSUPPORTED"
  | "CONFIG_NOT_RESOLVED";

export interface RepositoryFinding extends SourceLocation {
  code: RepositoryFindingCode;
  severity: "error" | "warning" | "info";
  message: string;
}

export interface RepositoryReport {
  root: string;
  scannedFiles: number;
  apiCalls: DiscoveredApiCall[];
  environmentReferences: EnvironmentReference[];
  findings: RepositoryFinding[];
  summary: {
    calls: number;
    matchedOperations: number;
    errors: number;
    warnings: number;
  };
}

export interface RepositoryTask {
  id: string;
  call: DiscoveredApiCall;
  findingCodes: RepositoryFindingCode[];
  debugTask: import("../domain/types.js").DebugTask | null;
}

export interface RepositoryTestPlan {
  path: string;
  content: string;
  callId: string;
  rationale: string;
}

export interface RepositoryPatchPlan {
  file: string;
  line: number;
  title: string;
  before: string;
  after: string;
  verification: string[];
  requiresApproval: boolean;
}
