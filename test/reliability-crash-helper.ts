import { registerFauxProvider,streamSimple } from "@earendil-works/pi-ai/compat";
import { fauxAssistantMessage,fauxToolCall } from "@earendil-works/pi-ai";
import { ReliabilityStore } from "../src/reliability/store.js";
import { ReliabilityWorker } from "../src/reliability/worker.js";
import { RuntimeApiBackend } from "../src/api-harness/tool-bundles.js";
import { TrajectoryStore } from "../src/harness/trajectory-store.js";
import { defaultRouting } from "../src/reliability/router.js";
const store=new ReliabilityStore(process.argv[2]!),provider=registerFauxProvider({provider:"v5-crash-child",models:[{id:"lead",input:["text"]}]});let seq=0;
const decision=(context:any)=>{
  const rows=context.messages.filter((m:any)=>m.role==="toolResult"&&m.details?.success).flatMap((m:any)=>m.details.evidence.map((ref:any)=>({ref,data:m.details.data})));
  for(const m of context.messages)if(m.role==="user"&&typeof m.content==="string")try{const board=JSON.parse(m.content.replace(/^API WORKSPACE BOARD\n/,""));for(const e of board.evidence??[])if(e.valid&&e.observation)rows.push({ref:{id:e.id,kind:e.kind},data:JSON.parse(e.observation)});}catch{}
  if(rows.some((a:any)=>a.ref.kind==="publication_receipt"))process.exit(73); // Hard interruption after a durably confirmed side effect.
  const monitor=rows.find((a:any)=>a.ref.kind==="monitoring_observation");
  return fauxAssistantMessage(fauxToolCall(monitor?"publish_report":"read_monitoring_evidence",monitor?{message:"Local diagnostic draft before worker interruption",evidenceIds:[monitor.ref.id]}:{},{id:`child-${++seq}`}));
};provider.setResponses(Array.from({length:20},()=>decision));
const worker=new ReliabilityWorker(store,async(job,_run,signal)=>{
  const s=await store.load(),p=s.plans[s.incidents[job.incidentId]!.planId]!;
  return {backend:new RuntimeApiBackend(p.endpoint),policy:{hosts:["127.0.0.1"],ports:[Number(new URL(p.endpoint).port)],environments:["sandbox"],credentialScopes:[]},options:{model:provider.getModel(),streamFn:streamSimple,signal},authorizeApproval:i=>i.actorId==="owner"&&i.tenantId===p.tenantId};
},defaultRouting,30_000,i=>i.actorId==="owner");
let j=(await worker.work())!;if(j.state!=="waiting_approval")throw new Error(`Child expected an approval boundary: ${j.state} ${j.handoff?.reason}`);
const snapshot=await new TrajectoryStore(j.runFile).load();await worker.grantApproval(j.id,snapshot.pendingApproval!.approvalId,{actorId:"owner",source:"test-owner",tenantId:j.task.tenantId!});await worker.requeueApproved(j.id,{actorId:"owner",source:"test-owner",confirmedWorkerStopped:true});await worker.work();throw new Error("Child should have interrupted before this point");
