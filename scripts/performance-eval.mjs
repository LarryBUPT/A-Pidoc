import {mkdir,writeFile} from "node:fs/promises";
import {resolve,join} from "node:path";
import {runPerformanceEvaluation} from "../dist/src/evaluation/performance-eval.js";
const directory=process.argv[2]?resolve(process.argv[2]):undefined;if(directory)await mkdir(directory,{recursive:true,mode:0o700});
const ioBound=await runPerformanceEvaluation(directory?join(directory,"io-bound"):undefined,40),noInjectedDelay=await runPerformanceEvaluation(directory?join(directory,"no-injected-delay"):undefined,0);
const report={dataset:"v5-probe-performance-v1",passed:ioBound.passed&&noInjectedDelay.passed,modelPolicy:"none",ioBound,noInjectedDelay};
if(directory)await writeFile(join(directory,"report.json"),JSON.stringify(report,null,2)+"\n",{mode:0o600});
console.log(JSON.stringify(report,null,2));if(!report.passed)process.exitCode=1;
