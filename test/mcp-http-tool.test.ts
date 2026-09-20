import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

type Snapshot = {
  run:{state:string;evidence:Array<{id:string}>;steps:Array<{kind:string;data:{type?:string;executionResult?:string;generatedArtifactId?:string|null;artifactIds?:string[];errorCode?:string|null;code?:string}}>};
  artifacts:Record<string,unknown>;
};

function payload(result: { structuredContent?:unknown; content?:Array<{type:string;text?:string}> }): Record<string,unknown> {
  if (result.structuredContent && typeof result.structuredContent === "object") return result.structuredContent as Record<string,unknown>;
  const text=result.content?.find(block=>block.type==="text")?.text;
  try{return JSON.parse(text??"{}") as Record<string,unknown>;}catch{return {message:text??""};}
}

function document(port:number,method="post",sideEffectFree=true,host="127.0.0.1") {
  return {openapi:"3.0.3",info:{title:"MCP HTTP",version:"1"},servers:[{url:`http://${host}:${port}`}],paths:{"/orders":{[method]:{operationId:`${method}Order`,...(sideEffectFree?{"x-a-pidoc-side-effect-free":true}:{}),requestBody:{required:true,content:{"application/json":{schema:{type:"object",properties:{amount:{type:"number"}},required:["amount"]}}}},responses:{"200":{description:"ok"}}}}}};
}

async function openSession(directory:string,doc:unknown,options:{allowedHosts?:string;allowedPorts?:string;timeoutMs?:number;maxResponseBytes?:number}={}) {
  const id=randomUUID(),documentFile=join(directory,`${id}-openapi.json`),traceFile=join(directory,`${id}-trace.json`);
  await writeFile(documentFile,JSON.stringify(doc));
  const env=Object.fromEntries(Object.entries(process.env).filter((entry):entry is [string,string]=>typeof entry[1]==="string"));
  Object.assign(env,{
    A_PIDOC_MCP_OPENAPI:documentFile,
    A_PIDOC_MCP_ALLOWED_HOSTS:options.allowedHosts??"127.0.0.1",
    A_PIDOC_MCP_ALLOWED_PORTS:options.allowedPorts??"80",
    A_PIDOC_MCP_TRACE_FILE:traceFile,
    ...(options.timeoutMs?{A_PIDOC_MCP_TIMEOUT_MS:String(options.timeoutMs)}:{}),
    ...(options.maxResponseBytes?{A_PIDOC_MCP_MAX_RESPONSE_BYTES:String(options.maxResponseBytes)}:{})
  });
  const transport=new StdioClientTransport({command:process.execPath,args:[resolve("dist/src/mcp/server.js")],env,stderr:"pipe",cwd:process.cwd()});
  const client=new Client({name:"mcp-http-test",version:"1"});
  await client.connect(transport);
  return {client,traceFile,close:()=>client.close().catch(()=>undefined)};
}

function traces(snapshot:Snapshot){return snapshot.run.steps.filter(step=>step.kind==="runtime"&&step.data.type==="mcp_call_trace").map(step=>step.data);}

test("stdio MCP preserves redaction, Evidence, and session availability after sensitive input rejection",async t=>{
  const directory=await mkdtemp(join(tmpdir(),"a-pidoc-mcp-http-"));t.after(()=>rm(directory,{recursive:true,force:true}));
  const api=createServer(async(_request,response)=>{response.writeHead(200,{"Content-Type":"application/json","Set-Cookie":"session=private"});response.end(JSON.stringify({token:"private-token-value",ok:true}));});
  await new Promise<void>(done=>api.listen(0,"127.0.0.1",done));t.after(async()=>{api.closeAllConnections();await new Promise<void>(done=>api.close(()=>done()));});
  const address=api.address();if(!address||typeof address==="string")throw new Error("TEST_SERVER_BIND_FAILED");
  const session=await openSession(directory,document(address.port),{allowedPorts:String(address.port)});t.after(session.close);
  const secret="Bearer request-secret-value";
  const blocked=await session.client.callTool({name:"execute_http",arguments:{operationId:"postOrder",headers:{Authorization:secret},body:{amount:1}}});
  assert.equal(blocked.isError,true);assert.equal(payload(blocked).errorCode,"API_POLICY_BLOCKED");
  const executed=payload(await session.client.callTool({name:"execute_http",arguments:{operationId:"postOrder",headers:{"Content-Type":"application/json"},body:{amount:1}}}));
  assert.equal(executed.statusCode,200);assert.equal((executed.headers as Record<string,string>)["set-cookie"],"[REDACTED]");assert.doesNotMatch(JSON.stringify(executed),/private-token-value|session=private/);
  const evidence=payload(await session.client.callTool({name:"read_evidence",arguments:{artifactId:executed.artifactId}}));assert.equal(evidence.statusCode,200);assert.equal(evidence.artifactId,executed.artifactId);
  const stored=await readFile(session.traceFile,"utf8");assert.doesNotMatch(stored,/request-secret-value|private-token-value|session=private/);
  const snapshot=JSON.parse(stored) as Snapshot,failed=traces(snapshot).filter(trace=>trace.executionResult==="failed");
  assert.equal(snapshot.run.state,"running");assert.equal(Object.keys(snapshot.artifacts).length,1);assert.equal(snapshot.run.evidence.length,1);
  assert.ok(failed.every(trace=>trace.generatedArtifactId===null&&trace.artifactIds?.length===0));
});

