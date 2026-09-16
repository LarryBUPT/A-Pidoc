import { closed, defineTool, result, RuntimeApiBackend, type ToolBackend } from "../api-harness/tool-bundles.js";
import type { ApiActionDescriptor } from "../api-harness/api-guardrail.js";
import type { ToolInvocation } from "../harness/pi-loop-adapter.js";
import type { ToolResult } from "../harness/contracts.js";
import { digest } from "../harness/digest.js";
import type { ProbePlan } from "./contracts.js";
import { ProbeRunner, validatePlan } from "./probes.js";

// Add one registered read-only health profile; keep the original orders backend.
export function monitoringRuntimeBackend(plan:ProbePlan):ToolBackend {
  validatePlan(plan);
  return plan.method==="POST"?new RuntimeApiBackend(plan.endpoint):new HealthBackend(plan);
}
class HealthBackend implements ToolBackend {
  readonly tools;
  readonly contract={method:"GET",path:"/health",contractDigest:digest({method:"GET",path:"/health"}),requiredContentType:"",bodySchema:closed()};
  constructor(readonly plan:ProbePlan){
    this.tools=[
      defineTool("read_api_document","runtime-api","Read the registered read-only health operation. Response guarantees belong to the monitoring plan, not inferred documentation.",closed(),"api_operation",async(_a,c)=>result(c,"api_operation",this.contract)),
      defineTool("execute_http","runtime-api","Observe the registered read-only GET health endpoint. No body, redirects, arbitrary destinations or mutations are supported.",closed({url:{type:"string",const:plan.endpoint},method:{type:"string",const:"GET"}},["url","method"]),"http_observation",async(_a,c)=>{
        if(c.signal?.aborted)throw new Error("HTTP_CANCELLED");
        const o=await new ProbeRunner().execute(plan,plan.variants[0]!,Date.now(),c.signal);
        if(o.networkError)throw new Error("HEALTH_NETWORK_OR_OUTPUT_ERROR");
        return result(c,"http_observation",{request:o.request,response:{status:o.status,body:o.body},sideEffect:false});
      },"network")
    ];
  }
  async describe(c:ToolInvocation):Promise<ApiActionDescriptor>{
    return {environment:"sandbox",workspace:"isolated",sideEffectFree:true,conditionalExecution:false,preconditions:{contract:this.contract.contractDigest},...(c.name==="execute_http"?{request:{url:this.plan.endpoint,method:"GET" as const,headers:{},body:null},operation:{id:"sandbox-health",path:"/health",method:"GET",risk:"read" as const,contractDigest:this.contract.contractDigest,requiredScopes:[]}}:{})};
  }
  async withActionLock(_c:ToolInvocation,a:()=>Promise<ToolResult>){return a();}
  async verifyCurrentWorkspace(){return true;}
}
