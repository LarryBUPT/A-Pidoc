import { spawnSync } from "node:child_process";
import { runReliabilityScenario, RELIABILITY_DATASET } from "../dist/src/evaluation/reliability-eval.js";
import { join } from "node:path";
const results=[];
for(let run=1;run<=3;run++){
  const contracts=spawnSync(process.execPath,["--test","--test-concurrency=1","dist/test/reliability-v5.test.js"],{encoding:"utf8",timeout:120_000,windowsHide:true});
  if(contracts.status!==0){process.stderr.write(contracts.stdout??"");process.stderr.write(contracts.stderr??"");process.exitCode=1;break;}
  const scenario=await runReliabilityScenario(undefined,process.argv[2]?join(process.argv[2],`run-${run}`):undefined);results.push({run,contractsPassed:true,...scenario});if(!scenario.passed){process.exitCode=1;break;}
}
const passed=results.length===3&&results.every(r=>r.passed);console.log(JSON.stringify({dataset:RELIABILITY_DATASET,provider:"faux",liveEvidence:false,randomPolicy:"deterministic observations; random isolated IDs/ports",passed,results},null,2));if(!passed)process.exitCode=1;