test("stdio MCP cannot bypass host, port, or dangerous-method guardrails",async t=>{
  const directory=await mkdtemp(join(tmpdir(),"a-pidoc-mcp-policy-"));t.after(()=>rm(directory,{recursive:true,force:true}));
  const cases=[
    {label:"host",doc:document(43210,"post",true,"localhost"),options:{allowedHosts:"127.0.0.1",allowedPorts:"43210"},operationId:"postOrder"},
    {label:"port",doc:document(43210),options:{allowedHosts:"127.0.0.1",allowedPorts:"43211"},operationId:"postOrder"},
    {label:"delete",doc:document(43210,"delete",true),options:{allowedHosts:"127.0.0.1",allowedPorts:"43210"},operationId:"deleteOrder"}
  ];
  for(const item of cases){
    const session=await openSession(directory,item.doc,item.options);t.after(session.close);
    const blocked=await session.client.callTool({name:"execute_http",arguments:{operationId:item.operationId,body:{amount:1}}});
    assert.equal(blocked.isError,true,item.label);assert.equal(payload(blocked).errorCode,"API_POLICY_BLOCKED",item.label);
    assert.notEqual((await session.client.callTool({name:"read_api_document",arguments:{}})).isError,true,item.label);
    const snapshot=JSON.parse(await readFile(session.traceFile,"utf8")) as Snapshot,failed=traces(snapshot).find(trace=>trace.executionResult==="failed");
    assert.equal(snapshot.run.state,"running",item.label);assert.equal(failed?.generatedArtifactId,null,item.label);assert.deepEqual(failed?.artifactIds,[],item.label);
    await session.close();
  }
});

test("stdio MCP does not recover an unrelated no-progress terminal state",async t=>{
  const directory=await mkdtemp(join(tmpdir(),"a-pidoc-mcp-recovery-scope-"));t.after(()=>rm(directory,{recursive:true,force:true}));
  const session=await openSession(directory,document(43210,"post",false),{allowedPorts:"43210"});t.after(session.close);
  for(let index=0;index<21;index++){
    await session.client.callTool({name:"read_api_document",arguments:{}});
  }
  const before=JSON.parse(await readFile(session.traceFile,"utf8")) as Snapshot;
  assert.equal(before.run.state,"blocked");
  assert.ok(before.run.steps.some(step=>step.kind==="state_transition"&&step.data.code==="NO_PROGRESS_LIMIT"));

  const rejected=await session.client.callTool({name:"execute_http",arguments:{operationId:"postOrder",body:{amount:1}}});
  assert.equal(rejected.isError,true);assert.equal(payload(rejected).errorCode,"API_POLICY_BLOCKED");
  const after=JSON.parse(await readFile(session.traceFile,"utf8")) as Snapshot;
  assert.equal(after.run.state,"blocked");
  assert.equal(after.run.steps.some(step=>step.kind==="state_transition"&&step.data.code==="MCP_CALL_REJECTED_RECOVERED"),false);

  const readAfterRejection=await session.client.callTool({name:"read_api_document",arguments:{}});
  assert.equal(readAfterRejection.isError,true);assert.equal(payload(readAfterRejection).errorCode,"RUN_INACTIVE");
});

