import { z } from "zod";
import { asObject, readApiDocument, type JsonObject } from "../shared/api-document.js";
import type { HttpMethod } from "../shared/types.js";
import type { HarnessToolSpec } from "./registry.js";

export interface IndexedOperation {
  operationId: string;
  method: HttpMethod;
  path: string;
  summary: string;
  description: string;
  tags: string[];
  baseUrl?: string;
  requiredHeaders: string[];
  queryParams: Array<{ name: string; required: boolean; type?: string }>;
  pathParams: Array<{ name: string; required: boolean; type?: string }>;
  requiredContentType?: string;
  bodySchema?: Record<string, unknown>;
  bodyFieldNames: string[];
  responseStatuses: string[];
}

const HTTP_METHODS = new Set(["get", "post", "put", "patch", "delete"]);

function collectSchemaFieldNames(schema: unknown, depth = 0): string[] {
  if (!schema || typeof schema !== "object" || depth > 5) return [];
  const obj = schema as JsonObject;
  const names: string[] = [];

  if (obj.properties && typeof obj.properties === "object") {
    for (const [key, child] of Object.entries(obj.properties as JsonObject)) {
      names.push(key);
      names.push(...collectSchemaFieldNames(child, depth + 1));
    }
  }
  if (obj.items) {
    names.push(...collectSchemaFieldNames(obj.items, depth + 1));
  }
  return [...new Set(names)];
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9\u4e00-\u9fa5_-]+/)
    .map((token) => token.trim())
    .filter((token) => token.length > 0);
}

/**
 * OpenAPI 结构化索引与加权检索器（Context Engineering）：
 * 将任意规模的 OpenAPI 3.x / Swagger 2.0 规范拆解为操作级文档块，
 * 按需通过路径、方法、OperationId、描述与请求体字段名做加权召回，
 * 避免把几百个接口一次性塞爆 LLM 上下文窗口。
 */
export class OpenApiIndex {
  readonly title: string;
  readonly version: string;
  readonly baseUrl?: string;
  readonly operations: IndexedOperation[];

  private constructor(
    title: string,
    version: string,
    operations: IndexedOperation[],
    baseUrl?: string
  ) {
    this.title = title;
    this.version = version;
    this.operations = operations;
    if (baseUrl) this.baseUrl = baseUrl;
  }

