import { readFile, writeFile, mkdir, rename, rm, readdir, lstat } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import {
  MAX_ROUNDS, requireValue, hash, confined, options, atomicJson,
  parseAuditData, replaceAuditData, readAuditFile, validateBaseline, validateReview, validateFix,
  validateVerification, loadAudit, unresolved, summaryMain
} from './review-summary.mjs';

const templates=resolve(dirname(fileURLToPath(import.meta.url)),'../docs/review/templates');
const terminal=status=>['completed','incomplete'].includes(status);
const files={baseline:'CURRENT_BASELINE.md',review:'REVIEW.md',fix:'FIX_REPORT.md',verification:'VERIFICATION.md'};
const next={prepared:'Reviewer: /review-issues',reviewed:'Codex: 独立核验并最小修复',remediated:'Reviewer: /verify-fixes',verified:'audit:advance 判定闭环或有限重试',completed:'audit:summary / audit:validate',incomplete:'audit:summary / audit:validate（交付继续）'};
const git=(root,args)=>execFileSync('git',args,{cwd:root,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
async function exists(path){try{await lstat(path);return true;}catch(e){if(e.code==='ENOENT')return false;throw e;}}

async function locked(root,work){
  const parent=resolve(root,'.private/review');
  // confined checks every existing ancestor before any filesystem mutation.
  await confined(root,'.private/review/current');
  await mkdir(parent,{recursive:true});
  const lock=resolve(parent,'.audit.lock');
  try{await mkdir(lock);}catch(e){if(e.code==='EEXIST')throw new Error('审计状态正在使用；不等待、不影响交付');throw e;}
  try{return await work();}finally{await rm(lock,{recursive:true,force:true});}
}
async function nextRound(root){
  const names=await readdir(resolve(root,'.private/review'));
  const numbers=names.filter(x=>/^round-\d{2,}$/.test(x)).map(x=>Number(x.slice(6)));
  return 'round-'+String(Math.max(0,...numbers)+1).padStart(2,'0');
}
async function archive(root,directory,legacy=false){
  requireValue(directory===await confined(root,'.private/review/current'),'仅轮转 current 目录');
  const stateFile=resolve(directory,'audit-state.json');
  let round;
  if(await exists(stateFile)){
    requireValue(!legacy,'机器轮次不能按历史材料归档');
    const audit=await loadAudit(directory); requireValue(terminal(audit.state.status),'活动轮次不能归档或重置预算'); round=audit.b.round;
  }else{requireValue(legacy,'历史材料没有机器状态；使用 archive --legacy 原样归档');round=await nextRound(root);}
  const target=await confined(root,'.private/review/'+round);
  requireValue(!(await exists(target)),'归档目标已存在，拒绝覆盖');
  await rename(directory,target); return round;
}

export async function prepare(root,flags={}){
  requireValue(typeof flags['--topics']==='string' && flags['--topics'].length>0,'prepare 必须显式指定已有主题 --topics');
  const relative=(flags['--dir']??'.private/review/current').replaceAll('\\','/'),directory=await confined(root,relative);
  if(await exists(directory)){
    requireValue(relative==='.private/review/current','指定轮次目录已存在，拒绝覆盖');
    requireValue(await exists(resolve(directory,'audit-state.json')),'历史 current 保持原样；先 archive --legacy 或指定新的 round-N 目录');
    await archive(root,directory);
  }
  const round=relative==='.private/review/current'?await nextRound(root):relative.split('/').at(-1);
  if(relative!=='.private/review/current' && await exists(resolve(root,'.private/review/current/audit-state.json'))){
    const current=await loadAudit(await confined(root,'.private/review/current'));
    requireValue(round!==current.b.round,'指定轮次与 current 重复');
  }
  const head=flags['--head']??git(root,['rev-parse','HEAD']);
  const b=validateBaseline({schemaVersion:1,round,pr:flags['--pr']?Number(flags['--pr']):null,
    branch:flags['--branch']??git(root,['branch','--show-current']),baseline:flags['--baseline']??head,head,
    topics:flags['--topics'].split(','),maxRemediationRounds:MAX_ROUNDS});
  // Explicit SHAs must resolve locally too; metadata cannot invent a Git association.
  for(const sha of [b.baseline,b.head])requireValue(git(root,['rev-parse','--verify',sha+'^{commit}']).toLowerCase()===sha.toLowerCase(),'审计提交不存在');
  const reports={baseline:b,review:{schemaVersion:1,round,complete:false,reviewerTool:'Claude Code',reviewerModel:null,findings:[]},
    fix:{schemaVersion:1,round,complete:false,attempt:1,findings:[]},verification:{schemaVersion:1,round,complete:false,attempt:1,findings:[]}};
  await mkdir(directory);
  try{
    for(const [kind,name]of Object.entries(files)){
      const template=await readFile(resolve(templates,name),'utf8');
      await writeFile(resolve(directory,name),replaceAuditData(template,reports[kind]),{flag:'wx'});
    }
    const baselineHash=hash(await readFile(resolve(directory,files.baseline)));
    await atomicJson(resolve(directory,'audit-state.json'),{schemaVersion:1,round,status:'prepared',remediationRounds:0,hashes:{baseline:baselineHash,baselineFields:hash(JSON.stringify(b))},retryIds:[]});
  }catch(error){await rm(directory,{recursive:true,force:true});throw error;}
  return loadAudit(directory);
}

async function report(directory,kind){return parseAuditData((await readAuditFile(directory,files[kind])).toString());}
async function requireFilledBaseline(directory,b){
  const body=(await readAuditFile(directory,files.baseline)).toString().split('```audit-json')[0];
  requireValue(!/待填写|待核对|待判断/.test(body),'基线正文仍有占位内容');
  for(const topic of b.topics)requireValue(body.includes(`| ${topic} |`),`基线正文未列出已选主题 ${topic}`);
}
async function snapshot(directory,kind,attempt){
  let target=directory;
  for(const part of ['attempts',String(attempt)]){
    target=resolve(target,part);
    if(await exists(target)){const info=await lstat(target);requireValue(info.isDirectory() && !info.isSymbolicLink(),'不跟随修复快照目录链接');}
    else await mkdir(target);
  }
  const bytes=await readAuditFile(directory,files[kind]),path=resolve(target,files[kind]);
  if(await exists(path))requireValue(hash(await readAuditFile(target,files[kind]))===hash(bytes),'已保存的修复轮次不可覆盖');
  else await writeFile(path,bytes,{flag:'wx'});
}
async function retryContract(directory,audit){
  const fixBytes=await readAuditFile(directory,'attempts/1/FIX_REPORT.md'),verifyBytes=await readAuditFile(directory,'attempts/1/VERIFICATION.md');
  requireValue(hash(fixBytes)===audit.state.previousHashes.fix && hash(verifyBytes)===audit.state.previousHashes.verification,'首轮快照发生变化');
  const priorFix=validateFix(parseAuditData(fixBytes.toString()),audit.b,audit.review,1);
  const priorVerification=validateVerification(parseAuditData(verifyBytes.toString()),audit.b,audit.review,priorFix,1);
  const eligible=priorVerification.findings.filter(f=>f.retryable).map(f=>f.id);
  requireValue(JSON.stringify([...eligible].sort())===JSON.stringify([...audit.state.retryIds].sort()),'第二轮目标与首轮复核不一致');
  return {priorFix,priorVerification};
}
export async function advance(directory){
  const audit=await loadAudit(directory),{b,state,review}=audit;
  if(terminal(state.status))return audit;
  if(state.status==='prepared'){
    await requireFilledBaseline(directory,b);
    const r=validateReview(await report(directory,'review'),b);
    state.hashes.baseline=hash(await readFile(resolve(directory,files.baseline)));
    state.hashes.review=hash(await readFile(resolve(directory,files.review)));
    state.status=r.findings.length?'reviewed':'completed';
    state.remediationRounds=r.findings.length?1:0;
    state.retryIds=r.findings.filter(f=>f.autoFixable).map(f=>f.id);
  }else if(state.status==='reviewed'){
    const fix=validateFix(await report(directory,'fix'),b,review,state.remediationRounds);
    if(state.remediationRounds===2){
      const {priorFix}=await retryContract(directory,audit);
      for(const f of fix.findings)if(!state.retryIds.includes(f.id))requireValue(isDeepStrictEqual(f,priorFix.findings.find(x=>x.id===f.id)),'第二轮不能更改非重试项处置');
    }
    await snapshot(directory,'fix',state.remediationRounds);
    state.hashes.fix=hash(await readFile(resolve(directory,files.fix)));state.status='remediated';
  }else if(state.status==='remediated'){
    const verification=validateVerification(await report(directory,'verification'),b,review,audit.fix,state.remediationRounds);
    if(state.remediationRounds===2){
      const {priorVerification}=await retryContract(directory,audit);
      for(const f of verification.findings)if(!state.retryIds.includes(f.id))requireValue(isDeepStrictEqual(f,priorVerification.findings.find(x=>x.id===f.id)),'第二轮不能更改非重试项复核');
    }
    await snapshot(directory,'verification',state.remediationRounds);
    state.hashes.verification=hash(await readFile(resolve(directory,files.verification)));state.status='verified';
  }else if(state.status==='verified'){
    const remaining=unresolved(audit),retryIds=audit.verification.findings.filter(f=>f.retryable).map(f=>f.id);
    if(!remaining.length)state.status='completed';
    else if(state.remediationRounds<MAX_ROUNDS && retryIds.length){
      state.previousHashes={fix:state.hashes.fix,verification:state.hashes.verification};
      state.remediationRounds++;state.status='reviewed';state.retryIds=retryIds;
      delete state.hashes.fix;delete state.hashes.verification;
    }else{state.status='incomplete';state.stopReason=state.remediationRounds===MAX_ROUNDS?'round_limit':'no_retryable_defect';}
  }
  await atomicJson(resolve(directory,'audit-state.json'),state);return loadAudit(directory);
}

export async function auditMain(args=process.argv.slice(2),root=process.cwd()){
  const [action,...tail]=args;
  if(action==='summary')return summaryMain(tail,root);
  const allowed=action==='prepare'?['--dir','--pr','--branch','--baseline','--head','--topics']:
    action==='archive'?['--dir','--legacy']:action==='stop'?['--dir','--reason']:['--dir'];
  requireValue(['prepare','advance','status','archive','stop'].includes(action),'操作：prepare / advance / status / stop / archive / summary');
  const flags=options(tail,allowed),directory=await confined(root,flags['--dir']??'.private/review/current');
  if(action==='status'){const a=await loadAudit(directory);console.log(`${a.b.round}: ${a.state.status} (${a.state.remediationRounds}/${MAX_ROUNDS}) → ${next[a.state.status]}`);return a;}
  return locked(root,async()=>{
    if(action==='archive'){const round=await archive(root,directory,flags['--legacy']??false);console.log('原样归档：'+round);return round;}
    let audit;
    if(action==='prepare')audit=await prepare(root,flags);
    else if(action==='advance')audit=await advance(directory);
    else{
      audit=await loadAudit(directory);
      requireValue(['agent_unavailable','unsafe','terminated'].includes(flags['--reason']),'stop 需要明确原因');
      if(!terminal(audit.state.status)){
        if(audit.state.status==='prepared')audit.state.hashes.baseline=hash(await readAuditFile(directory,files.baseline));
        audit.state.status='incomplete';audit.state.stopReason=flags['--reason'];await atomicJson(resolve(directory,'audit-state.json'),audit.state);
      }
    }
    console.log(`${audit.b.round}: ${audit.state.status} (${audit.state.remediationRounds}/${MAX_ROUNDS}) → ${next[audit.state.status]}`);return audit;
  });
}
if(process.argv[1] && import.meta.url===pathToFileURL(resolve(process.argv[1])).href)auditMain().catch(e=>{console.error(e.message);process.exitCode=1;});
