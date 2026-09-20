import type { HarnessTool } from "../../harness/contracts.js";
import { closed, defineTool, result } from "../../api-harness/tool-bundles.js";
import { isSensitiveKey } from "../../security/redaction.js";
import type { RegisteredApiDocument, ReadApiDocumentInput } from "../types.js";

export function createReadApiDocumentTool(api: RegisteredApiDocument): HarnessTool {
  return defineTool(
    "read_api_document",
    "mcp-runtime-api",
    "Read the host-registered OpenAPI/Swagger document and return structured operations, header requirements, and request schemas.",
    closed({ operationId: { type: "string", minLength: 1, maxLength: 160 } }),
    "api_operation",
    async (raw, context) => {
      const { operationId } = raw as ReadApiDocumentInput;
      const selected = operationId
        ? api.description.operations.filter(operation => operation.operationId === operationId)
        : api.description.operations;
      if (operationId && selected.length !== 1) throw new Error("UNKNOWN_API_OPERATION");
      const operations = selected.map(operation => ({
        ...operation,
        headers: operation.headers.map(header => isSensitiveKey(header.name)
          ? { ...header, schema: { redacted: true } }
          : header)
      }));
      return result(context, "api_operation", {
        documentId: api.id,
        title: api.description.title,
        version: api.description.version,
        operations
      });
    }
  );
}
