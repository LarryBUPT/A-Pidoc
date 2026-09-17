import type { AgentTask, RunUsage } from "../harness/contracts.js";
export interface ProbeVariant { id:string; headers:Record<string,string>; body:unknown; expectedStatus:number }
export interface ProbePlan {
  id:string; tenantId:string; endpoint:string; method:"GET"|"POST"; sideEffectFree:true;
  parallelSafe?:boolean; snapshotConsistent?:boolean;
  intervalMs:number; enabled:boolean; nextAt:number; revision:number;
  expectedResponse:Record<string,unknown>; variants:ProbeVariant[]; latencyLimitMs:number;
  expectedContractDigest?:string; risk:"low"|"high";
}
export interface ProbeObservation {
  id:string; planId:string; tenantId:string; scheduledAt:number; observedAt:number; variantId:string;
  status:number; expectedStatus:number; durationMs:number; body:unknown; schemaIssues:string[];
  request?:{url:string;method:string;headers:Record<string,string>;body:unknown};
  contractDigest?:string; networkError?:string; healthy:boolean;
}
export type IncidentKind="schema_drift"|"contract_drift"|"latency"|"rate_limit"|"http_error"|"network_error";
export interface Incident {
  id:string; clusterKey:string; tenantId:string; planId:string; kind:IncidentKind;
  evidenceIds:string[]; occurrences:number; firstAt:number; lastAt:number;
  route:"deterministic"|"small"|"large"|"reviewer"|"manual_handoff";
  reason:string; jobId?:string; status:"open"|"investigating"|"verified"|"manual_handoff";
}
export type JobState="queued"|"running"|"waiting_approval"|"completed"|"cancelled"|"timed_out"|"manual_handoff"|"recovery_required";
export interface ReliabilityJob {
  id:string; key:string; resourceKey:string; incidentId:string; task:AgentTask; modelRoute:"small"|"large"|"reviewer";
  state:JobState; queuedAt:number; startedAt?:number; endedAt?:number; cancelRequested:boolean;
  workerId?:string; runFile:string; resume:boolean; usage?:RunUsage; waitMs?:number; runState?:string;
  requirePublication?:boolean;
  handoff?:{reason:string; compensation:{status:"proposal_only"; action:string; requiresApproval:true}};
}
export interface ReliabilityState {
  formatVersion:1; revision:number; plans:Record<string,ProbePlan>; lastSlots:Record<string,number>;
  probes:ProbeObservation[]; incidents:Record<string,Incident>; jobs:Record<string,ReliabilityJob>; dedup:Record<string,string>;
}
export interface OperatorIdentity { actorId:string; source:"local-os-cli"|"test-owner"; confirmedWorkerStopped:true }
export const initialState=():ReliabilityState=>({formatVersion:1,revision:0,plans:{},lastSlots:{},probes:[],incidents:{},jobs:{},dedup:{}});
