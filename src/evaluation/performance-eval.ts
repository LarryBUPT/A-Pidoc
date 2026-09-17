import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir, cpus, platform, arch, release } from "node:os";
import { join, resolve, relative, isAbsolute, sep } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { ReliabilityStore } from "../reliability/store.js";
import { ProbeScheduler, validationVariants } from "../reliability/probes.js";
import { AnomalyRouter } from "../reliability/router.js";
import { ReliabilityWorker } from "../reliability/worker.js";
import type { ProbePlan } from "../reliability/contracts.js";
import { digest } from "../harness/digest.js";

export const PERFORMANCE_DATASET="v5-probe-performance-v1";
export const performanceProfile={origins:8,variantsPerPlan:2,responseDelayMs:40,pairs:6,baselineConcurrency:1,optimizedConcurrency:4,warmupsPerMode:1};
export const responseSchema={type:"object",properties:{status:{type:"number"},message:{type:"string"}},required:["status","message"]};
export function performancePlan(id:string,endpoint:string):ProbePlan{return {id,tenantId:"benchmark-team",endpoint,method:"POST",sideEffectFree:true,parallelSafe:true,snapshotConsistent:true,enabled:true,intervalMs:100,nextAt:0,revision:0,risk:"low",latencyLimitMs:5000,expectedResponse:responseSchema,variants:validationVariants({amount:42},{type:"object",properties:{amount:{type:"number"}},required:["amount"]})};}
export async function performanceFixtures(count=performanceProfile.origins,responseDelayMs=performanceProfile.responseDelayMs,onRequestStart?:(index:number,activeOrigins:number[])=>void){
  let active=0,peak=0,requests=0;const perOrigin=Array<number>(count).fill(0),peakPerOrigin=Array<number>(count).fill(0);
  const servers=Array.from({length:count},(_,index)=>createServer(async(q,r)=>{
    let raw="";for await(const chunk of q){raw+=String(chunk);if(raw.length>8192){r.writeHead(413).end('{}');return;}}
    let body:unknown;try{body=JSON.parse(raw);}catch{body=null;}
    requests++;active++;peak=Math.max(peak,active);perOrigin[index]!++;peakPerOrigin[index]=Math.max(peakPerOrigin[index]!,perOrigin[index]!);
    onRequestStart?.(index,perOrigin.flatMap((n,i)=>n?[i]:[]));
    try{await delay(responseDelayMs);const status=q.url!=="/orders"?404:q.method!=="POST"?405:q.headers["content-type"]!=="application/json"?415:typeof(body as {amount?:unknown})?.amount!=="number"?400:200;
      r.writeHead(status,{"Content-Type":"application/json"});r.end(JSON.stringify({status,message:status===200?"Validated only; no write":"Invalid request"}));
    }finally{active--;perOrigin[index]!--;}
  }));
  await Promise.all(servers.map(s=>new Promise<void>(done=>s.listen(0,"127.0.0.1",done))));
  return {endpoints:servers.map(s=>`http://127.0.0.1:${(s.address() as {port:number}).port}/orders`),stats:()=>({requests,peakConcurrentRequests:peak,peakPerOrigin:[...peakPerOrigin]}),reset:()=>{if(active)throw new Error("FIXTURE_STILL_ACTIVE");requests=0;peak=0;peakPerOrigin.fill(0);},close:async()=>{await Promise.all(servers.map(async s=>{s.closeAllConnections();await new Promise<void>(done=>s.close(()=>done()));}));}};
}
export function percentile(values:number[],p:number):number|null{if(!values.length)return null;const sorted=[...values].sort((a,b)=>a-b);return sorted[Math.max(0,Math.ceil(sorted.length*p)-1)]!;}
async function wave(directory:string,fixture:Awaited<ReturnType<typeof performanceFixtures>>,concurrency:number,label:string){
  const store=new ReliabilityStore(join(directory,`${label}.json`)),scheduler=new ProbeScheduler(store,undefined,concurrency);let modelRequests=0;
  for(const [i,url] of fixture.endpoints.entries())await scheduler.register(performancePlan(`plan-${i}`,url));fixture.reset();
  const start=performance.now(),observations=await scheduler.tick(0),router=new AnomalyRouter(store);
  for(const o of observations)await router.route(o);
  await new ReliabilityWorker(store,async()=>{modelRequests++;throw new Error("UNEXPECTED_HEALTHY_MODEL_CALL");}).work();
  const batchMs=performance.now()-start,state=await store.load(),stats=fixture.stats(),projection=observations.map(o=>({planId:o.planId,variantId:o.variantId,status:o.status,expectedStatus:o.expectedStatus,body:o.body,schemaIssues:o.schemaIssues,healthy:o.healthy}));
  const errorCount=observations.filter(o=>!o.healthy).length,passed=observations.length===performanceProfile.origins*performanceProfile.variantsPerPlan&&stats.requests===observations.length&&errorCount===0&&modelRequests===0&&Object.keys(state.jobs).length===0&&stats.peakConcurrentRequests<=concurrency&&stats.peakPerOrigin.every(v=>v<=1);
  return {concurrency,batchMs,probes:observations.length,throughputPerSecond:observations.length*1000/batchMs,requestMs:observations.map(o=>o.durationMs),requestP50Ms:percentile(observations.map(o=>o.durationMs),.5),requestP95Ms:percentile(observations.map(o=>o.durationMs),.95),errorCount,modelRequests,semanticDigest:digest(projection),...stats,passed};
}
export async function runPerformanceEvaluation(outputDirectory?:string,responseDelayMs=performanceProfile.responseDelayMs){
  if(![0,40].includes(responseDelayMs))throw new Error("UNREGISTERED_PERFORMANCE_PROFILE");
  const profile={...performanceProfile,responseDelayMs},dir=outputDirectory??await mkdtemp(join(tmpdir(),"a-pidoc-performance-")),fixture=await performanceFixtures(profile.origins,responseDelayMs);
  try{
    for(const concurrency of [1,4])await wave(dir,fixture,concurrency,`warmup-${concurrency}`);
    const results:Array<{pair:number;order:number[];baseline:Awaited<ReturnType<typeof wave>>;optimized:Awaited<ReturnType<typeof wave>>;equivalent:boolean;speedup:number;passed:boolean}>=[];
    for(let pair=1;pair<=performanceProfile.pairs;pair++){
      const order=pair%2?[1,4]:[4,1],rows=[];for(const concurrency of order)rows.push(await wave(dir,fixture,concurrency,`pair-${pair}-${concurrency}`));
      const baseline=rows.find(r=>r.concurrency===1)!,optimized=rows.find(r=>r.concurrency===4)!,equivalent=baseline.semanticDigest===optimized.semanticDigest;
      results.push({pair,order,baseline,optimized,equivalent,speedup:baseline.batchMs/optimized.batchMs,passed:equivalent&&baseline.passed&&optimized.passed});
    }
    const summary=(variant:"baseline"|"optimized")=>{const rows=results.map(r=>r[variant]);return {batchP50Ms:percentile(rows.map(r=>r.batchMs),.5)!,batchP95Ms:percentile(rows.map(r=>r.batchMs),.95)!,medianThroughputPerSecond:percentile(rows.map(r=>r.throughputPerSecond),.5)!,requestP50Ms:percentile(rows.flatMap(r=>r.requestMs),.5),requestP95Ms:percentile(rows.flatMap(r=>r.requestMs),.95),totalProbes:rows.reduce((n,r)=>n+r.probes,0),errorCount:rows.reduce((n,r)=>n+r.errorCount,0),modelRequests:rows.reduce((n,r)=>n+r.modelRequests,0)};};
    const baseline=summary("baseline"),optimized=summary("optimized"),gains={medianPairedSpeedup:percentile(results.map(r=>r.speedup),.5),batchMedianReductionPercent:100*(1-optimized.batchP50Ms/baseline.batchP50Ms),medianThroughputIncreasePercent:100*(optimized.medianThroughputPerSecond/baseline.medianThroughputPerSecond-1)};
    return {dataset:PERFORMANCE_DATASET,profile,datasetDigest:digest({profile,responseSchema,body:{amount:42}}),environment:{node:process.version,platform:platform(),osRelease:release(),arch:arch(),cpuModel:cpus()[0]?.model??"unknown",logicalCpus:cpus().length},liveHttp:true,liveModel:false,scope:"owned loopback validation services, durable JSON, router and empty worker; no production or paid-model improvement claim",warmupsExcluded:true,percentileMethod:"nearest-rank; batch P95 has six samples and is descriptive",baseline,optimized,gains,improvementObserved:optimized.batchP50Ms<baseline.batchP50Ms,passed:results.every(r=>r.passed),results};
  }finally{await fixture.close();if(!outputDirectory){const rel=relative(resolve(tmpdir()),resolve(dir));if(!rel.startsWith("a-pidoc-performance-")||rel.includes(sep)||isAbsolute(rel))throw new Error("UNTRUSTED_BENCHMARK_CLEANUP");await rm(dir,{recursive:true,force:true});}}
}
