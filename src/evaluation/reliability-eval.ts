import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { registerFauxProvider, streamSimple, type FauxResponseFactory } from "@earendil-works/pi-ai/compat";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { REVIEW_PROMPT } from "../api-harness/reviewer.js";
import { RuntimeApiBackend } from "../api-harness/tool-bundles.js";
import { TrajectoryStore } from "../harness/trajectory-store.js";
import { runMetrics } from "./agentic-eval.js";
import { ReliabilityStore } from "../reliability/store.js";
import { ProbeScheduler, validationVariants, probeMetrics } from "../reliability/probes.js";
import { AnomalyRouter, defaultRouting } from "../reliability/router.js";
import { ReliabilityWorker, type WorkerFactory } from "../reliability/worker.js";
import type { ProbePlan } from "../reliability/contracts.js";
import { digest } from "../harness/digest.js";
export const RELIABILITY_DATASET="reliability-v5-v1";
export async function reliabilitySandbox(){
  let faults=0,missing=false;const server=createServer(async(q,r)=>{
    let raw="";for await(const chunk of q){raw+=String(chunk);if(raw.length>8192){r.writeHead(413).end('{}');return;}}
    let body:unknown;try{body=JSON.parse(raw);}catch{body=null;}
    const status=q.url!=="/orders"?404:q.method!=="POST"?405:faults-->0?503:q.headers["content-type"]!=="application/json"?415:typeof(body as {amount?:unknown})?.amount!=="number"?400:200;
    r.writeHead(status,{"Content-Type":"application/json"});r.end(JSON.stringify({status,...(missing?{}:{message:status===200?"Request validated; no order created":status===503?"Temporary fixture outage":"Invalid request"})}));
  });await new Promise<void>(done=>server.listen(0,"127.0.0.1",done));const port=(server.address() as {port:number}).port;
  return {endpoint:`http://127.0.0.1:${port}/orders`,injectFault:()=>{faults=3;},injectSchema:()=>{missing=true;},close:async()=>{server.closeAllConnections();await new Promise<void>(done=>server.close(()=>done()));}};
}
export function reliabilityPolicy(endpoint:string):FauxResponseFactory{
  return context=>{
    if(context.systemPrompt===REVIEW_PROMPT)return fauxAssistantMessage(JSON.stringify({verdict:"pass",reasons:["Only observed local validation is claimed; production recovery is not asserted"]}));
    const facts:Array<{id:string;kind:string;data:any}>=[];
    for(const m of context.messages){
      if(m.role==="user"&&typeof m.content==="string")try{const b=JSON.parse(m.content.replace(/^API WORKSPACE BOARD\n/,""));for(const e of b.evidence??[])if(e.valid&&e.observation)facts.push({id:e.id,kind:e.kind,data:JSON.parse(e.observation)});}catch{}
      if(m.role==="toolResult"){const r=m.details as {success?:boolean;evidence?:Array<{id:string;kind:string}>;data?:unknown};if(r?.success)for(const e of r.evidence??[])facts.push({...e,data:r.data});}
    }
    const unique=[...new Map(facts.map(f=>[f.id,f])).values()],find=(k:string)=>unique.filter(f=>f.kind===k).at(-1),make=(name:string,args:Record<string,unknown>)=>fauxAssistantMessage(fauxToolCall(name,args,{id:`v5-${randomUUID()}`}));
    const monitor=find("monitoring_observation"),doc=find("api_operation"),http=unique.filter(f=>f.kind==="http_observation"),last=http.at(-1),receipt=find("publication_receipt");
    if(!monitor)return make("read_monitoring_evidence",{});
    if(!http.length){const request=monitor.data.observations[0]?.request;return make("execute_http",{url:endpoint,method:"POST",contentType:request?.headers?.["Content-Type"]??"application/json",amount:request?.body?.amount??42});}
    if(!doc)return make("read_api_document",{});
    if(last?.data.response.status!==200)return make("execute_http",{url:endpoint,method:"POST",contentType:doc.data.requiredContentType,amount:42});
    if(!receipt)return make("publish_report",{message:"Local monitoring observations and API validation are available; production health is not established",evidenceIds:[monitor.id,last.id]});
    return make("submit_completion",{package:{claimRefs:[{claim:"Registered local sandbox validation returned HTTP 200",evidenceIds:[last.id]}],httpObservationIds:http.map(f=>f.id)}});
  };
}
export async function runReliabilityScenario(factoryOverride?:WorkerFactory,outputDirectory?:string){
  const dir=outputDirectory??await mkdtemp(join(tmpdir(),"a-pidoc-v5-eval-")),sandbox=await reliabilitySandbox(),provider=factoryOverride?undefined:registerFauxProvider({provider:`v5-${randomUUID()}`,models:[{id:"lead",input:["text"]}]});
  let factoryCalls=0;const store=new ReliabilityStore(join(dir,"state.json")),scheduler=new ProbeScheduler(store),router=new AnomalyRouter(store);
  const plan:ProbePlan={id:"orders",tenantId:"demo-team",endpoint:sandbox.endpoint,method:"POST",sideEffectFree:true,enabled:true,intervalMs:100,nextAt:0,revision:0,risk:"high",latencyLimitMs:5000,variants:validationVariants({amount:42},{type:"object",properties:{amount:{type:"number"}},required:["amount"]}),expectedResponse:{type:"object",properties:{status:{type:"number"},message:{type:"string"}},required:["status","message"]}};
  await scheduler.register(plan);
  const factory:WorkerFactory=async(job,run,signal)=>{
    factoryCalls++;if(factoryOverride)return factoryOverride(job,run,signal);
    provider!.setResponses(Array.from({length:40},()=>reliabilityPolicy(sandbox.endpoint)));
    return {backend:new RuntimeApiBackend(sandbox.endpoint),policy:{hosts:["127.0.0.1"],ports:[Number(new URL(sandbox.endpoint).port)],environments:["sandbox"],credentialScopes:[]},options:{model:provider!.getModel(),streamFn:streamSimple,signal},authorizeApproval:i=>i.actorId==="scenario-owner"&&i.source==="local-scenario"&&i.tenantId==="demo-team"};
  };
  const worker=new ReliabilityWorker(store,factory,defaultRouting,180_000,i=>i.actorId==="scenario-owner");
  try{
    for(const now of [0,100,200])for(const o of await scheduler.tick(now))await router.route(o);const healthyProbes=(await store.load()).probes.length,healthyModelRequests=factoryCalls;
    sandbox.injectFault();for(const o of await scheduler.tick(300))await router.route(o);
    let job=await worker.work(),approvals=0;
    while(job?.state==="waiting_approval"&&approvals<2){const run=await new TrajectoryStore(job.runFile).load();if(run.pendingApproval?.toolName!=="publish_report")break;
      await worker.grantApproval(job.id,run.pendingApproval.approvalId,{actorId:"scenario-owner",source:"local-scenario",tenantId:"demo-team"});await worker.requeueApproved(job.id,{actorId:"scenario-owner",source:"test-owner",confirmedWorkerStopped:true});approvals++;job=await worker.work();}
    const first=job?runMetrics(await new TrajectoryStore(job.runFile).load()):null;
    sandbox.injectSchema();for(const o of await scheduler.tick(400))await router.route(o);let schemaJob=await worker.work();
    while(schemaJob?.state==="waiting_approval"&&approvals<4){const run=await new TrajectoryStore(schemaJob.runFile).load();if(run.pendingApproval?.toolName!=="publish_report")break;await worker.grantApproval(schemaJob.id,run.pendingApproval.approvalId,{actorId:"scenario-owner",source:"local-scenario",tenantId:"demo-team"});await worker.requeueApproved(schemaJob.id,{actorId:"scenario-owner",source:"test-owner",confirmedWorkerStopped:true});approvals++;schemaJob=await worker.work();}
    const schemaRun=schemaJob?await new TrajectoryStore(schemaJob.runFile).load():undefined;
    const schemaInvestigated=!!schemaRun&&schemaRun.run.usage.modelCalls>=2&&["monitoring_observation","api_operation"].every(k=>schemaRun.run.evidence.some(e=>e.kind===k))&&["unresolved","blocked","resolved"].includes(schemaRun.run.state);
    const state=await store.load();return {dataset:RELIABILITY_DATASET,liveEvidence:!!factoryOverride,healthyProbes,healthyModelRequests,approvals,task:job?{id:job.id,state:job.state,metrics:first,approval:approvals>0}:null,schemaTask:schemaJob?{state:schemaJob.state,reason:schemaJob.handoff?.reason,runState:schemaJob.runState,investigated:schemaInvestigated,metrics:schemaRun?runMetrics(schemaRun):null}:null,probeMetrics:probeMetrics(state.probes),incidentKinds:Object.values(state.incidents).map(i=>i.kind),stateDigest:digest(state),passed:healthyModelRequests===0&&healthyProbes===6&&approvals>=1&&job?.state==="completed"&&schemaJob?.state==="manual_handoff"&&schemaInvestigated,stateFile:store.file};
  }finally{provider?.unregister();await sandbox.close();if(!outputDirectory)await rm(dir,{recursive:true,force:true});}
}
