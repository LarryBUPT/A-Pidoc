import { randomUUID } from "node:crypto";
import { digest } from "../harness/digest.js";
import { assertSupportedSchema, validateSchema } from "../input/json-schema.js";
import { redactValue } from "../security/redaction.js";
import type { ProbePlan, ProbeObservation, ProbeVariant } from "./contracts.js";
import { ReliabilityStore } from "./store.js";
export function validationVariants(body:Record<string,unknown>,schema:Record<string,unknown>):ProbeVariant[]{
  assertSupportedSchema(schema);if(validateSchema(body,schema).length)throw new Error("INVALID_VALIDATION_BASELINE");
  const result:ProbeVariant[]=[{id:"valid",headers:{"Content-Type":"application/json"},body,expectedStatus:200}];
  for(const name of (schema.required as string[]|undefined)??[]){const bad={...body};delete bad[name];result.push({id:`missing-${name}`,headers:{"Content-Type":"application/json"},body:bad,expectedStatus:400});if(result.length===8)break;}
  return result;
}
export function validatePlan(p:ProbePlan):void{
  const u=new URL(p.endpoint);
  if(!/^[a-zA-Z0-9_-]{1,80}$/.test(p.id)||!p.tenantId||p.tenantId.length>80||u.hostname!=="127.0.0.1"||u.protocol!=="http:"||u.username||u.password||u.search||u.hash||!p.sideEffectFree||!(p.method==="POST"&&u.pathname==="/orders"||p.method==="GET"&&u.pathname==="/health"))throw new Error("UNREGISTERED_READ_ONLY_PROBE");
  if(p.sideEffectFree!==true||typeof p.enabled!=="boolean"||!["low","high"].includes(p.risk)||!Number.isSafeInteger(p.intervalMs)||p.intervalMs<10||p.intervalMs>86_400_000||!Number.isSafeInteger(p.nextAt)||p.nextAt<0||!Number.isSafeInteger(p.revision)||p.revision<0||!Number.isFinite(p.latencyLimitMs)||p.latencyLimitMs<1||p.variants.length<1||p.variants.length>8)throw new Error("INVALID_PROBE_PLAN");
  assertSupportedSchema(p.expectedResponse);
  for(const flag of [p.parallelSafe,p.snapshotConsistent])if(flag!==undefined&&typeof flag!=="boolean")throw new Error("INVALID_PROBE_PLAN");
  if(Buffer.byteLength(JSON.stringify(p))>16_384||JSON.stringify(redactValue(p))!==JSON.stringify(p)||new Set(p.variants.map(v=>v.id)).size!==p.variants.length)throw new Error("UNSAFE_PROBE_PLAN");
  for(const v of p.variants)if(!/^[\w-]{1,80}$/.test(v.id)||!Number.isInteger(v.expectedStatus)||v.expectedStatus<100||v.expectedStatus>599||p.method==="GET"&&v.body!==null||Object.keys(v.headers).some(k=>k.toLowerCase()!=="content-type"))throw new Error("INVALID_PROBE_VARIANT");
}
export class ProbeRunner {
  constructor(readonly timeoutMs=5000){if(timeoutMs<1||timeoutMs>30_000)throw new Error("INVALID_PROBE_TIMEOUT");}
  async execute(plan:ProbePlan,variant:ProbeVariant,scheduledAt:number,signal?:AbortSignal):Promise<ProbeObservation>{
    validatePlan(plan);if(!plan.variants.some(v=>digest(v)===digest(variant)))throw new Error("UNREGISTERED_PROBE_VARIANT");const started=performance.now();let status=0,body:unknown=null,contractDigest:string|undefined,networkError:string|undefined;
    try{
      const response=await fetch(plan.endpoint,{method:plan.method,headers:variant.headers,...(variant.body===null?{}:{body:JSON.stringify(variant.body)}),signal:signal?AbortSignal.any([signal,AbortSignal.timeout(this.timeoutMs)]):AbortSignal.timeout(this.timeoutMs),redirect:"error"});status=response.status;
      contractDigest=response.headers.get("x-contract-digest")??undefined;
      const reader=response.body?.getReader();let data="",bytes=0;const decoder=new TextDecoder();
      if(reader)try{while(true){const r=await reader.read();if(r.done)break;bytes+=r.value.byteLength;if(bytes>8192)throw new Error("PROBE_RESPONSE_TOO_LARGE");data+=decoder.decode(r.value,{stream:true});}data+=decoder.decode();}finally{await reader.cancel().catch(()=>undefined);}
      try{body=JSON.parse(data);}catch{networkError="INVALID_JSON_RESPONSE";}
    }catch(e){networkError=e instanceof Error&&e.name==="TimeoutError"?"PROBE_TIMEOUT":signal?.aborted?"PROBE_CANCELLED":"PROBE_NETWORK_OR_OUTPUT_ERROR";}
    const schemaIssues=variant.expectedStatus>=200&&variant.expectedStatus<300?validateSchema(body,plan.expectedResponse).map(i=>`${i.path}: ${i.message}`).slice(0,24):[];
    const durationMs=Math.round(performance.now()-started);
    return {id:randomUUID(),planId:plan.id,tenantId:plan.tenantId,variantId:variant.id,scheduledAt,observedAt:Date.now(),status,expectedStatus:variant.expectedStatus,durationMs,request:{url:plan.endpoint,method:plan.method,headers:variant.headers,body:variant.body},body:redactValue(body),schemaIssues,...(contractDigest?{contractDigest}:{}),...(networkError?{networkError}:{}),healthy:!networkError&&status===variant.expectedStatus&&!schemaIssues.length&&durationMs<=plan.latencyLimitMs&&(!plan.expectedContractDigest||contractDigest===plan.expectedContractDigest)};
  }
}
// Persist dispatch intent before I/O. An interrupted slot is an explicit gap,
// never silently replayed. The next slot continues without a catch-up flood.
export class ProbeScheduler {
  private tickTail:Promise<unknown>=Promise.resolve();
  constructor(readonly store:ReliabilityStore,readonly runner=new ProbeRunner(),readonly maxConcurrentOrigins=1){if(!Number.isInteger(maxConcurrentOrigins)||maxConcurrentOrigins<1||maxConcurrentOrigins>4)throw new Error("INVALID_PROBE_CONCURRENCY");}
  async register(p:ProbePlan){validatePlan(p);await this.store.update(s=>{if(Object.keys(s.plans).length>=32&&!s.plans[p.id])throw new Error("PLAN_CAPACITY");if(s.plans[p.id])throw new Error("PLAN_ALREADY_REGISTERED");s.plans[p.id]=structuredClone(p);});}
  async setEnabled(id:string,enabled:boolean,now=Date.now()){await this.store.update(s=>{const p=s.plans[id];if(!p)throw new Error("UNKNOWN_PLAN");p.enabled=enabled;p.revision++;if(enabled)p.nextAt=now;});}
  tick(now=Date.now(),signal?:AbortSignal):Promise<ProbeObservation[]>{
    const next=this.tickTail.then(()=>this.tickOnce(now,signal));this.tickTail=next.catch(()=>undefined);return next;
  }
  private async tickOnce(now:number,signal?:AbortSignal):Promise<ProbeObservation[]>{
    if(signal?.aborted)return[];
    const due=await this.store.update(s=>Object.values(s.plans).filter(p=>p.enabled&&p.nextAt<=now).flatMap(p=>{const slot=p.nextAt;if((s.lastSlots[p.id]??-1)>=slot)return[];s.lastSlots[p.id]=slot;p.nextAt=now+p.intervalMs;return [{plan:structuredClone(p),slot}];}));
    // One origin owns one slot in this pool, even across tenants/plans/paths.
    // Model tools and mutations remain on the original sequential Harness.
    type Dispatch={index:number;plan:ProbePlan;slot:number};
    const segments:Dispatch[][]=[];let pending:Dispatch[]=[];
    due.forEach((d,index)=>{const item={...d,index};if(this.maxConcurrentOrigins>1&&d.plan.parallelSafe===true&&d.plan.snapshotConsistent===true)pending.push(item);else{if(pending.length)segments.push(pending);pending=[];segments.push([item]);}});if(pending.length)segments.push(pending);
    const rows:ProbeObservation[][]=due.map(()=>[]),controller=new AbortController(),poolSignal=signal?AbortSignal.any([signal,controller.signal]):controller.signal;
    // Undeclared plans are exclusive barriers; default one retains I/O order.
    for(const segment of segments){if(poolSignal.aborted)break;
    const groups=new Map<string,Dispatch[]>();for(const item of segment){const key=new URL(item.plan.endpoint).origin,group=groups.get(key)??[];group.push(item);groups.set(key,group);}
    const queue=[...groups.values()];let cursor=0;
    const workers=Array.from({length:Math.min(this.maxConcurrentOrigins,queue.length)},async()=>{
      try{while(!poolSignal.aborted){const group=queue[cursor++];if(!group)break;
        for(const d of group)for(const variant of d.plan.variants){if(poolSignal.aborted)break;const p=(await this.store.load()).plans[d.plan.id];if(!p?.enabled||p.revision!==d.plan.revision)break;
          const o=await this.runner.execute(d.plan,variant,d.slot,poolSignal);await this.store.update(s=>{s.probes.push(o);s.probes=s.probes.slice(-512);});rows[d.index]!.push(o);
        }
      }}catch(error){controller.abort();throw error;}
    });
    const settled=await Promise.allSettled(workers),failure=settled.find((v):v is PromiseRejectedResult=>v.status==="rejected");if(failure)throw failure.reason;
    }
    // Return registration/variant order; persistence records completion order.
    return rows.flat();
  }
}
export function probeMetrics(observations:ProbeObservation[]){
  const all=observations.slice(-100),valid=all.filter(o=>o.expectedStatus>=200&&o.expectedStatus<300),times=valid.map(o=>o.durationMs).sort((a,b)=>a-b),mid=Math.floor(valid.length/2);
  const mean=(rows:ProbeObservation[])=>rows.length?rows.reduce((n,r)=>n+r.durationMs,0)/rows.length:null;
  return {samples:all.length,assertionPassRate:all.length?all.filter(o=>o.healthy).length/all.length:null,availability:valid.length?valid.filter(o=>o.status>=200&&o.status<300&&!o.networkError).length/valid.length:null,errorRate:valid.length?valid.filter(o=>o.status>=400||o.networkError).length/valid.length:null,rateLimitRate:valid.length?valid.filter(o=>o.status===429).length/valid.length:null,p95Ms:times.length?times[Math.ceil(times.length*.95)-1]:null,latencyTrend:valid.length>=4?{previousMeanMs:mean(valid.slice(0,mid)),recentMeanMs:mean(valid.slice(mid))}:null,slo:{targetAvailability:.99,targetP95Ms:1000,scope:"local rolling 100 observations, not production SLO"}};
}
