import { readFile, open, mkdir, lstat, rename, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';

export const MAX_ROUNDS = 2;
export const STATUSES = ['prepared', 'reviewed', 'remediated', 'verified', 'completed', 'incomplete'];
export const REVIEW_COUNTS = { '成立': 'confirmed', '部分成立': 'partiallyConfirmed', '不成立': 'rejected', '证据不足': 'insufficientEvidence' };
export const FIX_COUNTS = { ACCEPTED: 'accepted', PARTIALLY_ACCEPTED: 'partiallyAccepted', REJECTED: 'rejected', DEFERRED: 'deferred' };
export const VERIFY_COUNTS = {
  FIXED: 'verifiedFixed', PARTIALLY_FIXED: 'partiallyFixed', NOT_FIXED: 'notFixed',
  NOT_REPRODUCIBLE: 'notReproducible', UNABLE_TO_VERIFY: 'unableToVerify',
  REGRESSION_INTRODUCED: 'regressionIntroduced', REJECTION_VERIFIED: 'verifiedRejected', DEFERRAL_VERIFIED: 'verifiedDeferred'
};
const VERIFY_VERDICTS = {
  FIXED: '通过', PARTIALLY_FIXED: '部分通过', NOT_FIXED: '未通过', NOT_REPRODUCIBLE: '通过',
  UNABLE_TO_VERIFY: '无法验证', REGRESSION_INTRODUCED: '未通过', REJECTION_VERIFIED: '通过', DEFERRAL_VERIFIED: '通过'
};
export const AUTO_CATEGORIES = ['bug', 'security', 'test', 'documentation'];
export const DEFER_REASONS = ['unsupported', 'external_environment', 'scope_expansion', 'unclear_requirement', 'design_tradeoff', 'unsafe'];
export const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const fail = message => { throw new Error(message); };
export const requireValue = (condition, message) => { if (!condition) fail(message); };
export function keys(value, required, optional = []) {
  requireValue(value !== null && typeof value === 'object' && !Array.isArray(value), '字段必须是对象');
  requireValue(required.every(k => Object.hasOwn(value, k)), '缺少必填字段');
  requireValue(Object.keys(value).every(k => required.includes(k) || optional.includes(k)), '包含未允许的字段');
}
const integer = x => Number.isSafeInteger(x) && x >= 0;
const sha = x => typeof x === 'string' && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(x);
const round = x => typeof x === 'string' && /^round-\d{2,}$/.test(x) && Number.isSafeInteger(Number(x.slice(6))) && Number(x.slice(6)) > 0;
function publicText(value) {
  return !/(?:[A-Z]:[\\/]|:\/\/|(?:^|[:=\s])\/(?:home|Users|tmp|var|etc|root)\/|Bearer\s|sk-[\w-]{16,}|gh[pousr]_[\w]{20,}|\beyJ[\w-]+\.)/i.test(value);
}
function label(value) {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._/()[\] +:-]{0,127}$/.test(value) &&
    publicText(value);
}
function metadata(x) {
  requireValue(round(x.round), 'round 格式错误');
  requireValue(x.pr === null || (integer(x.pr) && x.pr > 0), 'pr 必须是正整数或 null');
  requireValue(typeof x.branch === 'string' && /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/.test(x.branch) &&
    !/\.\.|\/\/|\.lock(?:\/|$)|[/.]$/.test(x.branch) && publicText(x.branch), 'branch 格式或公开内容错误');
  requireValue(sha(x.baseline) && sha(x.head), 'baseline/head 必须是完整 SHA');
}
function counts(value, names) {
  keys(value, names);
  requireValue(Object.values(value).every(integer), '数量必须是非负安全整数');
}
const sum = value => { const result=Object.values(value).reduce((a,b) => a+b,0); requireValue(Number.isSafeInteger(result),'数量之和溢出'); return result; };
const empty = mapping => Object.fromEntries(Object.values(mapping).map(k => [k,0]));
export function validateSummary(s) {
  keys(s, ['schemaVersion','round','pr','branch','baseline','head','reviewerTool','reviewerModel','developerTool',
    'auditStatus','review','remediation','verification','blockingUnresolved','remediationRounds']);
  requireValue(s.schemaVersion === 1, '不支持的 schemaVersion'); metadata(s);
  requireValue((s.reviewerTool === null || s.reviewerTool === 'Claude Code') &&
    (s.developerTool === null || s.developerTool === 'Codex'), '工具名称错误');
  requireValue(s.reviewerModel === null || label(s.reviewerModel), 'model 名称不可公开');
  requireValue(s.reviewerTool !== null || s.reviewerModel === null, '未执行 Reviewer 时不得登记 model');
  requireValue(STATUSES.includes(s.auditStatus), 'auditStatus 错误');
  counts(s.review, ['total',...Object.values(REVIEW_COUNTS)]);
  counts(s.remediation, Object.values(FIX_COUNTS)); counts(s.verification, Object.values(VERIFY_COUNTS));
  requireValue(integer(s.blockingUnresolved) && s.blockingUnresolved <= s.review.total, 'blockingUnresolved 错误');
  requireValue(integer(s.remediationRounds) && s.remediationRounds <= MAX_ROUNDS, '修复轮次超过上限');
  requireValue(sum(Object.fromEntries(Object.entries(s.review).filter(([k])=>k!=='total'))) === s.review.total, 'review 分类之和必须等于 total');
  const rem = sum(s.remediation), ver = sum(s.verification), accepted = s.remediation.accepted+s.remediation.partiallyAccepted;
  requireValue(s.reviewerTool !== null || (s.review.total===0 && ['prepared','incomplete'].includes(s.auditStatus)), '缺少 Reviewer 时不得声明已评审');
  requireValue(s.developerTool !== null || rem===0, '缺少 Codex 处置时不得记录修复');
  requireValue(rem <= s.review.total && ver <= rem, '处置/复核数量矛盾');
  requireValue(s.verification.verifiedFixed+s.verification.partiallyFixed+s.verification.regressionIntroduced <= accepted, '修复结果超过接受数量');
  requireValue(s.verification.verifiedRejected+s.verification.notReproducible <= s.remediation.rejected &&
    s.verification.verifiedDeferred <= s.remediation.deferred, '拒绝/延期复核数量矛盾');
  requireValue(accepted <= s.review.confirmed+s.review.partiallyConfirmed, '自动修复超出 Reviewer 成立部分');
  requireValue(rem === 0 || s.remediationRounds > 0, '存在处置但轮次为零');
  requireValue(s.review.total !== 0 || s.remediationRounds === 0,'零 finding 不使用修复预算');
  if(['reviewed','remediated','verified'].includes(s.auditStatus))requireValue(s.review.total>0 && s.remediationRounds>0,'活动修复阶段缺少 finding 或预算');
  if (s.auditStatus === 'prepared') requireValue(s.review.total === 0 && rem === 0 && ver === 0 && s.remediationRounds === 0, 'prepared 数量矛盾');
  if (s.auditStatus === 'reviewed') requireValue(rem === 0 && ver === 0, 'reviewed 尚未完成本次处置');
  if (s.auditStatus === 'remediated') requireValue(rem === s.review.total && ver === 0, 'remediated 数量矛盾');
  if (s.auditStatus === 'verified' || s.auditStatus === 'completed') requireValue(rem === s.review.total && ver === s.review.total, '最终复核必须覆盖所有 finding');
  if (s.auditStatus === 'completed') requireValue(s.blockingUnresolved === 0 &&
    s.verification.partiallyFixed+s.verification.notFixed+s.verification.unableToVerify+s.verification.regressionIntroduced === 0, 'completed 仍有未解决结果');
  return s;
}

