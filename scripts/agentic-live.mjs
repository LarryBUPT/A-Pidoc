import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { randomUUID } from "node:crypto";
import { getModels, streamSimple } from "@earendil-works/pi-ai/compat";
import { ApiHarnessRuntime, LEAD_PROMPT } from "../dist/src/api-harness/runtime.js";
import { RepositoryContractBackend, RuntimeApiBackend, createDiagnosticSandbox } from "../dist/src/api-harness/tool-bundles.js";
import { TrajectoryStore } from "../dist/src/harness/trajectory-store.js";
import { digest } from "../dist/src/harness/digest.js";
import { runMetrics } from "../dist/src/evaluation/agentic-eval.js";
import { safeHarnessError } from "../dist/src/api-harness/cli.js";
import { artifactGeneratedAt } from "../dist/src/evaluation/artifact.js";
const provider=process.env.A_PIDOC_PI_PROVIDER??"deepseek",modelId=process.env.A_PIDOC_PI_MODEL??"deepseek-v4-pro";
const apiKey=process.env.A_PIDOC_PI_API_KEY??process.env.DEEPSEEK_API_KEY;
const model=getModels(provider).find(m=>m.id===modelId),dir=resolve(process.argv[2]??`.private/live-v45/${randomUUID()}`);
if(!model||!apiKey)throw new Error("Live release eval requires the configured model/private key; no fallback");
await mkdir(dir,{recursive:true});const results=[];
for(const family of ["runtime-api","repository-contract"]) {
  const sandbox=family==="runtime-api"?await createDiagnosticSandbox():undefined;
  try {
    const store=new TrajectoryStore(join(dir,`${family}.json`)),source=resolve("test/fixtures/repository-v3-migration");
    const backend=sandbox?new RuntimeApiBackend(sandbox.endpoint):new RepositoryContractBackend(store,source,join(dir,"isolated-workspace"),JSON.parse(await readFile(join(source,"old.json"),"utf8")),JSON.parse(await readFile(join(source,"new.json"),"utf8")));
    const runtime=new ApiHarnessRuntime(store,backend,{hosts:sandbox?["127.0.0.1"]:[],ports:sandbox?[Number(new URL(sandbox.endpoint).port)]:[],environments:["sandbox"],credentialScopes:[]},{model,streamFn:streamSimple,apiKey},i=>i.actorId==="local-release-evaluator"&&i.source==="authorized-isolated-test");
    const task={id:randomUUID(),goal:sandbox?`Investigate the failing POST ${sandbox.endpoint} request with Content-Type text/plain and amount 42. Determine the cause and validate a corrected request using actual HTTP evidence.`:"Complete a supported isolated migration for the registered previous/next contract and client, then verify it with actual regression tests. Investigate the real diff/impact first; request approval by submitting the intended isolated tool call, STOP_AND_WAIT on APPROVAL_REQUIRED, and reissue exactly after approval. Cite actual diff/patch/test evidence.",taskFamily:family,environment:"sandbox",inputArtifacts:[],allowedToolBundles:[family,"shared"],risk:sandbox?"low":"high",budget:{maxModelCalls:20,maxToolCalls:40,maxTokens:80000,maxCostUsd:1,maxDurationMs:180000}};
    let s=await runtime.start(task),approvals=0;
    // User-authorized release testing is reversible and restricted to these two registered isolated tools.
    while(s.run.state==="waiting_approval"&&s.pendingApproval?.status==="pending"&&approvals<2) {
      if(!["apply_patch_isolated","run_regression_tests"].includes(s.pendingApproval.toolName))throw new Error("Unexpected live approval action");
      await runtime.guardrail.grant(s.pendingApproval.approvalId,{actorId:"local-release-evaluator",source:"authorized-isolated-test"});approvals++;s=await runtime.resume();
    }
    const toolHash=digest(runtime.registry.toPiTools(task).map(t=>({name:t.name,description:t.description,parameters:t.parameters})));
    results.push({family,provider,model:modelId,promptHash:digest(LEAD_PROMPT),toolHash,dataset:"agentic-live-v1",repetitions:1,approvals,...runMetrics(s),finalArtifact:s.run.finalArtifact??null,trajectory:s.run.steps});
    console.log(JSON.stringify({family,state:s.run.state,approvals,usage:s.run.usage,elapsedMs:s.elapsedMs}));
  }catch(error){results.push({family,provider,model:modelId,state:"failed",error:safeHarnessError(error)});console.error(safeHarnessError(error));}
  finally{await sandbox?.close();}
}
const passed=results.length===2&&results.every(r=>r.state==="resolved")&&results.find(r=>r.family==="repository-contract")?.approvals===2;
const report={generatedAt:artifactGeneratedAt(),passed,provider,model:modelId,dataset:"agentic-live-v1",results};await writeFile(join(dir,"report.json"),JSON.stringify(report,null,2),{mode:0o600});
console.log(JSON.stringify({passed,report:join(dir,"report.json")}));if(!passed)process.exitCode=1;