test("stdio MCP retains redirect rejection and timeout error codes",async t=>{
  const directory=await mkdtemp(join(tmpdir(),"a-pidoc-mcp-limits-"));t.after(()=>rm(directory,{recursive:true,force:true}));
  const api=createServer((request,response)=>{
    if(request.url==="/redirect"){response.writeHead(302,{Location:"/target"}).end();return;}
    setTimeout(()=>{if(!response.destroyed)response.writeHead(200,{"Content-Type":"application/json"}).end("{}");},50);
  });
  await new Promise<void>(done=>api.listen(0,"127.0.0.1",done));t.after(async()=>{api.closeAllConnections();await new Promise<void>(done=>api.close(()=>done()));});
  const address=api.address();if(!address||typeof address==="string")throw new Error("TEST_SERVER_BIND_FAILED");
  const doc={openapi:"3.0.3",info:{title:"MCP limits",version:"1"},servers:[{url:`http://127.0.0.1:${address.port}`}],paths:{"/redirect":{get:{operationId:"redirect",responses:{"302":{description:"redirect"}}}},"/slow":{get:{operationId:"slow",responses:{"200":{description:"ok"}}}}}};
  const session=await openSession(directory,doc,{allowedPorts:String(address.port),timeoutMs:10});t.after(session.close);
  const redirect=await session.client.callTool({name:"execute_http",arguments:{operationId:"redirect"}});assert.equal(payload(redirect).errorCode,"NETWORK_ERROR");
  const slow=await session.client.callTool({name:"execute_http",arguments:{operationId:"slow"}});assert.equal(payload(slow).errorCode,"REQUEST_TIMEOUT");
  assert.notEqual((await session.client.callTool({name:"read_api_document",arguments:{}})).isError,true);
});

test("stdio MCP returns stable input errors without secrets or forged Artifacts",async t=>{
  const directory=await mkdtemp(join(tmpdir(),"a-pidoc-mcp-errors-"));t.after(()=>rm(directory,{recursive:true,force:true}));
  const api=createServer((request,response)=>{response.writeHead(200,{"Content-Type":"application/json"});response.end(request.url==="/big"?JSON.stringify({pad:"x".repeat(10_000)}):"{}");});
  await new Promise<void>(done=>api.listen(0,"127.0.0.1",done));t.after(async()=>{api.closeAllConnections();await new Promise<void>(done=>api.close(()=>done()));});
  const address=api.address();if(!address||typeof address==="string")throw new Error("TEST_SERVER_BIND_FAILED");
  const doc={openapi:"3.0.3",info:{title:"MCP errors",version:"1"},servers:[{url:`http://127.0.0.1:${address.port}`}],paths:{
    "/orders":{post:{operationId:"postOrder","x-a-pidoc-side-effect-free":true,responses:{"200":{description:"ok"}}}},
    "/items/{id}":{delete:{operationId:"deleteItem",responses:{"204":{description:"gone"}}}},
    "/big":{get:{operationId:"bigGet",responses:{"200":{description:"ok"}}}}
  }};
  const session=await openSession(directory,doc,{allowedPorts:String(address.port),maxResponseBytes:1024});t.after(session.close);
  const invalid=await session.client.callTool({name:"execute_http",arguments:{}});assert.equal(invalid.isError,true);assert.match(String(invalid.content[0]?.type==="text"?invalid.content[0].text:""),/Input validation error.*operationId/);
  const unknownExecute=await session.client.callTool({name:"execute_http",arguments:{operationId:"nope"}});assert.equal(payload(unknownExecute).errorCode,"UNKNOWN_API_OPERATION");
  const missingPath=await session.client.callTool({name:"execute_http",arguments:{operationId:"deleteItem"}});assert.equal(payload(missingPath).errorCode,"INVALID_API_REQUEST");
  const unknownDocument=await session.client.callTool({name:"read_api_document",arguments:{operationId:"nope"}});assert.equal(payload(unknownDocument).errorCode,"UNKNOWN_API_OPERATION");
  const oversized=await session.client.callTool({name:"execute_http",arguments:{operationId:"bigGet"}});assert.equal(payload(oversized).errorCode,"RESPONSE_TOO_LARGE");
  const secret="Bearer must-not-enter-trace";
  const sensitive=await session.client.callTool({name:"execute_http",arguments:{operationId:"postOrder",headers:{Authorization:secret}}});assert.equal(payload(sensitive).errorCode,"API_POLICY_BLOCKED");
  assert.notEqual((await session.client.callTool({name:"read_api_document",arguments:{}})).isError,true);
  const raw=await readFile(session.traceFile,"utf8");assert.doesNotMatch(raw,/must-not-enter-trace/);
  const snapshot=JSON.parse(raw) as Snapshot,failed=traces(snapshot).filter(trace=>trace.executionResult==="failed");
  assert.deepEqual(failed.map(trace=>trace.errorCode),["UNKNOWN_API_OPERATION","INVALID_API_REQUEST","UNKNOWN_API_OPERATION","RESPONSE_TOO_LARGE","API_POLICY_BLOCKED"]);
  assert.ok(failed.every(trace=>trace.generatedArtifactId===null&&trace.artifactIds?.length===0));
  assert.equal(Object.keys(snapshot.artifacts).length,1);assert.equal(snapshot.run.evidence.length,1);assert.equal(snapshot.run.state,"running");
});
