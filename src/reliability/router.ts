import { digest } from "../harness/digest.js";
import type { AgentTask } from "../harness/contracts.js";
import { ReliabilityStore } from "./store.js";
import type { Incident, IncidentKind, ProbeObservation, ProbePlan, ReliabilityJob } from "./contracts.js";
import { join } from "node:path";
export interface RoutingConfig { maxPending:number; maxConcurrent:number; smallModelConfigured:boolean; maxTaskCostUsd:number; maxTotalCostUsd?:number }
export const defaultRouting:RoutingConfig={maxPending:16,maxConcurrent:1,smallModelConfigured:false,maxTaskCostUsd:1,maxTotalCostUsd:2};
export function classify(o:ProbeObservation,p:ProbePlan):IncidentKind|undefined{
  if(o.healthy)return undefined;if(o.networkError)return"network_error";
  if(o.status!==o.expectedStatus)return o.status===429?"rate_limit":"http_error";
  if(o.schemaIssues.length)return"schema_drift";if(p.expectedContractDigest!==undefined&&p.expectedContractDigest!==o.contractDigest)return"contract_drift";return"latency";
}
export class AnomalyRouter {
  constructor(readonly store:ReliabilityStore,readonly config:RoutingConfig=defaultRouting){if(!Number.isInteger(config.maxPending)||config.maxPending<1||config.maxPending>128||!Number.isInteger(config.maxConcurrent)||config.maxConcurrent<1||config.maxConcurrent>4||!Number.isFinite(config.maxTaskCostUsd)||config.maxTaskCostUsd<0||config.maxTaskCostUsd>1)throw new Error("INVALID_ROUTING_CONFIG");}
  async route(o:ProbeObservation):Promise<Incident|undefined>{return this.store.update(s=>{
    const p=s.plans[o.planId];if(!p||p.tenantId!==o.tenantId||!s.probes.some(v=>v.id===o.id&&digest(v)===digest(o)))throw new Error("UNVERIFIED_PROBE_OBSERVATION");
    const kind=classify(o,p);if(!kind)return undefined;
    const clusterKey=digest({tenant:p.tenantId,plan:p.id,kind,status:o.status,issues:o.schemaIssues,bucket:Math.floor(o.observedAt/300_000)}),id=`incident-${clusterKey.slice(0,24)}`;
    let incident=s.incidents[id];if(incident){if(!incident.evidenceIds.includes(o.id)){incident.evidenceIds.push(o.id);incident.evidenceIds=incident.evidenceIds.slice(-32);incident.occurrences++;incident.lastAt=o.observedAt;}return incident;}
    const simple=kind==="rate_limit"||kind==="http_error"&&[400,401,403,404,405,415].includes(o.status);
    const conflict=Object.values(s.incidents).some(i=>i.planId===p.id&&i.tenantId===p.tenantId&&["open","investigating"].includes(i.status)&&i.kind!==kind&&o.observedAt-i.lastAt<300_000);
    const route=conflict||this.config.maxTaskCostUsd===0?"manual_handoff":simple?"deterministic":p.risk==="high"?"reviewer":kind==="network_error"&&this.config.smallModelConfigured?"small":"large";
    incident={id,clusterKey,tenantId:p.tenantId,planId:p.id,kind,evidenceIds:[o.id],occurrences:1,firstAt:o.observedAt,lastAt:o.observedAt,route,reason:conflict?"CONFLICTING_OBSERVATIONS":route==="manual_handoff"?"MODEL_BUDGET_UNAVAILABLE":simple?"KNOWN_ANOMALY_ZERO_MODEL":route==="large"&&!this.config.smallModelConfigured?"COMPLEX_OR_SMALL_MODEL_NOT_CONFIGURED":"RISK_AND_COMPLEXITY_ROUTING",status:route==="manual_handoff"?"manual_handoff":"open"};
    s.incidents[id]=incident;
    if(!["deterministic","manual_handoff"].includes(route)){
      const pending=Object.values(s.jobs).filter(j=>["queued","running","waiting_approval","recovery_required"].includes(j.state));
      if(pending.length>=this.config.maxPending){incident.route="manual_handoff";incident.reason="QUEUE_BACKPRESSURE";incident.status="manual_handoff";return incident;}
      const jobId=`job-${clusterKey.slice(0,24)}`,task:AgentTask={id:jobId,goal:`Investigate monitoring incident ${id} for registered ${p.method} ${p.endpoint}. Read actual monitoring evidence and available registered API evidence; distinguish observed anomaly from hypotheses. Historical incident snapshots are immutable and cannot verify recovery. Current API evidence can support a narrow local validation claim; the Worker independently rechecks the original monitoring response contract before marking the incident verified. Do not claim production recovery or infer undocumented response guarantees. An evidence-grounded diagnosis with root cause UNKNOWN is valid if available evidence cannot establish causality; report current request outcomes and remaining uncertainty. Completion does not require changing immutable historical observations or proving production recovery. Avoid rereading unchanged evidence once these bounded claims are supported. ${p.risk==="high"?"Completion includes an approved local diagnostic draft. Obtain its publication receipt before submitting completion; request approval through the intended tool call.":"Publication is not requested; submit only supported API evidence."}`,taskFamily:"runtime-api",tenantId:p.tenantId,environment:"sandbox",risk:p.risk,allowedToolBundles:["runtime-api","shared"],inputArtifacts:[],budget:{maxModelCalls:20,maxToolCalls:40,maxTokens:80_000,maxCostUsd:this.config.maxTaskCostUsd,maxDurationMs:180_000}};
      const job:ReliabilityJob={id:jobId,key:clusterKey,resourceKey:`${p.tenantId}:${p.endpoint}`,incidentId:id,task,modelRoute:route as "small"|"large"|"reviewer",state:"queued",queuedAt:Date.now(),cancelRequested:false,runFile:join(this.store.runRoot,`${jobId}.json`),resume:false,requirePublication:p.risk==="high"};
      if(!s.dedup[clusterKey]){s.jobs[jobId]=job;s.dedup[clusterKey]=jobId;}incident.jobId=s.dedup[clusterKey];
    }
    return incident;
  });}
}
