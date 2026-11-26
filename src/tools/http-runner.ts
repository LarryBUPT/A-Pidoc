import { z } from "zod";
import { ControlledHttpClient, type HttpClientOptions } from "../shared/http-client.js";
import { redactRequest } from "../shared/redaction.js";
import type { ApiRequest, HttpMethod } from "../shared/types.js";
import type { HarnessToolSpec } from "./registry.js";

export interface HttpToolsConfig extends HttpClientOptions {
  /** 是否对非 GET 的变更类 HTTP 请求要求人工审批（默认 false 在 sandbox 可自由调试，true 则启用严格审批） */
  requireApprovalForMutations?: boolean;
}

const httpInputZod = z.object({
  url: z.string().url().max(2_048),
  method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]),
  headers: z.record(z.string(), z.string()).default({}),
  body: z.record(z.string(), z.unknown()).nullable().optional()
});

const httpInputJsonSchema = {
  type: "object",
  properties: {
    url: { type: "string", description: "Full HTTP(S) URL within configured host/port allowlist" },
    method: { type: "string", enum: ["GET", "POST", "PUT", "PATCH", "DELETE"] },
    headers: {
      type: "object",
      additionalProperties: { type: "string" },
      description: "Optional HTTP request headers (sensitive values are redacted in logs)"
    },
    body: {
      type: ["object", "null"],
      description: "Optional JSON object request body for POST/PUT/PATCH"
    }
  },
  required: ["url", "method"],
  additionalProperties: false
};

/**
 * 通用受控 HTTP 诊断工具：
 * - 彻底取代旧版写死的 /orders 后端，支持任意白名单端点与任意 JSON Schema 请求
 * - 每次真实调用均记录脱敏后的请求/响应为 `http_observation` Evidence Artifact
 */
export function createHttpTools(config: HttpToolsConfig = {}): HarnessToolSpec<any>[] {
  const client = new ControlledHttpClient(config);

  const executeReadOrSandboxTool: HarnessToolSpec<z.infer<typeof httpInputZod>> = {
    name: "execute_http",
    label: "Execute Controlled HTTP Request",
    description:
      "Execute an HTTP request against an allowlisted host/port and capture a redacted, verifiable http_observation Evidence Artifact.",
    risk: config.requireApprovalForMutations ? "network_write" : "network_read",
    jsonSchema: httpInputJsonSchema,
    zodSchema: httpInputZod,
    execute: async (args, context) => {
      const request: ApiRequest = {
        url: args.url,
        method: args.method as HttpMethod,
        headers: args.headers ?? {},
        body: args.body ?? null
      };

      const response = await client.execute(request, context.signal);
      const safeReq = redactRequest(request);

      return {
        summary: `${safeReq.method} ${safeReq.url} -> HTTP ${response.status} (${response.durationMs}ms)`,
        evidenceKind: "http_observation",
        data: {
          request: safeReq,
          response
        }
      };
    }
  };

  const executeMutationTool: HarnessToolSpec<z.infer<typeof httpInputZod>> = {
    name: "execute_http_mutation",
    label: "Execute State-Changing HTTP Request (Approval Required)",
    description:
      "Execute a state-changing HTTP request (POST/PUT/PATCH/DELETE) that modifies remote state. Always requires explicit human approval before network execution.",
    risk: "network_write",
    jsonSchema: httpInputJsonSchema,
    zodSchema: httpInputZod,
    execute: async (args, context) => {
      const request: ApiRequest = {
        url: args.url,
        method: args.method as HttpMethod,
        headers: args.headers ?? {},
        body: args.body ?? null
      };

      const response = await client.execute(request, context.signal);
      const safeReq = redactRequest(request);

      return {
        summary: `[MUTATION] ${safeReq.method} ${safeReq.url} -> HTTP ${response.status} (${response.durationMs}ms)`,
        evidenceKind: "http_observation",
        data: {
          mutating: true,
          request: safeReq,
          response
        }
      };
    }
  };

  return [executeReadOrSandboxTool, executeMutationTool];
}