  static fromRawDocument(rawDocument: unknown): OpenApiIndex {
    const doc = readApiDocument(rawDocument);
    const info = (doc.info && typeof doc.info === "object" ? doc.info : {}) as JsonObject;
    const title = typeof info.title === "string" ? info.title : "Untitled OpenAPI";
    const version = typeof info.version === "string" ? info.version : "1.0.0";
    const servers = Array.isArray(doc.servers) ? doc.servers : [];
    const firstServer = servers[0] && typeof servers[0] === "object" ? (servers[0] as JsonObject) : undefined;
    const baseUrl = typeof firstServer?.url === "string" ? firstServer.url.replace(/\/$/, "") : undefined;

    const paths = asObject(doc.paths ?? {}, "OpenAPI paths");
    const operations: IndexedOperation[] = [];

    for (const [pathKey, rawPathItem] of Object.entries(paths)) {
      if (!rawPathItem || typeof rawPathItem !== "object") continue;
      const pathItem = rawPathItem as JsonObject;
      const sharedParams = Array.isArray(pathItem.parameters) ? pathItem.parameters : [];

      for (const [methodKey, rawOp] of Object.entries(pathItem)) {
        if (!HTTP_METHODS.has(methodKey.toLowerCase())) continue;
        if (!rawOp || typeof rawOp !== "object") continue;

        const op = rawOp as JsonObject;
        const method = methodKey.toUpperCase() as HttpMethod;
        const operationId =
          typeof op.operationId === "string" && op.operationId.trim()
            ? op.operationId.trim()
            : `${method.toLowerCase()}_${pathKey.replace(/[^A-Za-z0-9]+/g, "_").replace(/^_|_$/g, "") || "root"}`;

        const params = [...sharedParams, ...(Array.isArray(op.parameters) ? op.parameters : [])].filter(
          (item): item is JsonObject => !!item && typeof item === "object"
        );

        const requiredHeaders: string[] = [];
        const queryParams: IndexedOperation["queryParams"] = [];
        const pathParams: IndexedOperation["pathParams"] = [];

        for (const param of params) {
          const name = typeof param.name === "string" ? param.name : "";
          const location = typeof param.in === "string" ? param.in : "";
          const required = Boolean(param.required);
          const schemaObj = param.schema && typeof param.schema === "object" ? (param.schema as JsonObject) : undefined;
          const type = typeof schemaObj?.type === "string" ? schemaObj.type : undefined;
          if (!name) continue;

          if (location === "header" && required) requiredHeaders.push(name);
          if (location === "query") queryParams.push({ name, required, ...(type ? { type } : {}) });
          if (location === "path") pathParams.push({ name, required: true, ...(type ? { type } : {}) });
        }

        const requestBody = op.requestBody && typeof op.requestBody === "object" ? (op.requestBody as JsonObject) : undefined;
        const content = requestBody?.content && typeof requestBody.content === "object" ? (requestBody.content as JsonObject) : undefined;
        let requiredContentType: string | undefined;
        let bodySchema: Record<string, unknown> | undefined;

        if (content) {
          const mediaTypes = Object.keys(content);
          requiredContentType = mediaTypes.find((type) => type.includes("json")) ?? mediaTypes[0];
          const mediaSpec = requiredContentType ? (content[requiredContentType] as JsonObject | undefined) : undefined;
          if (mediaSpec?.schema && typeof mediaSpec.schema === "object") {
            bodySchema = mediaSpec.schema as Record<string, unknown>;
          }
        }

        const responses = op.responses && typeof op.responses === "object" ? Object.keys(op.responses as JsonObject) : [];
        const tags = Array.isArray(op.tags)
          ? op.tags.filter((tag): tag is string => typeof tag === "string")
          : [];

        operations.push({
          operationId,
          method,
          path: pathKey,
          summary: typeof op.summary === "string" ? op.summary : "",
          description: typeof op.description === "string" ? op.description : "",
          tags,
          ...(baseUrl ? { baseUrl } : {}),
          requiredHeaders,
          queryParams,
          pathParams,
          ...(requiredContentType ? { requiredContentType } : {}),
          ...(bodySchema ? { bodySchema } : {}),
          bodyFieldNames: collectSchemaFieldNames(bodySchema),
          responseStatuses: responses
        });
      }
    }

    return new OpenApiIndex(title, version, operations, baseUrl);
  }

  /** 加权关键词 + 路径 + 字段检索，返回 Top-K 匹配操作 */
  search(query: string, limit = 5): Array<{ score: number; operation: IndexedOperation }> {
    const trimmed = query.trim();
    if (!trimmed) {
      return this.operations.slice(0, limit).map((operation) => ({ score: 1, operation }));
    }

    const tokens = tokenize(trimmed);
    const lowerQuery = trimmed.toLowerCase();

    const scored = this.operations.map((operation) => {
      let score = 0;
      const lowerPath = operation.path.toLowerCase();
      const lowerId = operation.operationId.toLowerCase();
      const lowerSummary = `${operation.summary} ${operation.description}`.toLowerCase();
      const lowerTags = operation.tags.join(" ").toLowerCase();
      const lowerFields = operation.bodyFieldNames.join(" ").toLowerCase();

      if (lowerPath === lowerQuery || lowerId === lowerQuery) score += 12;
      if (lowerPath.includes(lowerQuery)) score += 6;

      for (const token of tokens) {
        if (operation.method.toLowerCase() === token) score += 4;
        if (lowerPath.includes(token)) score += 4;
        if (lowerId.includes(token)) score += 4;
        if (lowerFields.includes(token)) score += 3;
        if (lowerTags.includes(token)) score += 2.5;
        if (lowerSummary.includes(token)) score += 2;
      }

      return { score, operation };
    });

    return scored
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }

