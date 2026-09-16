import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { join } from "node:path";
import { mkdir } from "node:fs/promises";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { harness } from "./harness-helpers.js";
import { ReliabilityStore } from "../src/reliability/store.js";
import { ProbeScheduler, ProbeRunner, validationVariants, probeMetrics, validatePlan } from "../src/reliability/probes.js";
import { AnomalyRouter, defaultRouting } from "../src/reliability/router.js";
import { ReliabilityWorker, MonitoringBackend } from "../src/reliability/worker.js";
import { createDiagnosticSandbox, RuntimeApiBackend, RepositoryContractBackend } from "../src/api-harness/tool-bundles.js";
import { ApiHarnessRuntime } from "../src/api-harness/runtime.js";
import { TrajectoryStore } from "../src/harness/trajectory-store.js";
import type { ProbePlan, ProbeObservation, OperatorIdentity } from "../src/reliability/contracts.js";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { spawn } from "node:child_process";
import { monitoringRuntimeBackend } from "../src/reliability/backend.js";
const call=(name:string,args:Record<string,unknown>,id:string)=>fauxAssistantMessage(fauxToolCall(name,args,{id}));
const review=fauxAssistantMessage(JSON.stringify({verdict:"pass",reasons:["The claim is supported by local observations"]}));
const schema={type:"object",properties:{status:{type:"number"},message:{type:"string"}},required:["status","message"]};
const operator:OperatorIdentity={actorId:"owner",source:"test-owner",confirmedWorkerStopped:true};
async function setup(t:Parameters<typeof harness>[0]){
  const h=await harness(t,[],[]),sandbox=await createDiagnosticSandbox();t.after(()=>sandbox.close());
  const store=new ReliabilityStore(join(h.dir,"queue.json")),scheduler=new ProbeScheduler(store);
  const plan:ProbePlan={id:"orders",tenantId:"team-a",endpoint:sandbox.endpoint,method:"POST",sideEffectFree:true,intervalMs:100,enabled:true,nextAt:0,revision:0,latencyLimitMs:1000,expectedResponse:schema,variants:[{id:"valid",headers:{"Content-Type":"application/json"},body:{amount:42},expectedStatus:200}],risk:"low"};
  await scheduler.register(plan);
  const router=new AnomalyRouter(store),factory=async(_job:unknown,_run:TrajectoryStore,signal:AbortSignal)=>({backend:new RuntimeApiBackend(sandbox.endpoint),policy:{hosts:["127.0.0.1"],ports:[Number(new URL(sandbox.endpoint).port)],environments:["sandbox" as const],credentialScopes:[]},options:{...h.options,signal},authorizeApproval:()=>false});
  const worker=new ReliabilityWorker(store,factory,defaultRouting,30_000,i=>i.actorId==="owner"&&i.source==="test-owner");
  return {...h,sandbox,store,scheduler,plan,router,worker,factory};
}
async function incident(h:Awaited<ReturnType<typeof setup>>,status=503){
  const o:ProbeObservation={id:`o-${status}`,planId:"orders",tenantId:"team-a",variantId:"valid",scheduledAt:0,observedAt:Date.now(),status,expectedStatus:200,durationMs:1,body:{status},schemaIssues:[],healthy:false};
  await h.store.update(s=>{s.probes.push(o);});return (await h.router.route(o))!;
}
test("V5 healthy and generated negative probes run real HTTP with zero model calls",async t=>{
  const h=await setup(t);await h.store.update(s=>{s.plans.orders!.variants=validationVariants({amount:42},{type:"object",properties:{amount:{type:"number"}},required:["amount"]});});
  const probes=await h.scheduler.tick(0);assert.equal(probes.length,2);assert.ok(probes.every(o=>o.healthy));assert.deepEqual(probes.map(o=>o.status),[200,400]);
  for(const o of probes)assert.equal(await h.router.route(o),undefined);assert.equal(Object.keys((await h.store.load()).jobs).length,0);assert.equal(h.provider.getPendingResponseCount(),0);
});
test("V5 scheduler persists slot dedup, disable and restart without catch-up flood",async t=>{
  const h=await setup(t);assert.equal((await h.scheduler.tick(0)).length,1);assert.equal((await new ProbeScheduler(new ReliabilityStore(h.store.file)).tick(0)).length,0);
  await h.scheduler.setEnabled("orders",false,10);assert.equal((await h.scheduler.tick(100)).length,0);await h.scheduler.setEnabled("orders",true,1000);assert.equal((await h.scheduler.tick(1000)).length,1);assert.equal((await h.scheduler.tick(1000)).length,0);assert.equal((await h.store.load()).plans.orders!.nextAt,1100);
});
test("V5 probes reject unsafe methods, destinations, credentials and unsupported schemas",async t=>{
  const h=await setup(t);for(const p of [{...h.plan,endpoint:"http://169.254.169.254/orders"},{...h.plan,method:"DELETE"},{...h.plan,endpoint:h.plan.endpoint.replace("/orders","/delete")},{...h.plan,expectedResponse:{type:"string",pattern:".*"}},{...h.plan,variants:[{...h.plan.variants[0]!,headers:{Authorization:"Bearer private-token"}}]}])assert.throws(()=>validatePlan(p as ProbePlan));
  await assert.rejects(()=>new ProbeRunner().execute(h.plan,{...h.plan.variants[0]!,headers:{Authorization:"Bearer private-token"}},0),/UNREGISTERED_PROBE_VARIANT/);
});
test("V5 bounded probe detects actual schema drift and rejects oversized responses",async t=>{
  const h=await setup(t);let large=false;const server=createServer((_q,r)=>r.end(large?JSON.stringify({text:"x".repeat(9000)}):JSON.stringify({status:200})));
  await new Promise<void>(done=>server.listen(0,"127.0.0.1",done));t.after(async()=>{server.closeAllConnections();await new Promise<void>(done=>server.close(()=>done()));});
  const port=(server.address() as {port:number}).port,p={...h.plan,endpoint:`http://127.0.0.1:${port}/orders`};
  const o=await new ProbeRunner().execute(p,p.variants[0]!,0);assert.equal(o.healthy,false);assert.match(o.schemaIssues.join(),/message/);large=true;const huge=await new ProbeRunner().execute(p,p.variants[0]!,0);assert.equal(huge.networkError,"PROBE_NETWORK_OR_OUTPUT_ERROR");
});
test("V5 known rate limits produce deterministic incidents and no queue/model work",async t=>{
  const h=await setup(t),i=await incident(h,429);assert.equal(i.route,"deterministic");assert.equal(Object.keys((await h.store.load()).jobs).length,0);assert.equal(await h.worker.work(),undefined);
});

