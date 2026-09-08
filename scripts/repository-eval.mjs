import { evaluateRepositories } from "../dist/src/evaluation/repository-eval.js";

const result = await evaluateRepositories();
console.log(JSON.stringify(result, null, 2));
if (!result.passed) process.exitCode = 1;
