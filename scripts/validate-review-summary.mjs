import { readFile } from 'node:fs/promises';
import { confined, options, validateSummary } from './review-summary.mjs';

try {
  const flags=options(process.argv.slice(2),['--file']);
  const file=await confined(process.cwd(),flags['--file']??'.review/review-summary.json','summary');
  const summary=validateSummary(JSON.parse(await readFile(file,'utf8')));
  console.log(`审计摘要有效：${summary.round} / ${summary.auditStatus}（不控制交付）`);
}catch(error){console.error(error.message);process.exitCode=1;}
