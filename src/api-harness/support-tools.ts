import { readFile, writeFile, rename, mkdir, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { FixtureLogConnector, FixtureCollaborationConnector } from "../collaboration/connectors.js";
import { JsonKnowledgeStore } from "../collaboration/knowledge-store.js";
import type { LogEvent, PublishedReceipt, CollaborationWorkItem } from "../collaboration/types.js";
import { TrajectoryStore } from "../harness/trajectory-store.js";
import { resolveEvidence } from "./convergent-workspace.js";
import { closed, defineTool, result } from "./tool-bundles.js";
import { digest } from "../harness/digest.js";
import type { ToolInvocation } from "../harness/pi-loop-adapter.js";
import type { ToolResult } from "../harness/contracts.js";
async function json(file:string,fallback:unknown):Promise<any>{try{const text=await readFile(file,"utf8");if(Buffer.byteLength(text)>65536)throw new Error("SUPPORT_STORE_LIMIT");return JSON.parse(text);}catch(e){if((e as NodeJS.ErrnoException).code==="ENOENT")return fallback;throw e;}}
export class ApiSupportTools {
  readonly tools;
  constructor(readonly store:TrajectoryStore){
    this.tools=[
      defineTool("search_knowledge","shared","Search registered structured knowledge for the authenticated task tenant; public demo if none. No vector retrieval or enterprise account implied.",closed({operation:{type:"string",maxLength:200},limit:{type:"integer",minimum:1,maximum:5}},["operation","limit"]),"knowledge_lookup",async(raw,c)=>{
        const a=raw as {operation:string;limit:number},s=await store.load(),tenantId=s.run.task.tenantId??"public-demo";
        const cases=await new JsonKnowledgeStore(`${store.file}.knowledge.json`).findSimilar({tenantId,...a});
        return result(c,"knowledge_lookup",{operation:a.operation,cases:cases.map(v=>({id:v.id,errorSignature:v.errorSignature,effectiveFix:v.effectiveFix,verification:v.verification,applicableVersion:v.applicableVersion}))});
      }),
      defineTool("query_logs","shared","Read registered local logs for task tenant/correlation, bounded to last 1 hour and 20 entries. Empty means no configured evidence, never fabricated enterprise logs.",closed({lookbackSeconds:{type:"integer",minimum:1,maximum:3600},limit:{type:"integer",minimum:1,maximum:20}},["lookbackSeconds","limit"]),"log_observation",async(raw,c)=>{
        const a=raw as {lookbackSeconds:number;limit:number},s=await store.load(),tenantId=s.run.task.tenantId??"public-demo",events=await json(`${store.file}.logs.json`,[]) as LogEvent[];
        if(!Array.isArray(events)||events.length>50)throw new Error("LOG_STORE_LIMIT");const now=Date.now();
        const logs=await new FixtureLogConnector(events.filter(v=>Date.parse(v.at)>=now-a.lookbackSeconds*1000&&Date.parse(v.at)<=now)).query({tenantId,correlationId:s.run.runId,limit:a.limit});
        return result(c,"log_observation",{logs});
      }),
      defineTool("publish_report","shared","Publish an evidence-referenced diagnostic draft to a local fixture connector with durable idempotency. Requires exact human approval. Does not send GitHub/Slack messages or certify task success.",closed({message:{type:"string",minLength:1,maxLength:1000},evidenceIds:{type:"array",minItems:1,maxItems:10,items:{type:"string",maxLength:160}}},["message","evidenceIds"]),"publication_receipt",async(raw,c)=>{
        const a=raw as {message:string;evidenceIds:string[]},s=await store.load();if(a.evidenceIds.some(id=>!resolveEvidence(s,id)))throw new Error("PUBLICATION_MISSING_EVIDENCE");
        const key=digest({runId:s.run.runId,args:a}),file=`${store.file}.publications.json`,ledger=await json(file,{}) as Record<string,PublishedReceipt>;
        if(ledger[key])return result(c,"publication_receipt",{idempotencyKey:key,receipt:ledger[key],fixture:true});
        const item:CollaborationWorkItem={id:s.run.runId,tenantId:s.run.task.tenantId??"public-demo",platform:"github",kind:"issue",title:"Sandbox diagnostic draft",description:"Registered local fixture; no external delivery",resource:"demo/fixture",replyTarget:"demo/fixture/issues/1",correlationId:s.run.runId};
        const receipt=await new FixtureCollaborationConnector(item).publish(item,{workItemId:item.id,status:"unresolved",rootCause:"UNKNOWN",attempts:s.run.usage.toolCalls,evidenceComplete:true,relatedCases:0,logEvents:0,regressionTest:"See referenced test evidence",message:a.message});
        ledger[key]=receipt;const temporary=`${file}.${randomUUID()}.tmp`;await writeFile(temporary,JSON.stringify(ledger),{mode:0o600});await rename(temporary,file);
        return result(c,"publication_receipt",{idempotencyKey:key,receipt,fixture:true});
      },"publish")
    ];
    this.tools[2]!.idempotency="keyed";
  }
  async precondition():Promise<string>{return digest(await json(`${this.store.file}.publications.json`,{}));}
  async withLock(_call:ToolInvocation,action:()=>Promise<ToolResult>):Promise<ToolResult>{const lock=`${this.store.file}.publication.lock`;await mkdir(dirname(lock),{recursive:true});await mkdir(lock);try{return await action();}finally{await rm(lock,{recursive:true});}}
}
