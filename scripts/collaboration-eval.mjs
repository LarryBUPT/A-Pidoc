import { evaluateCollaboration } from "../dist/src/evaluation/collaboration-eval.js";

const result = await evaluateCollaboration();
console.log(JSON.stringify(result, null, 2));
if (!result.passed) process.exitCode = 1;
