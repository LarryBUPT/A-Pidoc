import { evaluateContracts } from "../dist/src/evaluation/contract-eval.js";

const result = await evaluateContracts();
console.log(JSON.stringify(result, null, 2));
if (!result.passed) process.exitCode = 1;
