import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

function output(result) {
  if (result.structuredContent && typeof result.structuredContent === "object") return result.structuredContent;
  const text = result.content.find(block => block.type === "text")?.text;
  return JSON.parse(text ?? "{}");
}

const api = createServer(async (request, response) => {
  let raw = "";
  for await (const chunk of request) raw += String(chunk);
  let body;
  try { body = JSON.parse(raw); } catch { body = null; }
  const status = request.url !== "/orders" ? 404
    : request.method !== "POST" ? 405
    : request.headers["content-type"] !== "application/json" ? 415
    : typeof body?.amount !== "number" ? 400 : 200;
  response.writeHead(status, { "Content-Type": "application/json", "Set-Cookie": "demo-session=must-be-redacted" });
  response.end(JSON.stringify({ status, message: status === 415 ? "Expected application/json" : status === 200 ? "Request validated" : "Invalid request" }));
});

await new Promise((done, reject) => api.listen(0, "127.0.0.1", error => error ? reject(error) : done()));
const address = api.address();
if (!address || typeof address === "string") throw new Error("Demo HTTP server did not bind a port");
const directory = resolve(".private", "mcp-demo", randomUUID()), documentFile = join(directory, "openapi.json"), traceFile = join(directory, "trace.json");
await mkdir(directory, { recursive: true });
await writeFile(documentFile, JSON.stringify({
  openapi: "3.0.3",
  info: { title: "A-Pidoc MCP diagnostic demo", version: "1.0.0" },
  servers: [{ url: `http://127.0.0.1:${address.port}` }],
  paths: {
    "/orders": {
      post: {
        operationId: "validateOrder",
        summary: "Validate an order without creating it",
        "x-a-pidoc-side-effect-free": true,
        requestBody: { required: true, content: { "application/json": { schema: { type: "object", properties: { amount: { type: "number" } }, required: ["amount"], additionalProperties: false } } } },
        responses: { "200": { description: "Valid" }, "415": { description: "Wrong media type" } }
      }
    }
  }
}));

const env = Object.fromEntries(Object.entries(process.env).filter((entry) => typeof entry[1] === "string"));
Object.assign(env, {
  A_PIDOC_MCP_OPENAPI: documentFile,
  A_PIDOC_MCP_ALLOWED_HOSTS: "127.0.0.1",
  A_PIDOC_MCP_ALLOWED_PORTS: String(address.port),
  A_PIDOC_MCP_TRACE_FILE: traceFile
});
const transport = new StdioClientTransport({ command: process.execPath, args: [resolve("dist/src/mcp/server.js")], env, stderr: "pipe", cwd: process.cwd() });
transport.stderr?.on("data", chunk => process.stderr.write(chunk));
const client = new Client({ name: "a-pidoc-mcp-demo", version: "1.0.0" });

try {
  await client.connect(transport);
  const listed = await client.listTools();
  const document = output(await client.callTool({ name: "read_api_document", arguments: {} }));
  const failed = output(await client.callTool({ name: "execute_http", arguments: { operationId: "validateOrder", headers: { "Content-Type": "text/plain" }, body: { amount: 42 } } }));
  const evidence = output(await client.callTool({ name: "read_evidence", arguments: { artifactId: failed.artifactId } }));
  const corrected = output(await client.callTool({ name: "execute_http", arguments: { operationId: "validateOrder", headers: { "Content-Type": "application/json" }, body: { amount: 42 } } }));
  if (failed.statusCode !== 415 || evidence.statusCode !== 415 || corrected.statusCode !== 200) throw new Error("MCP demo did not complete the expected 415 -> evidence -> 200 chain");
  await client.close();
  const snapshot = JSON.parse(await readFile(traceFile, "utf8"));
  const trace = snapshot.run.steps.filter(step => step.kind === "runtime" && step.data?.type === "mcp_call_trace").map(step => step.data);
  console.log(JSON.stringify({
    passed: true,
    transport: "stdio",
    tools: listed.tools.map(tool => tool.name),
    chain: [
      { tool: "read_api_document", operation: document.operations?.[0]?.operationId, artifactId: document.artifactId },
      { tool: "execute_http", statusCode: failed.statusCode, artifactId: failed.artifactId },
      { tool: "read_evidence", statusCode: evidence.statusCode, artifactId: evidence.artifactId },
      { tool: "execute_http", statusCode: corrected.statusCode, artifactId: corrected.artifactId }
    ],
    redactionVerified: failed.headers?.["set-cookie"] === "[REDACTED]" && corrected.headers?.["set-cookie"] === "[REDACTED]",
    traceFile,
    trace
  }, null, 2));
} finally {
  await client.close().catch(() => undefined);
  api.closeAllConnections();
  await new Promise(done => api.close(() => done()));
}
