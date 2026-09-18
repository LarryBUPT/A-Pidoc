import { evaluateAgentic } from "../dist/src/evaluation/agentic-eval.js";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
const report=await evaluateAgentic(), json=JSON.stringify(report,null,2);
if(process.argv[2]){const output=resolve(process.argv[2]);await mkdir(dirname(output),{recursive:true});await writeFile(output,json+"\n",{mode:0o600});}
console.log(json);if(!report.passed)process.exitCode=1;
