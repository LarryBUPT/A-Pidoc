import type { HarnessTool } from "../../harness/contracts.js";
import { closed, defineTool, result } from "../../api-harness/tool-bundles.js";
import { parseOpenApiOperation } from "../../input/openapi-parser.js";
import { RealHttpTool } from "../../tools/real-http-tool.js";
import type { ExecuteHttpInput, RegisteredApiDocument } from "../types.js";

export interface ExecuteHttpToolOptions {
  allowedHosts: string[];
  allowedPorts: number[];
  timeoutMs?: number;
  maxResponseBytes?: number;
}

const stringMap = { type: "object", additionalProperties: { type: "string", maxLength: 4096 }, maxProperties: 64 };

export function requestForOperation(api: RegisteredApiDocument, input: ExecuteHttpInput) {
  const operation = api.operations.get(input.operationId);
  if (!operation) throw new Error("UNKNOWN_API_OPERATION");
  let parsed;
  try {
    parsed = parseOpenApiOperation(api.document, {
      path: operation.path,
      method: operation.method,
      ...(input.headers ? { headers: input.headers } : {}),
      ...(input.query ? { query: input.query } : {}),
      ...(input.pathParams ? { pathParams: input.pathParams } : {}),
      ...(Object.hasOwn(input, "body") ? { body: input.body ?? null } : {}),
      id: input.operationId
    });
  } catch {
    throw new Error("INVALID_API_REQUEST");
  }
  return { operation, parsed };
}

export function createExecuteHttpTool(api: RegisteredApiDocument, options: ExecuteHttpToolOptions): HarnessTool {
  const http = new RealHttpTool({
    allowedHosts: options.allowedHosts,
    allowedPorts: options.allowedPorts,
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    ...(options.maxResponseBytes === undefined ? {} : { maxResponseBytes: options.maxResponseBytes })
  });
  return defineTool(
    "execute_http",
    "mcp-runtime-api",
    "Execute one host-registered API operation through A-Pidoc host/port, method, timeout, redirect, response-size, evidence, and redaction controls.",
    closed({
      operationId: { type: "string", minLength: 1, maxLength: 160 },
      headers: stringMap,
      query: stringMap,
      pathParams: stringMap,
      body: { anyOf: [{ type: "object", maxProperties: 128 }, { type: "null" }] }
    }, ["operationId"]),
    "http_observation",
    async (raw, context) => {
      if (context.signal?.aborted) throw new Error("HTTP_CANCELLED");
      const { operation, parsed } = requestForOperation(api, raw as ExecuteHttpInput);
      const response = await http.execute(parsed.task.request);
      return result(context, "http_observation", {
        operationId: operation.operationId,
        request: parsed.task.request,
        statusCode: response.status,
        headers: response.headers,
        response: response.body,
        durationMs: response.durationMs,
        schemaIssues: parsed.schemaIssues,
        sideEffect: !operation.sideEffectFree
      });
    },
    "network"
  );
}
