import { mkdir, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { getModels, streamSimple } from "@earendil-works/pi-ai/compat";
import { runReliabilityScenario } from "../dist/src/evaluation/reliability-eval.js";
import { ReliabilityStore } from "../dist/src/reliability/store.js";
import { RuntimeApiBackend } from "../dist/src/api-harness/tool-bundles.js";
import { safeHarnessError } from "../dist/src/api-harness/cli.js";
import { LEAD_PROMPT } from "../dist/src/api-harness/runtime.js";
import { digest } from "../dist/src/harness/digest.js";
const provider=process.env.A_PIDOC_PI_PROVIDER??"deepseek",modelId=process.env.A_PIDOC_PI_MODEL??"deepseek-v4-pro",apiKey=process.env.A_PIDOC_PI_API_KEY??process.env.DEEPSEEK_API_KEY;
const model=getModels(provider).find(m=>m.id===modelId);if(!apiKey||!model)throw new Error("V5 live requires a configured real model/private key; no fallback");
const dir=resolve(process.argv[2]??`.private/live-v5/${Date.now()}`);await mkdir(dir,{recursive:true});
let report;
try{report=await runReliabilityScenario(async(job,_run,signal)=>{
  const state=await new ReliabilityStore(join(dir,"state.json")).load(),incident=state.incidents[job.incidentId],plan=state.plans[incident.planId];
  return {backend:new RuntimeApiBackend(plan.endpoint),policy:{hosts:["127.0.0.1"],ports:[Number(new URL(plan.endpoint).port)],environments:["sandbox"],credentialScopes:[]},options:{model,streamFn:streamSimple,apiKey,signal},authorizeApproval:i=>i.actorId==="scenario-owner"&&i.source==="local-scenario"&&i.tenantId===job.task.tenantId};
},dir);}catch(error){report={passed:false,liveEvidence:true,error:safeHarnessError(error)};}
report={...report,provider,model:modelId,leadPromptHash:digest(LEAD_PROMPT),repetitions:1};
await writeFile(join(dir,"report.json"),JSON.stringify(report,null,2),{mode:0o600});
console.log(JSON.stringify({passed:report.passed,liveEvidence:true,provider,model:modelId,healthyModelRequests:report.healthyModelRequests,taskState:report.task?.state,schemaState:report.schemaTask?.state,reportFile:join(dir,"report.json")},null,2));if(!report.passed)process.exitCode=1;
