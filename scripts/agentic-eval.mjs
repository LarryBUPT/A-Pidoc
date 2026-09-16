import { evaluateAgentic } from "../dist/src/evaluation/agentic-eval.js";
const report=await evaluateAgentic();console.log(JSON.stringify(report,null,2));if(!report.passed)process.exitCode=1;
