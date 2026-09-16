import { runReliabilityScenario } from "../dist/src/evaluation/reliability-eval.js";
const report=await runReliabilityScenario();console.log(JSON.stringify(report,null,2));if(!report.passed)process.exitCode=1;
