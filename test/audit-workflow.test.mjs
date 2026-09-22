import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, readdir, rename, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';
import { validateSummary, metrics, parseAuditData, replaceAuditData, loadAudit, buildSummary, confined, atomicJson } from '../scripts/review-summary.mjs';
import { auditMain } from '../scripts/audit-workflow.mjs';

const repo=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const summaryScript=resolve(repo,'scripts/review-summary.mjs');
const validatorScript=resolve(repo,'scripts/validate-review-summary.mjs');
const workflowScript=resolve(repo,'scripts/audit-workflow.mjs');
const item=(number=1,extra={})=>({id:`AUDIT-001.${number}`,topic:'AUDIT-001',category:'bug',verdict:'成立',blocking:true,autoFixable:true,...extra});
const disposition=(id='AUDIT-001.1',value='ACCEPTED',extra={})=>({id,disposition:value,...extra});
const verified=(id='AUDIT-001.1',outcome='FIXED',extra={})=>({id,verdict:{FIXED:'通过',PARTIALLY_FIXED:'部分通过',NOT_FIXED:'未通过',UNABLE_TO_VERIFY:'无法验证',REGRESSION_INTRODUCED:'未通过',REJECTION_VERIFIED:'通过',DEFERRAL_VERIFIED:'通过',NOT_REPRODUCIBLE:'通过'}[outcome],outcome,blocking:outcome!=='FIXED',retryable:false,...extra});
function validSummary(){return {schemaVersion:1,round:'round-01',pr:80,branch:'codex/80-example',baseline:'a'.repeat(40),head:'b'.repeat(40),reviewerTool:'Claude Code',reviewerModel:null,developerTool:'Codex',auditStatus:'completed',review:{total:1,confirmed:1,partiallyConfirmed:0,rejected:0,insufficientEvidence:0},remediation:{accepted:1,partiallyAccepted:0,rejected:0,deferred:0},verification:{verifiedFixed:1,partiallyFixed:0,notFixed:0,notReproducible:0,unableToVerify:0,regressionIntroduced:0,verifiedRejected:0,verifiedDeferred:0},blockingUnresolved:0,remediationRounds:1};}
async function fixture(t){
  const root=await mkdtemp(resolve(tmpdir(),'apidoc-audit-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const git=args=>execFileSync('git',args,{cwd:root,stdio:'pipe',encoding:'utf8'}).trim();
  git(['init','-q']);await writeFile(resolve(root,'fixture.txt'),'test');git(['add','fixture.txt']);
  git(['-c','user.name=Audit Fixture','-c','user.email=audit@example.invalid','commit','-qm','test: fixture']);
  const sha=git(['rev-parse','HEAD']);
  const args=['prepare','--branch','test/audit','--baseline',sha,'--head',sha,'--topics','AUDIT-001'];
  await auditMain(args,root);
  const dir=resolve(root,'.private/review/current');
  const baselinePath=resolve(dir,'CURRENT_BASELINE.md');
  const prepared=await readFile(baselinePath,'utf8');
  await writeFile(baselinePath,'# 本轮固定基线\n\n- 产品与授权范围：仅测试元数据状态机。\n\n| 编号 | 来源 | 范围 |\n| --- | --- | --- |\n| AUDIT-001 | 测试用已选主题 | 本轮范围 |\n\n'+prepared.slice(prepared.indexOf('```audit-json')));
  const put=async(name,data)=>{const path=resolve(dir,name);await writeFile(path,replaceAuditData(await readFile(path,'utf8'),data));};
  const review=async(findings)=>put('REVIEW.md',{schemaVersion:1,round:'round-01',complete:true,reviewerTool:'Claude Code',reviewerModel:null,findings});
  const fix=async(findings,attempt=1)=>put('FIX_REPORT.md',{schemaVersion:1,round:'round-01',complete:true,attempt,findings});
  const verify=async(findings,attempt=1)=>put('VERIFICATION.md',{schemaVersion:1,round:'round-01',complete:true,attempt,findings});
  const step=()=>auditMain(['advance'],root);
  const summary=async()=>buildSummary(await loadAudit(dir));
  return {root,dir,put,review,fix,verify,step,summary,args};
}

test('合法 summary，包括 SHA-256，可通过',()=>{const s=validSummary();assert.equal(validateSummary(s),s);s.head='c'.repeat(64);validateSummary(s);});
test('缺少每个 required field 均失败',()=>{for(const key of Object.keys(validSummary())){const s=validSummary();delete s[key];assert.throws(()=>validateSummary(s));}});
test('负数量失败',()=>{const s=validSummary();s.review.confirmed=-1;assert.throws(()=>validateSummary(s));});
test('错误类型、非法 SHA、计数矛盾和整数溢出均失败',()=>{
  for(const change of [s=>s.schemaVersion='1',s=>s.head='HEAD',s=>s.blockingUnresolved='0',s=>s.review.total=2,s=>s.remediation.accepted=2,s=>s.verification.verifiedFixed=Number.MAX_SAFE_INTEGER,s=>s.remediationRounds=1.5,s=>{s.auditStatus='reviewed';s.remediationRounds=0;s.remediation.accepted=0;s.verification.verifiedFixed=0;}]){const s=validSummary();change(s);assert.throws(()=>validateSummary(s));}
});
test('total=0 合法，metrics 零分母 N/A',()=>{const s=validSummary();for(const group of ['review','remediation','verification'])for(const key of Object.keys(s[group]))s[group][key]=0;s.remediationRounds=0;validateSummary(s);assert.ok(Object.values(metrics(s)).every(x=>x===null));});
test('未执行 Reviewer 或 Codex 时不能冒称工具参与',()=>{
  const s=validSummary();for(const group of ['review','remediation','verification'])for(const key of Object.keys(s[group]))s[group][key]=0;
  s.auditStatus='prepared';s.remediationRounds=0;s.reviewerTool=null;s.developerTool=null;validateSummary(s);
  s.reviewerTool='Claude Code';s.developerTool='Codex';validateSummary(s);
  s.reviewerTool=null;s.review.total=1;s.review.confirmed=1;assert.throws(()=>validateSummary(s));
  s.review.total=0;s.review.confirmed=0;s.reviewerModel='unverified-model';assert.throws(()=>validateSummary(s));
});
test('completed 有 blocking 或未解决复核结果失败',()=>{let s=validSummary();s.blockingUnresolved=1;assert.throws(()=>validateSummary(s));s=validSummary();s.verification.verifiedFixed=0;s.verification.unableToVerify=1;assert.throws(()=>validateSummary(s));});
test('超过两轮失败',()=>{const s=validSummary();s.remediationRounds=3;assert.throws(()=>validateSummary(s));});
test('禁止敏感字段、嵌套额外字段和明显敏感元数据',()=>{
  for(const key of ['prompt','secret','token','user','conversation','absolutePath','modelResponse']){const s=validSummary();s[key]='private';assert.throws(()=>validateSummary(s));}
  for(const change of [s=>s.review.prompt='private',s=>s.reviewerModel='C:/Users/private',s=>s.reviewerModel='model:/home/private',s=>s.branch='a'.repeat(140)+'/sk-'+'x'.repeat(20),s=>s.reviewerModel='sk-'+'x'.repeat(20)]){const s=validSummary();change(s);assert.throws(()=>validateSummary(s));}
});
test('incomplete 是合法 summary',()=>{const s=validSummary();s.auditStatus='incomplete';s.verification.verifiedFixed=0;s.verification.unableToVerify=1;s.blockingUnresolved=1;validateSummary(s);});
test('固定块支持 CRLF，缺失、重复和损坏不猜测解析',()=>{
  assert.deepEqual(parseAuditData('正文\r\n```audit-json\r\n{"a":1}\r\n```\r\n'),{a:1});
  for(const input of ['成立','```audit-json\n{bad}\n```','x```audit-json\n{}\n```','```audit-json\n{}\n```x','```audit-json\n{}\n```\n```audit-json\n{}\n```'])assert.throws(()=>parseAuditData(input));
});
test('完整链路可生成摘要并通过真实 CLI validator 和 metrics',async t=>{
  const f=await fixture(t);await f.review([item()]);await f.step();await f.fix([disposition()]);await f.step();await f.verify([verified()]);await f.step();await f.step();
  assert.equal((await f.summary()).auditStatus,'completed');
  for(const [script,args] of [[summaryScript,[]],[validatorScript,[]],[summaryScript,['--metrics']]]){const run=spawnSync(process.execPath,[script,...args],{cwd:f.root,encoding:'utf8'});assert.equal(run.status,0,run.stderr);}
  const generated=JSON.parse(await readFile(resolve(f.root,'.review/review-summary.json'),'utf8'));assert.equal(generated.verification.verifiedFixed,1);assert.equal(generated.pr,null);
});
test('零 finding 无修复轮直接完成，可生成合法摘要',async t=>{const f=await fixture(t);await f.review([]);await f.step();assert.equal((await f.summary()).remediationRounds,0);});
test('基线正文含占位或遗漏已选主题时，不可登记 REVIEW',async t=>{
  const f=await fixture(t),path=resolve(f.dir,'CURRENT_BASELINE.md'),ready=await readFile(path,'utf8');
  await f.review([item()]);
  await writeFile(path,ready.replace('本轮范围','待填写'));await assert.rejects(f.step,/占位/);
  await writeFile(path,ready.replace('| AUDIT-001 |','| AUDIT-002 |'));await assert.rejects(f.step,/未列出已选主题/);
  await writeFile(path,ready);await f.step();assert.equal((await loadAudit(f.dir)).state.status,'reviewed');
});
test('显式主题是 prepare 必需项，且可选不在旧原型中的合法编号',async t=>{
  const f=await fixture(t),sha=execFileSync('git',['rev-parse','HEAD'],{cwd:f.root,encoding:'utf8'}).trim();
  await assert.rejects(()=>auditMain(['prepare','--dir','.private/review/round-02','--branch','test/audit','--head',sha],f.root),/显式指定/);
  const a=await auditMain(['prepare','--dir','.private/review/round-02','--branch','test/audit','--head',sha,'--topics','AUDIT-080'],f.root);
  assert.deepEqual(a.b.topics,['AUDIT-080']);
});
test('Reviewer 只能拆分已选主题；需求不能 autoFixable',async t=>{
  const f=await fixture(t);for(const value of [item(1,{id:'AUDIT-002.1',topic:'AUDIT-002'}),item(1,{category:'scope'}),item(1,{verdict:'证据不足'}),item(1,{id:'AUDIT-001'})]){await f.review([value]);await assert.rejects(f.step);}
  assert.equal((await loadAudit(f.dir)).state.remediationRounds,0);
});
test('Codex 必须逐条处置；不得接受需求型 finding',async t=>{
  const f=await fixture(t);await f.review([item(),item(2,{category:'scope',autoFixable:false})]);await f.step();await f.fix([disposition()]);await assert.rejects(f.step);
  await f.fix([disposition(),disposition('AUDIT-001.2')]);await assert.rejects(f.step);
});
test('prepared 正文可补齐，但关联主题不可改变；Review 后原始报告不可改写',async t=>{
  const f=await fixture(t),path=resolve(f.dir,'CURRENT_BASELINE.md');await writeFile(path,(await readFile(path,'utf8'))+'\n已核验正文\n');await loadAudit(f.dir);
  await f.review([item()]);await f.step();await writeFile(path,(await readFile(path,'utf8'))+'改变');await assert.rejects(()=>loadAudit(f.dir),/变化/);
});
test('无法验证与 blocking deferred 不触发重修，拒绝/延期不算修复',async t=>{
  const f=await fixture(t);await f.review([item(),item(2,{category:'scope',autoFixable:false}),item(3,{verdict:'不成立',autoFixable:false,blocking:false})]);await f.step();
  await f.fix([disposition(),disposition('AUDIT-001.2','DEFERRED',{reason:'scope_expansion',residualRisk:'private residual detail',blocking:true}),disposition('AUDIT-001.3','REJECTED')]);await f.step();
  await f.verify([verified('AUDIT-001.1','UNABLE_TO_VERIFY'),verified('AUDIT-001.2','DEFERRAL_VERIFIED',{blocking:false}),verified('AUDIT-001.3','REJECTION_VERIFIED',{blocking:false})]);await f.step();await f.step();
  const s=await f.summary();assert.equal(s.auditStatus,'incomplete');assert.equal(s.remediationRounds,1);assert.equal(s.blockingUnresolved,2);assert.equal(s.verification.verifiedFixed,0);assert.equal(s.verification.verifiedDeferred,1);assert.equal(s.verification.verifiedRejected,1);
  await assert.rejects(()=>f.verify([]).then(f.step)); // terminal ignores unregistered reports, frozen hash detects edits
});
test('无法验证和 DEFERRED 不能声称 retryable',async t=>{
  const f=await fixture(t);await f.review([item()]);await f.step();await f.fix([disposition()]);await f.step();await f.verify([verified('AUDIT-001.1','UNABLE_TO_VERIFY',{retryable:true})]);await assert.rejects(f.step,/只有明确/);
});
test('第二轮预算持久化、旧 attempt 被拒绝；仅目标残余缺陷进入重修',async t=>{
  const f=await fixture(t);await f.review([item(),item(2)]);await f.step();await f.fix([disposition(),disposition('AUDIT-001.2')]);await f.step();
  await f.verify([verified('AUDIT-001.1','NOT_FIXED',{retryable:true}),verified('AUDIT-001.2')]);await f.step();await f.step();
  let a=await loadAudit(f.dir);assert.equal(a.state.remediationRounds,2);assert.deepEqual(a.state.retryIds,['AUDIT-001.1']);assert.equal((await f.summary()).remediation.accepted,0);
  const restarted=spawnSync(process.execPath,[workflowScript,'advance'],{cwd:f.root,encoding:'utf8'});assert.equal(restarted.status,1);assert.match(restarted.stderr,/attempt/);
  await f.fix([disposition(),disposition('AUDIT-001.2','REJECTED')],2);await assert.rejects(f.step,/非重试项/);
  await f.fix([disposition(),disposition('AUDIT-001.2')],2);await f.step();
  await assert.rejects(f.step,/attempt/);
  await f.verify([verified('AUDIT-001.1','NOT_FIXED',{retryable:true}),verified('AUDIT-001.2')],2);await f.step();await f.step();
  a=await loadAudit(f.dir);assert.equal(a.state.status,'incomplete');assert.equal(a.state.remediationRounds,2);await f.step();assert.equal((await loadAudit(f.dir)).state.remediationRounds,2);
  assert.deepEqual(parseAuditData(await readFile(resolve(f.dir,'attempts/1/FIX_REPORT.md'),'utf8')).findings,[disposition(),disposition('AUDIT-001.2')]);
});
test('第二轮不能篡改首轮快照',async t=>{
  const f=await fixture(t);await f.review([item()]);await f.step();await f.fix([disposition()]);await f.step();await f.verify([verified('AUDIT-001.1','NOT_FIXED',{retryable:true})]);await f.step();await f.step();
  await writeFile(resolve(f.dir,'attempts/1/VERIFICATION.md'),'changed');await f.fix([disposition()],2);await assert.rejects(f.step,/报告内容发生变化/);
});
test('第二轮不能改变非重试项的复核结论',async t=>{
  const f=await fixture(t);await f.review([item(),item(2)]);await f.step();await f.fix([disposition(),disposition('AUDIT-001.2')]);await f.step();
  await f.verify([verified('AUDIT-001.1','NOT_FIXED',{retryable:true}),verified('AUDIT-001.2')]);await f.step();await f.step();
  await f.fix([disposition(),disposition('AUDIT-001.2')],2);await f.step();
  await f.verify([verified(),verified('AUDIT-001.2','NOT_FIXED')],2);await assert.rejects(f.step,/非重试项复核/);
});
test('Agent 不可用可提前停止；活动轮次不允许归档或 prepare 重置',async t=>{
  const f=await fixture(t);await assert.rejects(()=>auditMain(['archive'],f.root),/活动/);await assert.rejects(()=>auditMain(f.args,f.root),/活动/);
  const path=resolve(f.dir,'CURRENT_BASELINE.md');await writeFile(path,(await readFile(path,'utf8'))+'补齐正文');
  await auditMain(['stop','--reason','agent_unavailable'],f.root);assert.equal((await f.summary()).auditStatus,'incomplete');
  await auditMain(f.args,f.root);assert.equal((await loadAudit(f.dir)).b.round,'round-02');assert.ok((await readdir(resolve(f.root,'.private/review/round-01'))).includes('CURRENT_BASELINE.md'));
});
test('第二轮修复成功可闭环，统计不累加首轮尝试',async t=>{
  const f=await fixture(t);await f.review([item()]);await f.step();await f.fix([disposition()]);await f.step();await f.verify([verified('AUDIT-001.1','PARTIALLY_FIXED',{retryable:true})]);await f.step();await f.step();
  await f.fix([disposition()],2);await f.step();await f.verify([verified()],2);await f.step();await f.step();
  const s=await f.summary();assert.equal(s.auditStatus,'completed');assert.equal(s.remediationRounds,2);assert.equal(s.remediation.accepted,1);assert.equal(s.verification.verifiedFixed,1);
});
test('非阻塞需求延期可闭环，不计修复成功',async t=>{
  const f=await fixture(t);await f.review([item(1,{category:'scope',autoFixable:false,blocking:false})]);await f.step();await f.fix([disposition('AUDIT-001.1','DEFERRED',{reason:'scope_expansion',residualRisk:'暂不支持范围外能力',blocking:false})]);await f.step();await f.verify([verified('AUDIT-001.1','DEFERRAL_VERIFIED',{blocking:false})]);await f.step();await f.step();
  const s=await f.summary();assert.equal(s.auditStatus,'completed');assert.equal(metrics(s).fixVerificationRate,null);assert.equal(s.verification.verifiedDeferred,1);
});
test('PR 与 Git 关联真实提交，重复轮次与不存在的提交被拒绝',async t=>{
  const f=await fixture(t);await assert.rejects(()=>auditMain([...f.args,'--dir','.private/review/round-01'],f.root),/重复/);
  await assert.rejects(()=>auditMain([...f.args.slice(0,3),'--dir','.private/review/round-02','--head','f'.repeat(40)],f.root));
  const a=await auditMain([...f.args,'--dir','.private/review/round-02','--pr','80'],f.root);assert.equal(a.b.pr,80);assert.match(a.b.head,/^[a-f0-9]{40}$/);assert.equal(a.b.round,'round-02');
});
test('准备阶段拒绝修改机器基线，登记后拒绝修改原 REVIEW',async t=>{
  const f=await fixture(t);const path=resolve(f.dir,'CURRENT_BASELINE.md'),original=await readFile(path,'utf8'),data=parseAuditData(original);
  await f.put('CURRENT_BASELINE.md',{...data,pr:81});await assert.rejects(()=>loadAudit(f.dir),/基线关联/);await writeFile(path,original);
  await f.review([item()]);await f.step();await f.review([item(1,{verdict:'部分成立'})]);await assert.rejects(f.step,/报告内容发生变化/);
});
test('目录链接不得指向外部材料',async t=>{
  const f=await fixture(t),original=resolve(f.root,'.private/review/original');await rename(f.dir,original);
  await symlink(original,f.dir,process.platform==='win32'?'junction':'dir');
  await assert.rejects(()=>auditMain(['status'],f.root),/符号链接/);
});
test('历史轮次不转换、不覆盖，需显式 legacy 归档且不继承上下文',async t=>{
  const f=await fixture(t);await rm(resolve(f.dir,'audit-state.json'));await writeFile(resolve(f.dir,'REVIEW.md'),'历史私有报告');
  await assert.rejects(()=>auditMain(f.args,f.root),/历史/);await assert.rejects(()=>auditMain(['archive'],f.root),/历史/);
  await auditMain(['archive','--legacy'],f.root);assert.equal(await readFile(resolve(f.root,'.private/review/round-01/REVIEW.md'),'utf8'),'历史私有报告');
  await auditMain(f.args,f.root);assert.deepEqual(parseAuditData(await readFile(resolve(f.dir,'REVIEW.md'),'utf8')).findings,[]);
});
test('限制输入输出目录；已有临时文件不被删除',async t=>{
  const f=await fixture(t);for(const path of ['../other','.private/review/../../other','C:/secret','.private/review/archive/other'])await assert.rejects(()=>confined(f.root,path));
  await assert.rejects(()=>confined(f.root,'.private/review/summary.json','summary'));
  const path=resolve(f.dir,'test.json');await writeFile(path+'.tmp','existing');await assert.rejects(()=>atomicJson(path,{}));assert.equal(await readFile(path+'.tmp','utf8'),'existing');
});
test('incomplete 审计不改 CI/CD，既有 gate 不依赖审计状态或 summary',async t=>{
  const workflowFiles=['ci.yml','release-please.yml'];const before=await Promise.all(workflowFiles.map(name=>readFile(resolve(repo,'.github/workflows',name),'utf8')));
  const f=await fixture(t);await auditMain(['stop','--reason','unsafe'],f.root);
  const summaryRun=spawnSync(process.execPath,[summaryScript],{cwd:f.root,encoding:'utf8'});assert.equal(summaryRun.status,0,summaryRun.stderr);
  const validationRun=spawnSync(process.execPath,[validatorScript],{cwd:f.root,encoding:'utf8'});assert.equal(validationRun.status,0,validationRun.stderr);
  const after=await Promise.all(workflowFiles.map(name=>readFile(resolve(repo,'.github/workflows',name),'utf8')));assert.deepEqual(after,before);
  for(const content of after)assert.doesNotMatch(content,/review-summary|\.private\/review|review:validate|audit:|Claude|DeepSeek|Codex/);
  const scripts=JSON.parse(await readFile(resolve(repo,'package.json'),'utf8')).scripts;
  for(const command of ['build','test:unit','eval:tier-a','eval:repository','eval:contract','eval:collaboration','eval:harness','eval:agentic','eval:reliability','eval:performance'])assert.doesNotMatch(scripts[command],/audit:|review:|review-summary|audit-state/);
});
test('审计脚本不启动 Agent、模型或远端交付命令',async()=>{
  for(const name of ['audit-workflow.mjs','review-summary.mjs','validate-review-summary.mjs']){
    const body=await readFile(resolve(repo,'scripts',name),'utf8');
    assert.doesNotMatch(body,/\b(?:spawn|fork|fetch)\s*\(/);
    assert.doesNotMatch(body,/git['"],\s*\[['"](?:push|commit|merge|reset|checkout)/);
    assert.doesNotMatch(body,/ANTHROPIC_API_KEY|DEEPSEEK_API_KEY|OPENAI_API_KEY/);
  }
});
test('Reviewer 的自动状态命令与离线验证已授权，产品编辑和敏感读取禁令保留',async()=>{
  const {permissions}=JSON.parse(await readFile(resolve(repo,'.claude/settings.json'),'utf8'));
  for(const command of ['npm run audit:advance','npm run audit:status','npm run audit:stop -- --reason agent_unavailable','npm run build','npm run test:unit','npm run eval:harness'])assert.ok(permissions.allow.includes(`Bash(${command})`));
  for(const rule of ['Edit(/src/**)','Edit(/test/**)','Edit(/.github/**)','Edit(/.git/**)','Read(/.env)','Read(/.claude/settings.local.json)'])assert.ok(permissions.deny.includes(rule));
  assert.doesNotMatch(permissions.allow.join('\n'),/Bash\(\*\)|eval:[\w:]+:live|git (push|merge|commit)|npm (ci|install)/);
});
