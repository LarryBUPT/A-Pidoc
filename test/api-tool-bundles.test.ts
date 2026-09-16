import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { harness, task } from "./harness-helpers.js";
import { ApiHarnessRuntime } from "../src/api-harness/runtime.js";
import { createDiagnosticSandbox, RuntimeApiBackend, RepositoryContractBackend, fingerprint } from "../src/api-harness/tool-bundles.js";
import type { EvidencePackage } from "../src/api-harness/contracts.js";
const call=(name:string,args:Record<string,unknown>,id:string)=>fauxAssistantMessage(fauxToolCall(name,args,{id}));
async function migration(t:TestContext) {
  const h=await harness(t,[],[]),source=join(h.dir,"source"),work=join(h.dir,"work");
  await cp(resolve("test/fixtures/repository-v3-migration"),source,{recursive:true});
  const previous=JSON.parse(await readFile(join(source,"old.json"),"utf8")),next=JSON.parse(await readFile(join(source,"new.json"),"utf8"));
  const backend=new RepositoryContractBackend(h.store,source,work,previous,next);
  const runtime=new ApiHarnessRuntime(h.store,backend,{hosts:[],ports:[],environments:["sandbox"],credentialScopes:[]},h.options,i=>i.actorId==="owner"&&i.source==="local-authenticated",async()=>({verdict:"pass",reasons:["Test-only semantic stub; hard Gate remains actual"]}));
  const input={...task(),taskFamily:"repository-contract",allowedToolBundles:["repository-contract","shared"],budget:{...task().budget,maxModelCalls:16}};
  const p:EvidencePackage={claimRefs:[{claim:"Isolated amount literal migrated and generated contract test passed",evidenceIds:["isolated_patch-patch","test_run-tests"]}],httpObservationIds:[],contractDiffId:"contract_diff-diff",patchArtifactId:"isolated_patch-patch",testRunId:"test_run-tests",testExitCode:0};
  return {...h,source,work,backend,runtime,input,p};
}
test("actual loopback HTTP tools reproduce 415 and validate the model-selected corrected request",async t=>{
  const sandbox=await createDiagnosticSandbox();t.after(()=>sandbox.close());
  const h=await harness(t,[],[]),backend=new RuntimeApiBackend(sandbox.endpoint);
  h.provider.setResponses([call("execute_http",{url:sandbox.endpoint,method:"POST",contentType:"text/plain",amount:42},"before"),call("read_api_document",{},"doc"),call("execute_http",{url:sandbox.endpoint,method:"POST",contentType:"application/json",amount:42},"after"),call("submit_completion",{package:{claimRefs:[{claim:"Correct media type yielded HTTP 200",evidenceIds:["api_operation-doc","http_observation-after"]}],httpObservationIds:["http_observation-before","http_observation-after"]}},"finish")]);
  const runtime=new ApiHarnessRuntime(h.store,backend,{hosts:["127.0.0.1"],ports:[Number(new URL(sandbox.endpoint).port)],environments:["sandbox"],credentialScopes:[]},h.options,()=>false,async()=>({verdict:"pass",reasons:["Test-only semantic stub"]}));
  const s=await runtime.start({...task(),taskFamily:"runtime-api",allowedToolBundles:["runtime-api","shared"]});
  assert.equal(s.run.state,"resolved");assert.ok(s.run.finalArtifact);assert.equal(s.run.evidence.length,3);
  assert.equal((s.artifacts["http_observation-before"] as {data:{response:{status:number}}}).data.response.status,415);
});
test("actual contract tools suspend twice, reissue through Pi, execute real Node tests and preserve source",async t=>{
  const h=await migration(t),original=await fingerprint(h.source);
  h.provider.setResponses([call("scan_repository",{},"scan"),call("build_repository_tasks",{scanId:"repository_scan-scan"},"tasks"),call("compare_contracts",{},"diff"),call("analyze_contract_impact",{contractDiffId:"contract_diff-diff"},"impact"),call("propose_patch",{impactId:"contract_impact-impact"},"proposal"),call("apply_patch_isolated",{proposalId:"patch_proposal-proposal"},"pending")]);
  let s=await h.runtime.start(h.input);assert.equal(s.run.state,"waiting_approval");assert.equal(await fingerprint(h.source),original);
  await h.runtime.guardrail.grant(s.pendingApproval!.approvalId,{actorId:"owner",source:"local-authenticated"});
  h.provider.setResponses([call("apply_patch_isolated",{proposalId:"patch_proposal-proposal"},"patch"),call("run_regression_tests",{patchArtifactId:"isolated_patch-patch"},"pending-tests")]);
  s=await h.runtime.resume();assert.equal(s.run.state,"waiting_approval");assert.equal(s.workspaceRevision,1);
  await h.runtime.guardrail.grant(s.pendingApproval!.approvalId,{actorId:"owner",source:"local-authenticated"});
  h.provider.setResponses([call("run_regression_tests",{patchArtifactId:"isolated_patch-patch"},"tests"),call("submit_completion",{package:h.p},"finish")]);
  s=await h.runtime.resume();assert.equal(s.run.state,"resolved");assert.equal(s.workspaceRevision,2);assert.equal(await fingerprint(h.source),original);
  assert.match(await readFile(join(h.work,"src/client.ts"),"utf8"),/amount: 42/);
  const data=(s.artifacts["test_run-tests"] as {data:{exitCode:number;stdout:string;testCount:number}}).data;
  assert.equal(data.exitCode,0);assert.equal(data.testCount,1);assert.match(data.stdout,/pass 1/);
  assert.equal((s.artifacts["repository_tasks-tasks"] as {data:unknown[]}).data.length,1);
  await writeFile(join(h.work,"src/client.ts"),"modified after tests");
  assert.equal(await h.backend.verifyCurrentWorkspace(),false);
  const restored=new RepositoryContractBackend(h.store,h.source,h.work,h.backend.previous,h.backend.next);
  assert.equal(await restored.verifyCurrentWorkspace(),false);
});
test("backend preconditions reject file changes after approval and do not execute writes",async t=>{
  const h=await migration(t);
  h.provider.setResponses([call("compare_contracts",{},"diff"),call("analyze_contract_impact",{contractDiffId:"contract_diff-diff"},"impact"),call("propose_patch",{impactId:"contract_impact-impact"},"proposal"),call("apply_patch_isolated",{proposalId:"patch_proposal-proposal"},"pending")]);
  const s=await h.runtime.start(h.input);await h.runtime.guardrail.grant(s.pendingApproval!.approvalId,{actorId:"owner",source:"local-authenticated"});
  await writeFile(join(h.source,"src/client.ts"),"drift");
  const done=await h.runtime.resume();assert.equal(done.run.state,"blocked");assert.equal(done.run.evidence.some(r=>r.kind==="isolated_patch"),false);
});
test("runtime host/DELETE attempts are blocked before HTTP execution",async t=>{
  const sandbox=await createDiagnosticSandbox();t.after(()=>sandbox.close());const h=await harness(t,[],[]);
  h.provider.setResponses([call("execute_http",{url:sandbox.endpoint,method:"DELETE",contentType:"application/json",amount:42},"delete")]);
  const runtime=new ApiHarnessRuntime(h.store,new RuntimeApiBackend(sandbox.endpoint),{hosts:["127.0.0.1"],ports:[Number(new URL(sandbox.endpoint).port)],environments:["sandbox"],credentialScopes:[]},h.options,()=>false);
  const s=await runtime.start({...task(),taskFamily:"runtime-api",allowedToolBundles:["runtime-api","shared"]});
  assert.equal(s.run.state,"blocked");assert.equal(s.run.evidence.length,0);
});
test("registered workspaces reject nested copy destinations and existing workspaces",async t=>{
  const h=await migration(t);assert.throws(()=>new RepositoryContractBackend(h.store,h.source,join(h.source,"nested"),h.backend.previous,h.backend.next),/OUTSIDE/);
  await mkdir(h.work);h.provider.setResponses([fauxAssistantMessage("No conclusion")]);await h.runtime.start(h.input);assert.equal(await h.backend.verifyCurrentWorkspace(),false);
});
