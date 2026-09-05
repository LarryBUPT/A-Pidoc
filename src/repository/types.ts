import type { HttpMethod } from "../domain/types.js";

export interface SourceLocation {
  file: string;
  line: number;
}

export interface DiscoveredApiCall extends SourceLocation {
  method: HttpMethod;
  url: string;
  openApiOperation: string | null;
}

export interface EnvironmentReference extends SourceLocation {
  name: string;
  declaredInExample: boolean;
}

export type RepositoryFindingCode =
  | "OPENAPI_OPERATION_MISSING"
  | "ENV_NOT_DECLARED"
  | "DYNAMIC_FETCH_UNSUPPORTED"
  | "FILE_TOO_LARGE";

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
