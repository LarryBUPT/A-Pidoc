import type { HttpMethod } from "../domain/types.js";

export interface SourceLocation {
  file: string;
  line: number;
}

export interface ValueSource {
  kind: "literal" | "constant" | "import" | "environment" | "unresolved";
  expression: string;
  environment?: string;
  chain: SourceLocation[];
}

export interface DiscoveredApiCall extends SourceLocation {
  client: "fetch" | "axios" | "requests" | "okhttp";
  method: HttpMethod;
  url: string;
  openApiOperation: string | null;
  headers: Record<string, string>;
  body: Record<string, unknown> | null;
  sources: {
    url: ValueSource;
    method: ValueSource;
    headers: ValueSource;
    body: ValueSource;
  };
  sourceText: string;
}

export interface UnresolvedApiCall extends SourceLocation {
  client: DiscoveredApiCall["client"];
  method: HttpMethod;
  expression: string;
  source: ValueSource;
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
  unresolvedCalls: UnresolvedApiCall[];
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
  kind: "append" | "replace";
  findingCode: RepositoryFindingCode;
  file: string;
  line: number;
  title: string;
  before: string;
  after: string;
  verification: string[];
  requiresApproval: boolean;
}

export interface RepositoryTestRun {
  command: string[];
  exitCode: number | null;
  durationMs: number;
  stdout: string;
  stderr: string;
  passed: boolean;
}

export interface RepositoryVerificationReport {
  sourceRoot: string;
  workspaceRoot: string;
  before: RepositoryReport;
  after: RepositoryReport;
  appliedPatches: RepositoryPatchPlan[];
  writtenTests: string[];
  testRun: RepositoryTestRun;
  passed: boolean;
}
