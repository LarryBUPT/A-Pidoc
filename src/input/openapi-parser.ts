import type { ApiSpec, DebugTask, HttpMethod } from "../domain/types.js";

type JsonObject = Record<string, unknown>;
type PrimitiveType = "string" | "number" | "boolean";

export interface SchemaIssue {
  path: string;
  message: string;
}

export interface OpenApiOperationOptions {
  path: string;
  method: string;
  serverUrl?: string;
  headers?: Record<string, string>;
  query?: Record<string, string>;
  pathParams?: Record<string, string>;
  body?: Record<string, unknown> | null;
  id?: string;
}

export interface ParsedOpenApiOperation {
  task: DebugTask;
  schemaIssues: SchemaIssue[];
}

function object(value: unknown, label: string): JsonObject {
  if (!value || Array.isArray(value) || typeof value !== "object") throw new Error(`${label} must be an object`);
  return value as JsonObject;
}

function primitiveType(value: unknown): PrimitiveType | undefined {
  return value === "string" || value === "number" || value === "integer" || value === "boolean"
    ? value === "integer" ? "number" : value
    : undefined;
}

function resolvePath(path: string, values: Record<string, string>): string {
  const resolved = path.replace(/\{([^}]+)\}/g, (_match, name: string) => {
    const value = values[name];
    if (value === undefined) throw new Error(`Missing OpenAPI path parameter: ${name}`);
    return encodeURIComponent(value);
  });
  if (/\{[^}]+\}/.test(resolved)) throw new Error("OpenAPI path contains unresolved parameters");
  return resolved;
}

function exampleBody(schema: JsonObject | undefined): Record<string, unknown> | null {
  if (!schema) return null;
  if (schema.example && typeof schema.example === "object" && !Array.isArray(schema.example)) {
    return structuredClone(schema.example as Record<string, unknown>);
  }
  const properties = schema.properties && typeof schema.properties === "object"
    ? schema.properties as Record<string, unknown>
    : {};
  const required = Array.isArray(schema.required) ? schema.required.filter((item): item is string => typeof item === "string") : [];
  const body: Record<string, unknown> = {};
  for (const name of required) {
    const property = object(properties[name] ?? {}, `schema.properties.${name}`);
    if ("example" in property) body[name] = property.example;
    else if ("default" in property) body[name] = property.default;
    else {
      const type = primitiveType(property.type);
      body[name] = type === "number" ? 0 : type === "boolean" ? false : "";
    }
  }
  return body;
}

export function validateJsonBody(body: Record<string, unknown> | null, schema: unknown): SchemaIssue[] {
  if (!schema) return [];
  const root = object(schema, "request body schema");
  if ("$ref" in root) throw new Error("OpenAPI $ref is not supported in V1; provide a dereferenced document");
  if (root.type !== undefined && root.type !== "object") throw new Error("V1 supports object request bodies only");
  const issues: SchemaIssue[] = [];
  if (body === null) {
    issues.push({ path: "$", message: "request body is required" });
    return issues;
  }
  const required = Array.isArray(root.required) ? root.required.filter((item): item is string => typeof item === "string") : [];
  const properties = root.properties && typeof root.properties === "object"
    ? root.properties as Record<string, unknown>
    : {};
  for (const name of required) {
    if (!(name in body)) issues.push({ path: `$.${name}`, message: "required property is missing" });
  }
  for (const [name, value] of Object.entries(body)) {
    if (!(name in properties)) continue;
    const property = object(properties[name], `schema.properties.${name}`);
    if ("$ref" in property) throw new Error("OpenAPI $ref is not supported in V1; provide a dereferenced document");
    const expected = primitiveType(property.type);
    if (expected && typeof value !== expected) {
      issues.push({ path: `$.${name}`, message: `expected ${expected}, received ${typeof value}` });
    }
  }
  return issues;
}