const OPEN = '```audit-json\n', CLOSE = '\n```';
export function parseAuditData(markdown) {
  const text = markdown.replaceAll('\r\n','\n');
  const start = text.indexOf(OPEN), end = text.indexOf(CLOSE,start+OPEN.length);
  requireValue(start >= 0 && (start===0 || text[start-1]==='\n') && end >= 0 &&
    (end+CLOSE.length===text.length || text[end+CLOSE.length]==='\n') && text.indexOf(OPEN,start+OPEN.length) < 0,
    '报告必须有且只有一个 audit-json 数据块；历史报告不自动转换');
  return JSON.parse(text.slice(start+OPEN.length,end));
}
export function replaceAuditData(markdown, data) {
  const text = markdown.replaceAll('\r\n','\n'), start=text.indexOf(OPEN), end=text.indexOf(CLOSE,start+OPEN.length);
  parseAuditData(text);
  return text.slice(0,start+OPEN.length)+JSON.stringify(data,null,2)+text.slice(end);
}
export function validateBaseline(b) {
  keys(b,['schemaVersion','round','pr','branch','baseline','head','topics','maxRemediationRounds']);
  requireValue(b.schemaVersion === 1 && b.maxRemediationRounds === MAX_ROUNDS, '基线版本/轮次上限错误'); metadata(b);
  requireValue(Array.isArray(b.topics) && b.topics.length > 0 && b.topics.length <= 32 &&
    new Set(b.topics).size === b.topics.length && b.topics.every(t=>typeof t==='string' && /^AUDIT-[0-9]{3,}$/.test(t)),
    '基线必须显式列出不重复的审计主题');
  return b;
}
export async function confined(root, relative, type='audit') {
  const normalized = relative.replaceAll('\\','/');
  requireValue(type === 'audit' ? /^\.private\/review\/(?:current|round-\d{2,})$/.test(normalized) : /^\.review\/[A-Za-z0-9_-][A-Za-z0-9._-]*\.json$/.test(normalized), '路径不在允许目录');
  let path=resolve(root);
  for(const part of normalized.split('/')) { path=resolve(path,part); try{requireValue(!(await lstat(path)).isSymbolicLink(),'不跟随审计路径中的符号链接');}catch(e){if(e.code!=='ENOENT')throw e;} }
  return path;
}
export async function readAuditFile(directory,name) {
  let path=directory;
  const parts=name.split('/');
  for(const [index,part] of parts.entries()){
    path=resolve(path,part);const info=await lstat(path);
    requireValue(!info.isSymbolicLink() && (index===parts.length-1?info.isFile():info.isDirectory()),'审计输入必须为普通文件，不跟随链接');
  }
  return readFile(path);
}
export async function baselineAt(directory) { return validateBaseline(parseAuditData((await readAuditFile(directory,'CURRENT_BASELINE.md')).toString())); }
function reportHeader(data,b,attempt,kind) {
  keys(data, kind==='review' ? ['schemaVersion','round','complete','reviewerTool','reviewerModel','findings'] : ['schemaVersion','round','complete','attempt','findings']);
  requireValue(data.schemaVersion===1 && data.round===b.round && data.complete===true && Array.isArray(data.findings), '报告未完成或轮次错误');
  if(kind==='review') requireValue(data.reviewerTool==='Claude Code' && (data.reviewerModel===null || label(data.reviewerModel)), 'Reviewer 元数据错误');
  else requireValue(data.attempt===attempt && integer(attempt) && attempt>=1 && attempt<=MAX_ROUNDS, '修复报告 attempt 不匹配');
  requireValue(new Set(data.findings.map(f=>f.id)).size===data.findings.length,'finding ID 重复');
}
export function validateReview(data,b) {
  reportHeader(data,b,0,'review');
  for(const f of data.findings){
    keys(f,['id','topic','category','verdict','blocking','autoFixable']);
    requireValue(b.topics.includes(f.topic) && typeof f.id==='string' && new RegExp(`^${f.topic}\\.[1-9]\\d*$`).test(f.id), 'finding 不属于基线现有主题');
    requireValue([...AUTO_CATEGORIES,'scope','unclear','design'].includes(f.category) && Object.hasOwn(REVIEW_COUNTS,f.verdict), 'finding 分类错误');
    requireValue(typeof f.blocking==='boolean' && typeof f.autoFixable==='boolean', 'finding 标志必须为 boolean');
    requireValue(!f.autoFixable || (AUTO_CATEGORIES.includes(f.category) && ['成立','部分成立'].includes(f.verdict)), '非明确缺陷不能自动修复');
  } return data;
}
function cover(data,review){requireValue(data.findings.length===review.findings.length && data.findings.every(f=>review.findings.some(r=>r.id===f.id)),'报告必须逐条覆盖相同 finding');}
export function validateFix(data,b,review,attempt) {
  reportHeader(data,b,attempt,'fix');cover(data,review);
  for(const f of data.findings){
    keys(f,['id','disposition'],['reason','residualRisk','blocking']);requireValue(Object.hasOwn(FIX_COUNTS,f.disposition),'Codex 处置错误');
    const original=review.findings.find(r=>r.id===f.id);
    if(['ACCEPTED','PARTIALLY_ACCEPTED'].includes(f.disposition)) requireValue(original.autoFixable && AUTO_CATEGORIES.includes(original.category),'自动修复超出明确成立部分');
    if(f.disposition==='DEFERRED') requireValue(DEFER_REASONS.includes(f.reason) && typeof f.residualRisk==='string' && f.residualRisk.trim().length>0 && typeof f.blocking==='boolean','DEFERRED 必须记录原因、残留风险和审计 blocking');
    else requireValue(!Object.hasOwn(f,'reason') && !Object.hasOwn(f,'residualRisk') && !Object.hasOwn(f,'blocking'),'非 DEFERRED 不使用延期字段');
  }return data;
}
export function validateVerification(data,b,review,fix,attempt) {
  reportHeader(data,b,attempt,'verification');cover(data,review);
  for(const f of data.findings){
    keys(f,['id','verdict','outcome','blocking','retryable']);
    requireValue(Object.hasOwn(VERIFY_COUNTS,f.outcome) && f.verdict===VERIFY_VERDICTS[f.outcome] && typeof f.blocking==='boolean' && typeof f.retryable==='boolean','复核状态错误');
    const r=review.findings.find(x=>x.id===f.id), disposition=fix.findings.find(x=>x.id===f.id).disposition;
    if(['FIXED','PARTIALLY_FIXED','REGRESSION_INTRODUCED'].includes(f.outcome)) requireValue(['ACCEPTED','PARTIALLY_ACCEPTED'].includes(disposition),'修复结果必须对应接受处置');
    if(['NOT_REPRODUCIBLE','REJECTION_VERIFIED'].includes(f.outcome))requireValue(disposition==='REJECTED','拒绝复核必须对应 REJECTED');
    if(f.outcome==='DEFERRAL_VERIFIED')requireValue(disposition==='DEFERRED','延期复核必须对应 DEFERRED');
    if(f.verdict==='通过')requireValue(f.blocking===false && f.retryable===false,'通过结果不能要求重修');
    if(f.retryable)requireValue(r.autoFixable && AUTO_CATEGORIES.includes(r.category) && disposition!=='DEFERRED' && ['PARTIALLY_FIXED','NOT_FIXED','REGRESSION_INTRODUCED'].includes(f.outcome),'只有明确可自动修复的残余 defect 可重试');
  }return data;
}