  getByIdOrPath(identifier: string, method?: string): IndexedOperation | undefined {
    const normalized = identifier.trim().toLowerCase();
    const targetMethod = method?.toUpperCase();

    return this.operations.find((op) => {
      if (op.operationId.toLowerCase() === normalized) return true;
      if (op.path.toLowerCase() === normalized && (!targetMethod || op.method === targetMethod)) {
        return true;
      }
      return false;
    });
  }
}

export function createOpenApiTools(getIndex: () => OpenApiIndex | null): HarnessToolSpec<any>[] {
  const searchSchema = z.object({
    query: z.string().max(256).default(""),
    limit: z.number().int().min(1).max(15).default(5)
  });

  const detailSchema = z.object({
    operationIdOrPath: z.string().min(1).max(200),
    method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]).optional()
  });

  const searchTool: HarnessToolSpec<z.infer<typeof searchSchema>> = {
    name: "search_openapi",
    label: "Search OpenAPI Operations",
    description:
      "Search the registered OpenAPI specification by path, method, operationId, tag, or body field name. Returns Top-K matching operations without flooding context.",
    risk: "read",
    jsonSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Keywords, path fragment, HTTP method, or field name" },
        limit: { type: "integer", minimum: 1, maximum: 15, description: "Max operations to return (default 5)" }
      },
      additionalProperties: false
    },
    zodSchema: searchSchema,
    execute: async (args) => {
      const index = getIndex();
      if (!index) {
        throw new Error("NO_OPENAPI_DOCUMENT_REGISTERED");
      }
      const matches = index.search(args.query, args.limit);
      return {
        summary: `Found ${matches.length}/${index.operations.length} matching OpenAPI operations for "${args.query || "*"}".`,
        evidenceKind: "openapi_search",
        data: {
          apiTitle: index.title,
          apiVersion: index.version,
          baseUrl: index.baseUrl ?? null,
          totalOperations: index.operations.length,
          matches: matches.map(({ score, operation }) => ({
            score,
            operationId: operation.operationId,
            method: operation.method,
            path: operation.path,
            summary: operation.summary,
            requiredContentType: operation.requiredContentType ?? null,
            requiredHeaders: operation.requiredHeaders,
            bodyFieldNames: operation.bodyFieldNames
          }))
        }
      };
    }
  };

  const getOperationTool: HarnessToolSpec<z.infer<typeof detailSchema>> = {
    name: "get_openapi_operation",
    label: "Get OpenAPI Operation Schema",
    description:
      "Read the complete request contract (headers, query/path parameters, Content-Type, and JSON body schema) for one specific OpenAPI operation.",
    risk: "read",
    jsonSchema: {
      type: "object",
      properties: {
        operationIdOrPath: { type: "string", description: "Exact operationId or path (e.g. /orders)" },
        method: { type: "string", enum: ["GET", "POST", "PUT", "PATCH", "DELETE"] }
      },
      required: ["operationIdOrPath"],
      additionalProperties: false
    },
    zodSchema: detailSchema,
    execute: async (args) => {
      const index = getIndex();
      if (!index) {
        throw new Error("NO_OPENAPI_DOCUMENT_REGISTERED");
      }
      const operation = index.getByIdOrPath(args.operationIdOrPath, args.method);
      if (!operation) {
        throw new Error(`OPENAPI_OPERATION_NOT_FOUND:${args.operationIdOrPath}`);
      }
      return {
        summary: `Loaded contract for ${operation.method} ${operation.path} (${operation.operationId}).`,
        evidenceKind: "api_operation",
        data: operation
      };
    }
  };

  return [searchTool, getOperationTool];
}