export function parseOpenApiOperation(document: unknown, options: OpenApiOperationOptions): ParsedOpenApiOperation {
  const root = object(document, "OpenAPI document");
  if (typeof root.openapi !== "string" || !root.openapi.startsWith("3.")) {
    throw new Error("Only OpenAPI 3.x documents are supported");
  }
  const method = options.method.toUpperCase() as HttpMethod;
  if (!(["GET", "POST", "PUT", "PATCH", "DELETE"] as string[]).includes(method)) {
    throw new Error(`Unsupported HTTP method: ${options.method}`);
  }
  const paths = object(root.paths, "OpenAPI paths");
  const pathItem = object(paths[options.path], `OpenAPI path ${options.path}`);
  const operation = object(pathItem[method.toLowerCase()], `OpenAPI operation ${method} ${options.path}`);

  const servers = Array.isArray(operation.servers) ? operation.servers
    : Array.isArray(pathItem.servers) ? pathItem.servers
    : Array.isArray(root.servers) ? root.servers
    : [];
  const firstServer = servers[0] && typeof servers[0] === "object" ? servers[0] as JsonObject : undefined;
  const serverUrl = options.serverUrl ?? (typeof firstServer?.url === "string" ? firstServer.url : undefined);
  if (!serverUrl) throw new Error("OpenAPI operation does not define a server URL");

  const resolvedPath = resolvePath(options.path, options.pathParams ?? {});
  const url = new URL(`${serverUrl.replace(/\/$/, "")}${resolvedPath.startsWith("/") ? resolvedPath : `/${resolvedPath}`}`);
  for (const [name, value] of Object.entries(options.query ?? {})) url.searchParams.set(name, value);

  const parameters = [
    ...(Array.isArray(pathItem.parameters) ? pathItem.parameters : []),
    ...(Array.isArray(operation.parameters) ? operation.parameters : [])
  ];
  const headers = { ...(options.headers ?? {}) };
  const requiredHeaders: Record<string, string> = {};
  for (const rawParameter of parameters) {
    const parameter = object(rawParameter, "OpenAPI parameter");
    if (parameter.in !== "header" || parameter.required !== true || typeof parameter.name !== "string") continue;
    const schema = parameter.schema && typeof parameter.schema === "object" ? parameter.schema as JsonObject : {};
    const expected = parameter.example ?? schema.example ?? schema.default ?? headers[parameter.name] ?? "";
    requiredHeaders[parameter.name] = String(expected);
  }

  let bodySchema: JsonObject | undefined;
  let bodyRequired = false;
  let body = options.body === undefined ? null : structuredClone(options.body);
  if (operation.requestBody !== undefined) {
    const requestBody = object(operation.requestBody, "OpenAPI requestBody");
    if ("$ref" in requestBody) throw new Error("OpenAPI $ref is not supported in V1; provide a dereferenced document");
    bodyRequired = requestBody.required === true;
    const content = object(requestBody.content, "OpenAPI requestBody.content");
    const mediaType = Object.keys(content).find((type) => type === "application/json" || type.endsWith("+json"));
    if (!mediaType) throw new Error("V1 supports JSON OpenAPI request bodies only");
    const media = object(content[mediaType], `OpenAPI media type ${mediaType}`);
    bodySchema = media.schema === undefined ? undefined : object(media.schema, "OpenAPI request body schema");
    requiredHeaders["Content-Type"] = mediaType;
    headers["Content-Type"] ??= mediaType;
    if (options.body === undefined) {
      const mediaExample = media.example;
      body = mediaExample && typeof mediaExample === "object" && !Array.isArray(mediaExample)
        ? structuredClone(mediaExample as Record<string, unknown>)
        : exampleBody(bodySchema);
    }
  }

  const requiredBody: ApiSpec["requiredBody"] = {};
  if (bodySchema) {
    const properties = bodySchema.properties && typeof bodySchema.properties === "object"
      ? bodySchema.properties as Record<string, unknown>
      : {};
    const required = Array.isArray(bodySchema.required)
      ? bodySchema.required.filter((item): item is string => typeof item === "string")
      : [];
    for (const name of required) {
      const property = object(properties[name] ?? {}, `schema.properties.${name}`);
      const type = primitiveType(property.type);
      if (!type) throw new Error(`Unsupported or missing type for required body property: ${name}`);
      requiredBody[name] = type;
    }
  }

  return {
    task: {
      id: options.id ?? `openapi:${method}:${options.path}`,
      title: typeof operation.summary === "string" ? operation.summary : `${method} ${options.path}`,
      source: "openapi",
      request: { method, url: url.toString(), headers, body },
      spec: { method, requiredHeaders, requiredBody }
    },
    schemaIssues: body === null && !bodyRequired ? [] : validateJsonBody(body, bodySchema)
  };
}
