import { evaluateAgentic } from "../dist/src/evaluation/agentic-eval.js";
import { mkdir, realpath, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
try {
  let dataset, output;
  const args = process.argv.slice(2);
  for (let i=0; i<args.length; i++) {
    if (args[i] === "--dataset" && dataset === undefined && args[i+1] && !args[i+1].startsWith("--")) dataset=args[++i];
    else if (!args[i].startsWith("--") && output === undefined) output=args[i];
    else throw new Error("Usage: agentic-eval.mjs [output.json] [--dataset file.json]");
  }
  if (dataset !== undefined && output !== undefined) {
    const paths=await Promise.all([dataset,output].map(p=>realpath(p).catch(()=>resolve(p))));
    const normalize=p=>process.platform==="win32"?p.toLowerCase():p;
    if(normalize(paths[0])===normalize(paths[1])) throw new Error("DATASET_OUTPUT_COLLISION: report output must not overwrite the input dataset");
  }
  const report=await evaluateAgentic(3,dataset), json=JSON.stringify(report,null,2);
  if(output){const path=resolve(output);await mkdir(dirname(path),{recursive:true});await writeFile(path,json+"\n",{mode:0o600});}
  console.log(json);if(!report.passed)process.exitCode=1;
} catch (error) { console.error(error.message); process.exitCode=1; }
