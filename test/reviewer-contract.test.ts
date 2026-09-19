import test from "node:test";
import assert from "node:assert/strict";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { harness, task } from "./harness-helpers.js";
import { ApiHarnessRuntime } from "../src/api-harness/runtime.js";
import { createDiagnosticSandbox, RuntimeApiBackend } from "../src/api-harness/tool-bundles.js";
import { PiEvidenceReviewer, REVIEW_PROMPT } from "../src/api-harness/reviewer.js";
import type { EvidencePackage } from "../src/api-harness/contracts.js";
import type { PiLoopOptions } from "../src/harness/pi-loop-adapter.js";
const call=(name:string,args:Record<string,unknown>,id:string)=>fauxAssistantMessage(fauxToolCall(name,args,{id}));
const p:EvidencePackage={claimRefs:[{claim:"Corrected request validated with 200",evidenceIds:["http_observation-after"]}],httpObservationIds:["http_observation-before","http_observation-after"]};
type RuntimeOptions=Omit<PiLoopOptions,"prompt"|"hooks">;
async function setup(t:Parameters<typeof harness>[0],configure?:(options:RuntimeOptions)=>RuntimeOptions){
  const sandbox=await createDiagnosticSandbox();t.after(()=>sandbox.close());const h=await harness(t,[],[]);
  const options=configure?configure(h.options):h.options;
  const runtime=new ApiHarnessRuntime(h.store,new RuntimeApiBackend(sandbox.endpoint),{hosts:["127.0.0.1"],ports:[Number(new URL(sandbox.endpoint).port)],environments:["sandbox"],credentialScopes:[]},options,()=>false);
  const initial=[call("execute_http",{url:sandbox.endpoint,method:"POST",contentType:"text/plain",amount:42},"before"),call("read_api_document",{},"doc"),call("execute_http",{url:sandbox.endpoint,method:"POST",contentType:"application/json",amount:42},"after")];
  return {...h,options,runtime,initial,input:{...task(),taskFamily:"runtime-api",allowedToolBundles:["runtime-api","shared"],budget:{...task().budget,maxModelCalls:12}}};
}
test("Reviewer receives independent bounded evidence with no tools or Lead transcript and accounts usage",async t=>{
  const h=await setup(t);h.provider.setResponses([...h.initial,call("submit_completion",{package:p},"finish"),(context)=>{
    assert.equal(context.systemPrompt,REVIEW_PROMPT);assert.equal(context.tools?.length??0,0);assert.equal(context.messages.length,1);
    const payload=JSON.parse(String((context.messages[0] as {content:unknown}).content));assert.equal(payload.evidence.find((a:{id:string})=>a.id==="http_observation-after").data.response.status,200);
    return fauxAssistantMessage(JSON.stringify({verdict:"pass",reasons:["Claim supported by actual 200 observation"]}));
  }]);
  const s=await h.runtime.start(h.input);assert.equal(s.run.state,"resolved");assert.equal(s.run.usage.modelCalls,5);
  assert.equal(s.run.steps.filter(v=>v.kind==="review"&&(v.data as {type?:string}).type==="verdict").length,1);
  assert.equal(s.messages.some(m=>(m as {content?:unknown}).content===REVIEW_PROMPT),false);
});
test("Reviewer retries a transient provider response and accounts the attempt",async t=>{
  let providerCalls=0,now=0;const waits:number[]=[];
  const h=await setup(t,options=>({...options,retry:{
    fetch:(async()=>new Response(providerCalls++===0?"busy":"ok",{status:providerCalls===1?503:200})) as typeof globalThis.fetch,
    now:()=>now,random:()=>0.5,sleep:async ms=>{waits.push(ms);now+=ms;},policy:{baseDelayMs:100}
  },streamFn:async(model,context,requestOptions)=>{
    if(context.systemPrompt===REVIEW_PROMPT){const response=await requestOptions?.fetch?.("https://provider.test/reviewer");assert.equal(response?.status,200);}
    return options.streamFn(model,context,requestOptions);
  }}));
  h.provider.setResponses([...h.initial,call("submit_completion",{package:p},"finish"),fauxAssistantMessage(JSON.stringify({verdict:"pass",reasons:["Claim supported by actual 200 observation"]}))]);
  const s=await h.runtime.start(h.input);
  assert.equal(s.run.state,"resolved");assert.equal(providerCalls,2);assert.deepEqual(waits,[100]);assert.equal(s.run.usage.modelCalls,6);
  const retries=s.run.steps.filter(v=>v.kind==="review"&&(v.data as {type?:string}).type==="provider_retry");
  assert.ok(retries.some(v=>(v.data as {retry?:{type?:string}}).retry?.type==="retry_attempt"));
});
test("two evidence inspections followed by valid submission are not a third repeated observation",async t=>{
  const h=await setup(t);h.provider.setResponses([...h.initial,call("read_evidence",{id:"http_observation-before"},"inspect-before"),call("read_evidence",{id:"http_observation-after"},"inspect-after"),call("submit_completion",{package:p},"finish"),fauxAssistantMessage(JSON.stringify({verdict:"pass",reasons:["Observed correction is supported"]}))]);
  const s=await h.runtime.start(h.input);assert.equal(s.run.state,"resolved");assert.equal(s.run.steps.some(v=>v.kind==="state_transition"&&(v.data as {code?:string}).code==="NO_PROGRESS_LIMIT"),false);
});
test("repeated inspections of one Artifact stop after the bounded first-read credit",async t=>{
  const h=await setup(t);h.provider.setResponses([...h.initial,...Array.from({length:4},(_,i)=>call("read_evidence",{id:"http_observation-after"},`inspect-${i}`))]);
  const s=await h.runtime.start(h.input);assert.equal(s.run.state,"blocked");assert.equal(s.run.evidence.length,3);
  assert.ok(s.run.steps.some(v=>v.kind==="state_transition"&&(v.data as {code?:string}).code==="NO_PROGRESS_LIMIT"));
});
test("Reviewer revise feedback returns to Lead exactly once then passes with corrected claim",async t=>{
  const h=await setup(t),bad={...p,claimRefs:[{claim:"All production APIs are now permanently healthy",evidenceIds:["http_observation-after"]}]};
  h.provider.setResponses([...h.initial,call("submit_completion",{package:bad},"bad"),fauxAssistantMessage(JSON.stringify({verdict:"revise",missingEvidence:[],contradictions:["Local sandbox cannot prove permanent production health"]})),context=>{
    assert.match(JSON.stringify(context.messages),/Local sandbox cannot prove/);return call("submit_completion",{package:p},"fixed");
  },fauxAssistantMessage(JSON.stringify({verdict:"pass",reasons:["Claim narrowed to observed validation"]}))]);
  const s=await h.runtime.start(h.input);assert.equal(s.run.state,"resolved");assert.equal(s.run.steps.filter(v=>v.kind==="review"&&(v.data as {type?:string}).type==="revision_requested").length,1);
});
test("second revise persists manual handoff and restart cannot reset review attempts",async t=>{
  const h=await setup(t),rev=fauxAssistantMessage(JSON.stringify({verdict:"revise",missingEvidence:["Supported claim"],contradictions:[]}));
  h.provider.setResponses([...h.initial,call("submit_completion",{package:p},"one"),rev,call("submit_completion",{package:p},"two"),rev]);
  const s=await h.runtime.start(h.input);assert.equal(s.run.state,"blocked");assert.equal(s.run.steps.filter(v=>v.kind==="review"&&(v.data as {type?:string}).type==="manual_handoff").length,1);
  const result=await new PiEvidenceReviewer(h.store,h.options).review(p);assert.equal(result.verdict,"block");assert.equal(h.provider.getPendingResponseCount(),0);
});
test("hard Gate failure skips Reviewer and cannot be overridden by semantic pass",async t=>{
  const h=await setup(t);h.provider.setResponses([...h.initial,call("submit_completion",{package:{...p,httpObservationIds:[]}},"fake"),fauxAssistantMessage(JSON.stringify({verdict:"pass",reasons:["fake"]}))]);
  const s=await h.runtime.start(h.input);assert.equal(s.run.state,"unresolved");assert.equal(s.run.steps.some(v=>v.kind==="review"),false);assert.equal(h.provider.getPendingResponseCount(),1);
});
test("malformed review and attempted execution tools fail closed in one independent turn",async t=>{
  const h=await setup(t);h.provider.setResponses([...h.initial,call("submit_completion",{package:p},"finish"),call("execute_http",{},"review-write")]);
  const s=await h.runtime.start(h.input);assert.equal(s.run.state,"blocked");assert.equal(s.run.evidence.length,3);
});
test("Reviewer cannot exceed shared model budget or accept unaudited oversized context",async t=>{
  const h=await setup(t);h.input.budget.maxModelCalls=4;h.provider.setResponses([...h.initial,call("submit_completion",{package:p},"finish")]);
  const s=await h.runtime.start(h.input);assert.equal(s.run.state,"blocked");assert.equal(s.run.usage.modelCalls,4);
});
