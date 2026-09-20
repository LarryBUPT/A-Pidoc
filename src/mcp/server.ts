import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { z } from "zod";
import { readApiDocument } from "../input/api-document.js";
import { McpToolRuntime } from "./registry.js";
import { McpToolCallError, type McpServerConfig, type McpToolOutput } from "./types.js";

const stringMap = z.record(z.string().min(1).max(256), z.string().max(4096));

function response(output: McpToolOutput, isError = false) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(output) }],
    structuredContent: output,
    ...(isError ? { isError: true as const } : {})
  };
}

async function invoke(runtime: McpToolRuntime, name: string, args: unknown, requestId: string, signal: AbortSignal) {
  try {
    return response(await runtime.invoke(name, args, requestId, signal));
  } catch (error) {
    if (error instanceof McpToolCallError) return response(error.output, true);
    return response({ callId: "unavailable", artifactId: null, artifactIds: [], errorCode: "MCP_TOOL_CALL_FAILED", message: "The MCP tool call failed safely." }, true);
  }
}

export function createMcpServer(runtime: McpToolRuntime): McpServer {
  const server = new McpServer(
    { name: "a-pidoc", version: "0.20.0" },
    { instructions: "Call read_api_document first. execute_http can only invoke operations from the host-registered document and remains subject to A-Pidoc guardrails. Use read_evidence with returned Artifact IDs." }
  );
  server.registerTool("read_api_document", {
    title: "Read API document",
    description: "Read the configured OpenAPI/Swagger document as structured operations, required headers, and request schemas.",
    inputSchema: z.object({ operationId: z.string().min(1).max(160).optional() }).strict()
  }, (args, context) => invoke(runtime, "read_api_document", args, String(context.mcpReq.id), context.mcpReq.signal));
  server.registerTool("execute_http", {
    title: "Execute controlled HTTP request",
    description: "Execute a registered API operation through existing A-Pidoc allowlist, method, timeout, redirect, redaction, and Evidence controls.",
    inputSchema: z.object({
      operationId: z.string().min(1).max(160),
      headers: stringMap.optional(),
      query: stringMap.optional(),
      pathParams: stringMap.optional(),
      body: z.record(z.string(), z.unknown()).nullable().optional()
    }).strict()
  }, (args, context) => invoke(runtime, "execute_http", args, String(context.mcpReq.id), context.mcpReq.signal));
  server.registerTool("read_evidence", {
    title: "Read execution evidence",
    description: "Read one integrity-checked, redacted execution Evidence Artifact by Artifact ID from this MCP session.",
    inputSchema: z.object({ artifactId: z.string().min(1).max(160) }).strict()
  }, (args, context) => invoke(runtime, "read_evidence", { id: args.artifactId }, String(context.mcpReq.id), context.mcpReq.signal));
  return server;
}

function list(name: string): string[] {
  return (process.env[name] ?? "").split(",").map(value => value.trim()).filter(Boolean);
}

function positiveInteger(name: string, fallback?: number): number | undefined {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
  return value;
}

export async function loadMcpServerConfig(): Promise<McpServerConfig> {
  const documentFile = process.env.A_PIDOC_MCP_OPENAPI;
  if (!documentFile) throw new Error("A_PIDOC_MCP_OPENAPI is required");
  const allowedHosts = list("A_PIDOC_MCP_ALLOWED_HOSTS"), ports = list("A_PIDOC_MCP_ALLOWED_PORTS");
  if (!allowedHosts.length) throw new Error("A_PIDOC_MCP_ALLOWED_HOSTS is required");
  const allowedPorts = ports.map(value => Number(value));
  if (!allowedPorts.length || allowedPorts.some(port => !Number.isInteger(port) || port < 1 || port > 65535)) throw new Error("A_PIDOC_MCP_ALLOWED_PORTS must contain valid ports");
  const environment = process.env.A_PIDOC_MCP_ENVIRONMENT ?? "sandbox";
  if (!(["sandbox", "staging", "production"] as string[]).includes(environment)) throw new Error("A_PIDOC_MCP_ENVIRONMENT is invalid");
  const document = readApiDocument(await readFile(resolve(documentFile), "utf8"));
  const timeoutMs = positiveInteger("A_PIDOC_MCP_TIMEOUT_MS", 5_000)!;
  const maxResponseBytes = positiveInteger("A_PIDOC_MCP_MAX_RESPONSE_BYTES", 1_000_000)!;
  if (timeoutMs > 60_000) throw new Error("A_PIDOC_MCP_TIMEOUT_MS exceeds 60000");
  if (maxResponseBytes > 1_000_000) throw new Error("A_PIDOC_MCP_MAX_RESPONSE_BYTES exceeds 1000000");
  return {
    document,
    allowedHosts,
    allowedPorts,
    runFile: resolve(process.env.A_PIDOC_MCP_TRACE_FILE ?? `.private/mcp/run-${randomUUID()}.json`),
    environment: environment as "sandbox" | "staging" | "production",
    timeoutMs,
    maxResponseBytes
  };
}

export async function main(): Promise<void> {
  const config = await loadMcpServerConfig(), runtime = await McpToolRuntime.create(config);
  serveStdio(() => createMcpServer(runtime), { onerror: error => console.error(`A-Pidoc MCP transport error: ${error.message}`) });
  console.error(`A-Pidoc MCP server running on stdio; trace=${config.runFile}`);
}

const entry = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (import.meta.url === entry) void main().catch(error => {
  console.error(`A-Pidoc MCP startup failed: ${error instanceof Error ? error.message : "unknown error"}`);
  process.exitCode = 1;
});