export async function loadAudit(directory) {
  const b=await baselineAt(directory), state=JSON.parse((await readAuditFile(directory,'audit-state.json')).toString());
  keys(state,['schemaVersion','round','status','remediationRounds','hashes','retryIds'],['stopReason','previousHashes']);
  requireValue(state.schemaVersion===1 && state.round===b.round && STATUSES.includes(state.status) && integer(state.remediationRounds) && state.remediationRounds<=MAX_ROUNDS && Array.isArray(state.retryIds), '审计状态错误');
  keys(state.hashes,['baseline','baselineFields'],['review','fix','verification']);
  requireValue(Object.values(state.hashes).every(x=>typeof x==='string' && /^[a-f0-9]{64}$/.test(x)), '报告哈希格式错误');
  requireValue(new Set(state.retryIds).size===state.retryIds.length && state.retryIds.every(x=>typeof x==='string'), '重试编号错误');
  if(state.remediationRounds===2){keys(state.previousHashes,['fix','verification']);requireValue(Object.values(state.previousHashes).every(x=>typeof x==='string' && /^[a-f0-9]{64}$/.test(x)),'首轮报告哈希错误');}
  else requireValue(!state.previousHashes,'首轮不应包含历史重试数据');
  requireValue(!state.hashes.fix || state.hashes.review, 'Fix 缺少 Review');
  requireValue(!state.hashes.verification || state.hashes.fix, 'Verification 缺少 Fix');
  const read = async (name,expected) => { const bytes=await readAuditFile(directory,name);requireValue(hash(bytes)===expected,'已固定的报告内容发生变化：'+name);return parseAuditData(bytes.toString()); };
  if(state.previousHashes){
    await read('attempts/1/FIX_REPORT.md',state.previousHashes.fix);
    await read('attempts/1/VERIFICATION.md',state.previousHashes.verification);
  }
  requireValue(hash(JSON.stringify(b))===state.hashes.baselineFields,'基线关联或主题发生变化');
  if(state.status!=='prepared')await read('CURRENT_BASELINE.md',state.hashes.baseline);
  let review=null,fix=null,verification=null;
  if(state.hashes.review)review=validateReview(await read('REVIEW.md',state.hashes.review),b);
  if(state.hashes.fix)fix=validateFix(await read('FIX_REPORT.md',state.hashes.fix),b,review,state.remediationRounds);
  if(state.hashes.verification)verification=validateVerification(await read('VERIFICATION.md',state.hashes.verification),b,review,fix,state.remediationRounds);
  requireValue(state.retryIds.every(id=>review?.findings.some(r=>r.id===id && r.autoFixable)), '重试编号超出明确缺陷');
  if(state.status==='prepared')requireValue(!review && !fix && !verification && state.remediationRounds===0 && state.retryIds.length===0,'prepared 状态矛盾');
  if(state.status==='reviewed')requireValue(review && !fix && !verification && state.remediationRounds>=1,'reviewed 状态缺少本轮输入');
  if(state.status==='remediated')requireValue(fix && !verification,'remediated 状态缺少本轮输入');
  if(state.status==='verified' || (state.status==='completed' && review?.findings.length)) requireValue(verification,'最终状态缺少本次复核');
  if(state.status==='completed')requireValue(review && unresolved({review,fix,verification}).length===0,'completed 仍有未解决结果');
  return {b,state,review,fix,verification};
}
export function unresolved(audit) {
  return (audit.review?.findings??[]).filter(r=>{
    const f=audit.fix?.findings.find(x=>x.id===r.id),v=audit.verification?.findings.find(x=>x.id===r.id);
    return !v || v.verdict!=='通过' || (f?.disposition==='DEFERRED' && f.blocking);
  });
}
export function buildSummary(audit) {
  const {b,state,review,fix,verification}=audit;
  const s={schemaVersion:1,round:b.round,pr:b.pr,branch:b.branch,baseline:b.baseline,head:b.head,
    reviewerTool:review?'Claude Code':null,reviewerModel:review?.reviewerModel??null,developerTool:fix?'Codex':null,auditStatus:state.status,
    review:{total:review?.findings.length??0,...empty(REVIEW_COUNTS)},remediation:empty(FIX_COUNTS),verification:empty(VERIFY_COUNTS),blockingUnresolved:0,remediationRounds:state.remediationRounds};
  for(const f of review?.findings??[])s.review[REVIEW_COUNTS[f.verdict]]++;
  for(const f of fix?.findings??[])s.remediation[FIX_COUNTS[f.disposition]]++;
  for(const f of verification?.findings??[])s.verification[VERIFY_COUNTS[f.outcome]]++;
  for(const r of review?.findings??[]){const f=fix?.findings.find(x=>x.id===r.id),v=verification?.findings.find(x=>x.id===r.id);
    if(f?.disposition==='DEFERRED' ? f.blocking || (v && v.verdict!=='通过' && v.blocking) : v ? v.blocking : r.blocking)s.blockingUnresolved++;}
  return validateSummary(s);
}
export function metrics(summary) {
  const s=validateSummary(summary), accepted=s.remediation.accepted+s.remediation.partiallyAccepted;
  const rate=(n,d)=>d===0?null:n/d;
  return {reviewerConfirmationRate:rate(s.review.confirmed+s.review.partiallyConfirmed,s.review.total),
    reviewerRejectionRate:rate(s.review.rejected,s.review.total),remediationAcceptanceRate:rate(accepted,s.review.total),
    fixVerificationRate:rate(s.verification.verifiedFixed,accepted),regressionRate:rate(s.verification.regressionIntroduced,accepted),unresolvedRate:rate(s.blockingUnresolved,s.review.total)};
}
export function options(args,allowed) {
  const out={};for(let i=0;i<args.length;i++){const key=args[i];requireValue(allowed.includes(key) && !Object.hasOwn(out,key),'未知或重复参数');if(key==='--metrics'||key==='--legacy')out[key]=true;else{requireValue(args[i+1] && !args[i+1].startsWith('--'),'参数缺少值');out[key]=args[++i];}}return out;
}
export async function atomicJson(path,data) {
  const temporary=path+'.tmp';
  await mkdir(dirname(path),{recursive:true});
  let created=false;
  try { const handle=await open(temporary,'wx'); created=true;
    try{await handle.writeFile(JSON.stringify(data,null,2)+'\n');}finally{await handle.close();}
    await rename(temporary,path);
  }finally{if(created)await rm(temporary,{force:true});}
}
export async function summaryMain(args=process.argv.slice(2),root=process.cwd()) {
  const flags=options(args,['--dir','--output','--metrics']);
  if(flags['--metrics']){
    const file=await confined(root,flags['--output']??'.review/review-summary.json','summary');
    const result=metrics(JSON.parse(await readFile(file,'utf8')));
    for(const [key,value]of Object.entries(result))console.log(`${key}: ${value===null?'N/A':(value*100).toFixed(2)+'%'}`);
    return result;
  }
  const directory=await confined(root,flags['--dir']??'.private/review/current');
  const summary=buildSummary(await loadAudit(directory));
  const output=await confined(root,flags['--output']??'.review/review-summary.json','summary');
  await atomicJson(output,summary);
  console.log(`审计摘要：${summary.round} / ${summary.auditStatus}`);return summary;
}
if(process.argv[1] && import.meta.url===pathToFileURL(resolve(process.argv[1])).href) summaryMain().catch(e=>{console.error(e.message);process.exitCode=1;});
