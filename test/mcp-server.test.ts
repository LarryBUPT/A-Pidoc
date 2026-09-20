import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

function data(result: { structuredContent?: unknown; content: Array<{ type:string; text?:string }> }): Record<string, unknown> {
  if (result.structuredContent && typeof result.structuredContent === "object") return result.structuredContent as Record<string, unknown>;
  const text = result.content.find(block => block.type === "text")?.text;
  return JSON.parse(text ?? "{}") as Record<string, unknown>;
}

test("stdio MCP survives a rejected call and completes document -> 415 -> evidence -> 200", async t => {
  const directory = await mkdtemp(join(tmpdir(), "a-pidoc-mcp-server-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const api = createServer(async (request, response) => {
    let raw = ""; for await (const chunk of request) raw += String(chunk);
    let body: unknown; try { body = JSON.parse(raw); } catch { body = null; }
    const status = request.headers["content-type"] !== "application/json" ? 415 : typeof (body as {amount?:unknown}|null)?.amount === "number" ? 200 : 400;
    response.writeHead(status, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ status }));
  });
  await new Promise<void>(done => api.listen(0, "127.0.0.1", done));
  t.after(async () => { api.closeAllConnections(); await new Promise<void>(done => api.close(() => done())); });
  const address = api.address(); if (!address || typeof address === "string") throw new Error("TEST_SERVER_BIND_FAILED");
  const documentFile = join(directory, "openapi.json"), traceFile = join(directory, "trace.json");
  await writeFile(documentFile, JSON.stringify({
    openapi:"3.0.3", info:{title:"MCP test",version:"1"}, servers:[{url:`http://127.0.0.1:${address.port}`}],
    paths:{
      "/orders":{post:{operationId:"validateOrder","x-a-pidoc-side-effect-free":true,parameters:[{name:"Authorization",in:"header",required:true,schema:{type:"string",default:"Bearer document-secret"}}],requestBody:{required:true,content:{"application/json":{schema:{type:"object",properties:{amount:{type:"number"}},required:["amount"]}}}},responses:{"200":{description:"ok"}}}},
      "/mutate":{post:{operationId:"mutateOrder",requestBody:{content:{"application/json":{schema:{type:"object",properties:{amount:{type:"number"}}}}}},responses:{"200":{description:"not invoked"}}}}
    }
  }));
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string,string] => typeof entry[1] === "string"));
  Object.assign(env, { A_PIDOC_MCP_OPENAPI:documentFile,A_PIDOC_MCP_ALLOWED_HOSTS:"127.0.0.1",A_PIDOC_MCP_ALLOWED_PORTS:String(address.port),A_PIDOC_MCP_TRACE_FILE:traceFile });
  const transport = new StdioClientTransport({ command:process.execPath,args:[resolve("dist/src/mcp/server.js")],env,stderr:"pipe",cwd:process.cwd() });
  const client = new Client({ name:"mcp-test",version:"1" });
  t.after(() => client.close().catch(() => undefined));
  await client.connect(transport);
  assert.deepEqual((await client.listTools()).tools.map(tool => tool.name), ["read_api_document","execute_http","read_evidence"]);
  const document = data(await client.callTool({name:"read_api_document",arguments:{}}));
  assert.equal((document.operations as Array<{operationId:string}>)[0]?.operationId,"validateOrder");
  assert.doesNotMatch(JSON.stringify(document),/document-secret/);assert.deepEqual((document.operations as Array<{headers:Array<{schema:unknown}>}>)[0]?.headers[0]?.schema,{redacted:true});
  const blocked = data(await client.callTool({name:"execute_http",arguments:{operationId:"mutateOrder",body:{amount:1}}}));
  assert.equal(blocked.errorCode,"API_POLICY_BLOCKED");assert.equal(blocked.artifactId,null);
  const failed = data(await client.callTool({name:"execute_http",arguments:{operationId:"validateOrder",headers:{"Content-Type":"text/plain"},body:{amount:42}}}));
  assert.equal(failed.statusCode,415);assert.match(String(failed.artifactId),/^http_observation-/);
  const evidence = data(await client.callTool({name:"read_evidence",arguments:{artifactId:failed.artifactId}}));
  assert.equal(evidence.statusCode,415);assert.equal(evidence.artifactId,failed.artifactId);
  const corrected = data(await client.callTool({name:"execute_http",arguments:{operationId:"validateOrder",headers:{"Content-Type":"application/json"},body:{amount:42}}}));
  assert.equal(corrected.statusCode,200);
  const documentEvidence = data(await client.callTool({name:"read_evidence",arguments:{artifactId:document.artifactId}}));
  assert.equal(documentEvidence.kind,"api_operation");
  assert.equal((documentEvidence.data as {operations:Array<{operationId:string}>}).operations[0]?.operationId,"validateOrder");
  await client.close();
  const snapshot = JSON.parse(await readFile(traceFile,"utf8")) as {run:{state:string;evidence:Array<{id:string}>;steps:Array<{kind:string;data:{type?:string;toolName?:string;executionResult?:string;httpStatus?:number|null;generatedArtifactId?:string|null;artifactIds?:string[];errorCode?:string|null}}>};artifacts:Record<string,unknown>};
  const trace=snapshot.run.steps.filter(step=>step.kind==="runtime"&&step.data.type==="mcp_call_trace").map(step=>step.data);
  assert.equal(trace.length,6);assert.deepEqual(trace.map(item=>item.toolName),["read_api_document","execute_http","execute_http","read_evidence","execute_http","read_evidence"]);
  assert.equal(trace[1]?.executionResult,"failed");assert.equal(trace[1]?.errorCode,"API_POLICY_BLOCKED");assert.equal(trace[1]?.generatedArtifactId,null);assert.deepEqual(trace[1]?.artifactIds,[]);
  assert.deepEqual(trace.map(item=>item.httpStatus),[null,null,415,415,200,null]);
  assert.equal(trace[2]?.generatedArtifactId,failed.artifactId);assert.equal(trace[4]?.generatedArtifactId,corrected.artifactId);
  assert.equal(snapshot.run.state,"running");assert.equal(Object.keys(snapshot.artifacts).length,3);assert.equal(snapshot.run.evidence.length,3);
});
