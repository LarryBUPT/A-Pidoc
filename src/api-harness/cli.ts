import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { userInfo } from "node:os";
import { randomUUID } from "node:crypto";
import { getModels, streamSimple } from "@earendil-works/pi-ai/compat";
import { TrajectoryStore } from "../harness/trajectory-store.js";
import { ApiHarnessRuntime } from "./runtime.js";
import { RepositoryContractBackend, RuntimeApiBackend, createDiagnosticSandbox } from "./tool-bundles.js";
import type { AgentTask } from "../harness/contracts.js";
import { redactText } from "../security/redaction.js";

// CLI identity comes from the local OS session. Remote hosts must supply their own authenticated authorizer.
export async function runHarnessCommand(mode:string,options:Map<string,string>):Promise<void> {
  const file=options.get("run");if(!file)throw new Error("--run snapshot path is required");
  const store=new TrajectoryStore(resolve(file)),profile=mode==="agent-run"?options.get("profile"):(await store.load()).run.task.taskFamily;
  if(!["runtime-api","repository-contract"].includes(profile??""))throw new Error("--profile must be runtime-api or repository-contract");
  if(profile==="runtime-api"&&mode!=="agent-run")throw new Error("Runtime sandbox is ephemeral; start a new diagnosis. No HTTP side effect is authorized by this demo.");
  const provider=process.env.A_PIDOC_PI_PROVIDER??"deepseek",modelId=process.env.A_PIDOC_PI_MODEL??"deepseek-v4-pro";
  const model=getModels(provider as Parameters<typeof getModels>[0]).find(m=>m.id===modelId);
  const apiKey=process.env.A_PIDOC_PI_API_KEY??process.env.DEEPSEEK_API_KEY;
  if(!model||!apiKey)throw new Error("Harness CLI requires a configured model and a private provider key; no fallback is used");
  const sandbox=profile==="runtime-api"?await createDiagnosticSandbox():undefined;
  try {
    const source=resolve("test/fixtures/repository-v3-migration");
    const previous=profile==="repository-contract"?JSON.parse(await readFile(join(source,"old.json"),"utf8")):null;
    const next=profile==="repository-contract"?JSON.parse(await readFile(join(source,"new.json"),"utf8")):null;
    const backend=sandbox?new RuntimeApiBackend(sandbox.endpoint):new RepositoryContractBackend(store,source,`${store.file}.workspace`,previous,next);
    const actor=userInfo().username;
    const runtime=new ApiHarnessRuntime(store,backend,{hosts:sandbox?["127.0.0.1"]:[],ports:sandbox?[Number(new URL(sandbox.endpoint).port)]:[],environments:["sandbox"],credentialScopes:[]},{model,streamFn:streamSimple,apiKey},i=>i.actorId===actor&&i.source==="local-os-cli");
    let s;
    if(mode==="agent-run") {
      const task:AgentTask={id:randomUUID(),goal:sandbox?`Investigate the failing POST ${sandbox.endpoint} request with Content-Type text/plain and amount 42. Determine the cause and validate a corrected request with actual HTTP evidence.`:"Assess the registered previous/next contract change and client compatibility. If a supported safe migration exists, propose it, wait for approval before isolated changes, and verify with actual regression tests.",taskFamily:profile!,environment:"sandbox",inputArtifacts:[],allowedToolBundles:[profile!,"shared"],risk:sandbox?"low":"high",budget:{maxModelCalls:20,maxToolCalls:40,maxTokens:80_000,maxCostUsd:1,maxDurationMs:180_000}};
      s=await runtime.start(task);
    } else if(mode==="agent-approve") {
      const approvalId=options.get("approval");if(!approvalId)throw new Error("--approval exact pending ID is required");
      await runtime.guardrail.grant(approvalId,{actorId:actor,source:"local-os-cli"});s=await runtime.resume();
    } else s=await runtime.resume();
    const report={runId:s.run.runId,state:s.run.state,provider,model:modelId,usage:s.run.usage,elapsedMs:s.elapsedMs,pending:s.pendingApproval?.status==="pending"?{approvalId:s.pendingApproval.approvalId,toolName:s.pendingApproval.toolName,args:s.approvedArgs}:null,finalArtifact:s.run.finalArtifact??null};
    await mkdir(dirname(store.file),{recursive:true});await writeFile(`${store.file}.report.json`,JSON.stringify(report,null,2),{mode:0o600});console.log(JSON.stringify(report,null,2));
    if(["blocked","failed","unresolved"].includes(s.run.state))process.exitCode=1;
  } finally {await sandbox?.close();}
}
export function safeHarnessError(error:unknown):string {
  let text=String(error instanceof Error?error.message:error);
  for(const key of [process.env.A_PIDOC_PI_API_KEY,process.env.DEEPSEEK_API_KEY])if(key)text=text.replaceAll(key,"[REDACTED]");
  return redactText(text);
}
