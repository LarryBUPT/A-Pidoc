import { readFile } from "node:fs/promises";
import { userInfo } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { getModels, streamSimple } from "@earendil-works/pi-ai/compat";
import { monitoringRuntimeBackend } from "./backend.js";
import { ReliabilityStore } from "./store.js";
import { ProbeScheduler, probeMetrics } from "./probes.js";
import { AnomalyRouter, defaultRouting } from "./router.js";
import { ReliabilityWorker } from "./worker.js";
import type { ProbePlan } from "./contracts.js";
export async function runReliabilityCommand(mode:string,options:Map<string,string>){
  const file=options.get("state");if(!file)throw new Error("--state private JSON path is required");const store=new ReliabilityStore(file),scheduler=new ProbeScheduler(store,undefined,Number(options.get("probe-concurrency")??1)),actor=userInfo().username;
  const provider=process.env.A_PIDOC_PI_PROVIDER??"deepseek",modelId=process.env.A_PIDOC_PI_MODEL??"deepseek-v4-pro",smallId=process.env.A_PIDOC_PI_SMALL_MODEL;
  const config={...defaultRouting,smallModelConfigured:!!smallId};
  const worker=new ReliabilityWorker(store,async(job,_run,signal)=>{
    const key=process.env.A_PIDOC_PI_API_KEY??process.env.DEEPSEEK_API_KEY,chosen=job.modelRoute==="small"?smallId:modelId,model=getModels(provider as Parameters<typeof getModels>[0]).find(m=>m.id===chosen);
    if(!key||!model)throw new Error("Configured real model/private key is required for escalated work; no fallback");
    const state=await store.load(),incident=state.incidents[job.incidentId],plan=incident?state.plans[incident.planId]:undefined;if(!plan)throw new Error("UNKNOWN_PLAN");
    return {backend:monitoringRuntimeBackend(plan),policy:{hosts:["127.0.0.1"],ports:[Number(new URL(plan.endpoint).port)],environments:["sandbox"],credentialScopes:[]},options:{model,streamFn:streamSimple,apiKey:key,signal},authorizeApproval:i=>i.actorId===actor&&i.source==="local-os-cli"&&i.tenantId===plan.tenantId};
  },config,180_000,i=>i.actorId===actor&&i.source==="local-os-cli");
  const required=(name:string)=>{const v=options.get(name);if(!v)throw new Error(`--${name} is required`);return v;};
  if(mode==="reliability-register"){const plan=JSON.parse(await readFile(required("plan"),"utf8")) as ProbePlan;await scheduler.register(plan);}
  else if(mode==="reliability-enable"||mode==="reliability-disable")await scheduler.setEnabled(required("plan-id"),mode==="reliability-enable");
  else if(mode==="reliability-cancel")await worker.cancel(required("job"));
  else if(mode==="reliability-recover"){if(options.get("confirm-stopped")!=="true")throw new Error("Inspect old worker process and use --confirm-stopped true before recovery");await worker.recover(required("job"),{actorId:actor,source:"local-os-cli",confirmedWorkerStopped:true});}
  else if(mode==="reliability-approve"){const id=required("job"),job=(await store.load()).jobs[id];if(!job)throw new Error("UNKNOWN_JOB");await worker.grantApproval(id,required("approval"),{actorId:actor,source:"local-os-cli",...(job.task.tenantId?{tenantId:job.task.tenantId}:{})});await worker.requeueApproved(id,{actorId:actor,source:"local-os-cli",confirmedWorkerStopped:true});}
  else if(mode==="reliability-tick"||mode==="reliability-watch"){
    const ticks=mode==="reliability-watch"?Number(options.get("ticks")??100):1,interval=Number(options.get("interval-ms")??1000);if(!Number.isInteger(ticks)||ticks<1||ticks>10_000||!Number.isInteger(interval)||interval<10||interval>60_000)throw new Error("Invalid watch bounds");
    const controller=new AbortController(),stop=()=>{controller.abort();void store.load().then(s=>Promise.all(Object.values(s.jobs).filter(j=>j.state==="running"&&j.workerId===worker.id).map(j=>worker.cancel(j.id)))).catch(()=>{process.exitCode=1;});};
    process.once("SIGINT",stop);process.once("SIGTERM",stop);
    try{for(let n=0;n<ticks&&!controller.signal.aborted;n++){for(const o of await scheduler.tick(Date.now(),controller.signal))await new AnomalyRouter(store,config).route(o);await Promise.all(Array.from({length:config.maxConcurrent},()=>worker.work()));if(n+1<ticks&&!controller.signal.aborted)await delay(interval,undefined,{signal:controller.signal}).catch(()=>undefined);}}
    finally{process.removeListener("SIGINT",stop);process.removeListener("SIGTERM",stop);}
  }
  else if(mode!=="reliability-status")throw new Error("Unknown reliability command");
  const state=await store.load();console.log(JSON.stringify({revision:state.revision,metrics:probeMetrics(state.probes),plans:Object.values(state.plans).map(p=>({id:p.id,enabled:p.enabled,nextAt:p.nextAt})),incidents:Object.values(state.incidents),jobs:Object.values(state.jobs).map(j=>({id:j.id,state:j.state,route:j.modelRoute,waitMs:j.waitMs,usage:j.usage,handoff:j.handoff,runFile:j.runFile}))},null,2));
}