test("V5 incident snapshots remain historical after a real probe recovers",async t=>{
  const h=await setup(t);await incident(h);const observations=(await h.store.load()).probes;
  const backend=new MonitoringBackend(new RuntimeApiBackend(h.sandbox.endpoint),observations,"historical","team-a"),tool=backend.tools.find(t=>t.name==="read_monitoring_evidence")!;
  const context={runId:"snapshot",toolCallId:"read",environment:"sandbox" as const,workspaceRevision:0};
  const before=await tool.execute({},context);assert.equal((await h.scheduler.tick(0))[0]!.status,200);
  const after=await tool.execute({},context);assert.deepEqual(after.data,before.data);assert.equal((after.data as any).liveRefresh,false);assert.equal((after.data as any).observations[0].status,503);
});

test("V5 read-only health incidents use the same Harness and recheck the original plan",async t=>{
  const h=await setup(t);let calls=0;const server=createServer((_q,r)=>{const status=calls++<2?503:200;r.writeHead(status,{"Content-Type":"application/json"});r.end(JSON.stringify({status,message:"Local health validation"}));});
  await new Promise<void>(done=>server.listen(0,"127.0.0.1",done));t.after(async()=>{server.closeAllConnections();await new Promise<void>(done=>server.close(()=>done()));});
  const endpoint=`http://127.0.0.1:${(server.address() as {port:number}).port}/health`,plan:ProbePlan={...h.plan,id:"health",endpoint,method:"GET",variants:[{id:"valid",headers:{},body:null,expectedStatus:200}]};await h.scheduler.register(plan);
  const o=(await h.scheduler.tick(0)).find(o=>o.planId==="health")!;const i=(await h.router.route(o))!;
  h.provider.setResponses([call("read_monitoring_evidence",{},"monitor"),call("execute_http",{url:endpoint,method:"GET"},"before"),call("read_api_document",{},"doc"),call("execute_http",{url:endpoint,method:"GET"},"after"),call("submit_completion",{package:{claimRefs:[{claim:"Local health returned 200",evidenceIds:["http_observation-after"]}],httpObservationIds:["http_observation-before","http_observation-after"]}},"finish"),review]);
  const worker=new ReliabilityWorker(h.store,async(_j,_r,signal)=>({backend:monitoringRuntimeBackend(plan),policy:{hosts:["127.0.0.1"],ports:[Number(new URL(endpoint).port)],environments:["sandbox"],credentialScopes:[]},options:{...h.options,signal},authorizeApproval:()=>false}));
  assert.equal((await worker.work())!.state,"completed");assert.equal((await h.store.load()).incidents[i.id]!.status,"verified");assert.equal(calls,4);
});
test("V5 clusters repeated anomalies, enforces evidence scope and queue backpressure",async t=>{
  const h=await setup(t),i=await incident(h);const o=(await h.store.load()).probes[0]!;assert.equal((await h.router.route(o))!.id,i.id);assert.equal(Object.keys((await h.store.load()).jobs).length,1);
  await assert.rejects(()=>h.router.route({...o,tenantId:"other"}),/UNVERIFIED/);
  const bounded=new AnomalyRouter(h.store,{...defaultRouting,maxPending:1});const next={...o,id:"next",observedAt:o.observedAt+300_001};await h.store.update(s=>s.probes.push(next));const blocked=await bounded.route(next);assert.equal(blocked!.reason,"QUEUE_BACKPRESSURE");
});
test("V5 risk/model budget and explicit small-profile configuration govern routing",async t=>{
  const h=await setup(t);await h.store.update(s=>{s.plans.orders!.risk="high";});assert.equal((await incident(h)).route,"reviewer");
  const other={...(await h.store.load()).probes[0]!,id:"network",status:0,networkError:"PROBE_TIMEOUT",observedAt:Date.now()+600_000};await h.store.update(s=>{s.plans.orders!.risk="low";s.probes.push(other);});assert.equal((await new AnomalyRouter(h.store,{...defaultRouting,smallModelConfigured:true}).route(other))!.route,"small");
  const noBudget={...other,id:"no-budget",observedAt:other.observedAt+600_000};await h.store.update(s=>s.probes.push(noBudget));assert.equal((await new AnomalyRouter(h.store,{...defaultRouting,maxTaskCostUsd:0}).route(noBudget))!.route,"manual_handoff");
});
test("V5 complex anomaly uses the existing Pi Harness, real tools and independent Reviewer",async t=>{
  const h=await setup(t),i=await incident(h);
  h.provider.setResponses([call("read_monitoring_evidence",{},"monitor"),call("execute_http",{url:h.sandbox.endpoint,method:"POST",contentType:"text/plain",amount:42},"before"),call("read_api_document",{},"doc"),call("execute_http",{url:h.sandbox.endpoint,method:"POST",contentType:"application/json",amount:42},"after"),call("submit_completion",{package:{claimRefs:[{claim:"Local corrected validation returned 200",evidenceIds:["http_observation-after"]}],httpObservationIds:["http_observation-before","http_observation-after"]}},"finish"),review]);
  const j=await h.worker.work();const s=await new TrajectoryStore(j!.runFile).load();assert.equal(j!.state,"completed",JSON.stringify({handoff:j!.handoff,last:s.run.steps.slice(-4),probe:(await h.store.load()).probes.at(-1)}));assert.equal(j!.usage!.modelCalls,6);assert.ok(s.run.steps.some(v=>v.kind==="review"));assert.ok(s.run.evidence.some(v=>v.kind==="monitoring_observation"));assert.equal((await h.store.load()).incidents[i.id]!.status,"verified");
});
test("V5 workers atomically enforce global concurrency and hold resources until cancelled execution returns",async t=>{
  const h=await setup(t),i=await incident(h);let entered!:()=>void,release!:()=>void;const inside=new Promise<void>(r=>entered=r),wait=new Promise<void>(r=>release=r);
  const slow=new ReliabilityWorker(h.store,async(j,r,s)=>{entered();await wait;return h.factory(j,r,s);},defaultRouting,30_000);
  const p=slow.work();await inside;assert.equal(await h.worker.work(),undefined);await slow.cancel(i.jobId!);assert.equal((await h.store.load()).jobs[i.jobId!]!.state,"running");release();const done=await p;assert.equal(done!.state,"cancelled");assert.equal(done!.usage!.modelCalls,0);
});
test("V5 worker timeout and queued cancellation persist explicit handoff without automatic replay",async t=>{
  const h=await setup(t),i=await incident(h);const timeout=new ReliabilityWorker(h.store,async(j,r,s)=>{await new Promise(done=>setTimeout(done,25));return h.factory(j,r,s);},defaultRouting,5);
  assert.equal((await timeout.work())!.state,"timed_out");assert.equal((await h.store.load()).jobs[i.jobId!]!.handoff!.compensation.status,"proposal_only");assert.equal(await h.worker.work(),undefined);
  const next={...(await h.store.load()).probes[0]!,id:"new",observedAt:Date.now()+600_000};await h.store.update(s=>s.probes.push(next));const queued=(await h.router.route(next))!;await h.worker.cancel(queued.jobId!);assert.equal((await h.store.load()).jobs[queued.jobId!]!.state,"cancelled");
});
test("V5 explicit stopped-worker recovery preserves transcript and rejects unconfirmed effects",async t=>{
  const h=await setup(t),i=await incident(h),job=(await h.store.load()).jobs[i.jobId!]!;
  await new TrajectoryStore(job.runFile).create({formatVersion:1,run:{runId:job.id,task:job.task,state:"running",steps:[],usage:{modelCalls:2,toolCalls:1,tokens:100,estimatedCostUsd:.001},evidence:[]},messages:[],stateRevision:0,workspaceRevision:0,evidenceSequence:0,elapsedMs:50,artifacts:{}});
  await h.store.update(s=>{s.jobs[job.id]!.state="running";});await mkdir(`${job.runFile}.runner.lock`);
  await assert.rejects(()=>h.worker.recover(job.id,{...operator,actorId:"intruder"}),/AUTHENTICATED/);const recovered=await h.worker.recover(job.id,operator);assert.equal(recovered.state,"queued");assert.equal(recovered.resume,true);assert.equal((await new TrajectoryStore(job.runFile).load()).run.usage.modelCalls,2);
  await h.store.update(s=>{s.jobs[job.id]!.state="running";});await new TrajectoryStore(job.runFile).transact(s=>{s.executionInDoubt={toolCallId:"write",actionDigest:"hash"};});const blocked=await h.worker.recover(job.id,operator);assert.equal(blocked.state,"manual_handoff");assert.match(blocked.handoff!.reason,/IN_DOUBT/);
});
test("V5 approval remains suspended, exact grant resumes through Harness and stores one local publication",async t=>{
  const h=await setup(t),i=await incident(h);const ownerFactory=async(j:unknown,r:TrajectoryStore,s:AbortSignal)=>({...await h.factory(j,r,s),authorizeApproval:(a:{actorId:string})=>a.actorId==="owner"});
  const worker=new ReliabilityWorker(h.store,ownerFactory,defaultRouting,30_000,a=>a.actorId==="owner");
  const args={message:"Local probe anomaly needs investigation",evidenceIds:["monitoring_observation-monitor"]};
  h.provider.setResponses([call("read_monitoring_evidence",{},"monitor"),call("publish_report",args,"publish")]);let j=(await worker.work())!;assert.equal(j.state,"waiting_approval");const run=new TrajectoryStore(j.runFile),s=await run.load();const count=s.run.usage.modelCalls;assert.equal(await worker.work(),undefined);assert.equal((await run.load()).run.usage.modelCalls,count);
  await assert.rejects(()=>worker.requeueApproved(j.id,operator),/EXACT_GRANT/);
  const env=await ownerFactory(j,run,new AbortController().signal),state=await h.store.load(),runtime=new ApiHarnessRuntime(run,new MonitoringBackend(env.backend,state.probes,i.id,"team-a"),env.policy,env.options,a=>a.actorId==="owner");await runtime.guardrail.grant(s.pendingApproval!.approvalId,{actorId:"owner",source:"test-owner",tenantId:"team-a"});
  await worker.requeueApproved(j.id,operator);h.provider.setResponses([call("publish_report",args,"reissue"),fauxAssistantMessage("Local diagnostic draft recorded; unresolved anomaly requires owner investigation")]);j=(await worker.work())!;assert.equal(j.state,"manual_handoff");const end=await run.load();assert.equal(end.run.steps.filter(v=>v.kind==="approval"&&(v.data as {type?:string}).type==="execution_confirmed").length,1);assert.equal((await h.store.load()).jobs[i.jobId!]!.usage!.modelCalls,4);
});
test("V5 rolling telemetry reports availability, rate limits and latency trend with distinct negative-test assertions",async t=>{
  const h=await setup(t),i=await incident(h,429),o=(await h.store.load()).probes[0]!;const metrics=probeMetrics([10,20,100,200].map((durationMs,n)=>({...o,id:String(n),status:n===3?429:200,durationMs,healthy:n!==3})));assert.equal(metrics.availability,.75);assert.equal(metrics.rateLimitRate,.25);assert.equal(metrics.p95Ms,200);assert.deepEqual(metrics.latencyTrend,{previousMeanMs:15,recentMeanMs:150});assert.equal(i.route,"deterministic");
});
test("V5 worker rechecks the original response contract even when the API Harness has a valid 200 completion",async t=>{
  const h=await setup(t);await h.store.update(s=>{s.plans.orders!.expectedResponse={type:"object",properties:{transaction_id:{type:"string"}},required:["transaction_id"]};});await incident(h);
  h.provider.setResponses([call("execute_http",{url:h.sandbox.endpoint,method:"POST",contentType:"text/plain",amount:42},"before"),call("read_api_document",{},"doc"),call("execute_http",{url:h.sandbox.endpoint,method:"POST",contentType:"application/json",amount:42},"after"),call("submit_completion",{package:{claimRefs:[{claim:"Local validation returned 200",evidenceIds:["http_observation-after"]}],httpObservationIds:["http_observation-before","http_observation-after"]}},"finish"),review]);
  const job=(await h.worker.work())!;assert.equal(job.runState,"resolved");assert.equal(job.state,"manual_handoff");assert.equal(job.handoff!.reason,"MONITORING_RECHECK_FAILED");
  const modelCalls=job.usage!.modelCalls;await h.store.update(s=>{s.jobs[job.id]!.state="running";});
  assert.equal((await h.worker.recover(job.id,operator)).state,"queued");
  const recovered=(await h.worker.work())!;assert.equal(recovered.state,"manual_handoff");assert.equal(recovered.handoff!.reason,"MONITORING_RECHECK_FAILED");assert.equal(recovered.usage!.modelCalls,modelCalls);
});
test("V5 persistent aggregate model cost budget rejects work before any provider call",async t=>{
  const h=await setup(t),i=await incident(h),worker=new ReliabilityWorker(h.store,h.factory,{...defaultRouting,maxTotalCostUsd:0});assert.equal(await worker.work(),undefined);assert.equal((await h.store.load()).jobs[i.jobId!]!.handoff!.reason,"GLOBAL_MODEL_COST_BUDGET");
});
test("V5 actual child-process crash after approved publication resumes the existing transcript without publishing twice",async t=>{
  const h=await setup(t),i=await incident(h);const env={...process.env};delete env.NODE_TEST_CONTEXT;
  const child=spawn(process.execPath,[resolve("dist/test/reliability-crash-helper.js"),h.store.file],{env,windowsHide:true,stdio:["ignore","pipe","pipe"]});let errors="";child.stderr.on("data",c=>{errors+=String(c);});
  const kill=setTimeout(()=>child.kill(),10_000);const code=await new Promise<number|null>((done,reject)=>{child.once("error",reject);child.once("close",done);}).finally(()=>clearTimeout(kill));assert.equal(code,73,errors);
  const job=(await h.store.load()).jobs[i.jobId!]!,run=new TrajectoryStore(job.runFile),before=await run.load();assert.equal(before.run.state,"running");assert.equal(before.run.steps.filter(v=>v.kind==="approval"&&(v.data as {type?:string}).type==="execution_confirmed").length,1);
  await h.worker.recover(job.id,operator);h.provider.setResponses([fauxAssistantMessage("Draft already recorded. Further diagnosis requires owner evidence; no repeated publication.")]);const resumed=(await h.worker.work())!;assert.equal(resumed.state,"manual_handoff");const after=await run.load();assert.equal(after.run.usage.modelCalls,before.run.usage.modelCalls+1);assert.equal(after.run.evidence.filter(v=>v.kind==="publication_receipt").length,1);assert.equal(Object.keys(JSON.parse(await readFile(`${run.file}.publications.json`,"utf8"))).length,1);
});
test("V5 actual contract digest signal is detected independently of a valid response Schema",async t=>{
  const h=await setup(t),server=createServer((_q,r)=>{r.setHeader("x-contract-digest","registered-v2");r.end(JSON.stringify({status:200,message:"Validated"}));});await new Promise<void>(done=>server.listen(0,"127.0.0.1",done));t.after(async()=>{server.closeAllConnections();await new Promise<void>(done=>server.close(()=>done()));});
  const endpoint=`http://127.0.0.1:${(server.address() as {port:number}).port}/orders`;await h.store.update(s=>{s.plans.orders!.endpoint=endpoint;s.plans.orders!.expectedContractDigest="registered-v1";});const o=(await h.scheduler.tick(0))[0]!;assert.equal(o.status,200);assert.deepEqual(o.schemaIssues,[]);assert.equal((await h.router.route(o))!.kind,"contract_drift");
});
test("V5 same-resource jobs cannot overlap even when two global worker slots are available",async t=>{
  const h=await setup(t),i=await incident(h);await h.store.update(s=>{const original=s.jobs[i.jobId!]!;s.jobs["job-second"]={...structuredClone(original),id:"job-second",key:"second",task:{...original.task,id:"job-second"},runFile:join(h.store.runRoot,"job-second.json")};});
  let entered!:()=>void,release!:()=>void;const inside=new Promise<void>(r=>entered=r),wait=new Promise<void>(r=>release=r),config={...defaultRouting,maxConcurrent:2};
  const first=new ReliabilityWorker(h.store,async(j,r,s)=>{entered();await wait;return h.factory(j,r,s);},config,30_000),second=new ReliabilityWorker(h.store,h.factory,config,30_000),active=first.work();await inside;assert.equal(await second.work(),undefined);await first.cancel(i.jobId!);release();assert.equal((await active)!.state,"cancelled");
});
