import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { harness } from "./harness-helpers.js";
import { performanceFixtures, performancePlan } from "../src/evaluation/performance-eval.js";
import { ReliabilityStore } from "../src/reliability/store.js";
import { ProbeRunner, ProbeScheduler } from "../src/reliability/probes.js";
import { runReliabilityCommand } from "../src/reliability/cli.js";
import type { ProbePlan, ProbeVariant } from "../src/reliability/contracts.js";
import { validatePlan } from "../src/reliability/probes.js";
async function setup(t:Parameters<typeof harness>[0],count=4){const h=await harness(t,[],[]),fixture=await performanceFixtures(count,30);t.after(()=>fixture.close());const store=new ReliabilityStore(join(h.dir,"probes.json"));return {...h,fixture,store};}
async function register(scheduler:ProbeScheduler,endpoints:string[]){for(const [i,url] of endpoints.entries())await scheduler.register(performancePlan(`plan-${i}`,url));}

test("probe pool defaults to one and rejects unsafe concurrency before CLI work",async t=>{
  const h=await setup(t,1);assert.equal(new ProbeScheduler(h.store).maxConcurrentOrigins,1);for(const n of [0,5,1.5,NaN,Infinity])assert.throws(()=>new ProbeScheduler(h.store,undefined,n),/INVALID_PROBE_CONCURRENCY/);
  await assert.rejects(()=>runReliabilityCommand("reliability-status",new Map([["state",h.store.file],["probe-concurrency","5"]])),/INVALID_PROBE_CONCURRENCY/);assert.equal(h.fixture.stats().requests,0);
});
test("independent real HTTP probes overlap within the bound and retain canonical result order",async t=>{
  const h=await setup(t),scheduler=new ProbeScheduler(h.store,undefined,2);await register(scheduler,h.fixture.endpoints);const rows=await scheduler.tick(0);
  assert.equal(h.fixture.stats().peakConcurrentRequests,2);assert.ok(h.fixture.stats().peakPerOrigin.every(v=>v===1));assert.equal(h.fixture.stats().requests,8);assert.ok(rows.every(r=>r.healthy));
  assert.deepEqual(rows.map(r=>`${r.planId}:${r.variantId}`),h.fixture.endpoints.flatMap((_u,i)=>[`plan-${i}:valid`,`plan-${i}:missing-amount`]));assert.equal((await h.store.load()).probes.length,8);assert.equal(new Set(rows.map(r=>r.id)).size,8);
});
test("same-origin plans stay sequential across different tenants",async t=>{
  const h=await setup(t,1),scheduler=new ProbeScheduler(h.store,undefined,4);await scheduler.register(performancePlan("a",h.fixture.endpoints[0]!));await scheduler.register({...performancePlan("b",h.fixture.endpoints[0]!),tenantId:"other-team"});
  const rows=await scheduler.tick(0);assert.equal(rows.length,4);assert.equal(h.fixture.stats().peakConcurrentRequests,1);assert.deepEqual(rows.map(r=>r.tenantId),["benchmark-team","benchmark-team","other-team","other-team"]);
});
test("undeclared concurrency is an exclusive barrier and default execution keeps registration order",async t=>{
  const h=await harness(t,[],[]),trace:Array<{index:number;active:number[]}>=[],fixture=await performanceFixtures(5,30,(index,active)=>trace.push({index,active}));t.after(()=>fixture.close());
  const scheduler=new ProbeScheduler(new ReliabilityStore(join(h.dir,"barrier.json")),undefined,4);
  for(const [i,url] of fixture.endpoints.entries()){const p=performancePlan(`p-${i}`,url);if(i===2){delete p.parallelSafe;delete p.snapshotConsistent;}await scheduler.register(p);}
  assert.equal((await scheduler.tick(0)).length,10);assert.equal(fixture.stats().peakConcurrentRequests,2);assert.ok(trace.filter(v=>v.index===2).every(v=>v.active.length===1&&v.active[0]===2));
  assert.throws(()=>validatePlan({...performancePlan("bad",fixture.endpoints[0]!),parallelSafe:"yes" as unknown as boolean}),/INVALID_PROBE_PLAN/);
  trace.length=0;fixture.reset();const serial=new ProbeScheduler(new ReliabilityStore(join(h.dir,"serial.json")));
  for(const [i,index] of [0,1,0].entries())await serial.register(performancePlan(`s-${i}`,fixture.endpoints[index]!));await serial.tick(0);assert.deepEqual(trace.map(v=>v.index),[0,0,1,1,0,0]);
});
test("overlapping ticks share the scheduler bound and durable slots are not replayed",async t=>{
  const h=await setup(t,2),scheduler=new ProbeScheduler(h.store,undefined,1);await register(scheduler,h.fixture.endpoints);
  const [first,second,duplicate]=await Promise.all([scheduler.tick(0),scheduler.tick(100),scheduler.tick(100)]);assert.equal(first.length,4);assert.equal(second.length,4);assert.equal(duplicate.length,0);assert.equal(h.fixture.stats().peakConcurrentRequests,1);assert.ok(second.every(r=>r.scheduledAt===100));
  assert.equal((await new ProbeScheduler(new ReliabilityStore(h.store.file),undefined,4).tick(100)).length,0);assert.equal(h.fixture.stats().requests,8);
});
test("a plan disabled while queued does not start its claimed network probes",async t=>{
  const h=await setup(t,2);let scheduler:ProbeScheduler;
  class Runner extends ProbeRunner {override async execute(p:ProbePlan,v:ProbeVariant,at:number,signal?:AbortSignal){const r=await super.execute(p,v,at,signal);if(p.id==="plan-0"&&v.id==="valid")await scheduler.setEnabled("plan-1",false,0);return r;}}
  scheduler=new ProbeScheduler(h.store,new Runner(),1);await register(scheduler,h.fixture.endpoints);const rows=await scheduler.tick(0);assert.equal(rows.length,2);assert.equal(h.fixture.stats().requests,2);assert.equal((await h.store.load()).plans["plan-1"]!.enabled,false);
});
test("cancellation skips pending origins and an already-aborted tick does not claim new slots",async t=>{
  const h=await setup(t),controller=new AbortController();
  class Runner extends ProbeRunner {override async execute(p:ProbePlan,v:ProbeVariant,at:number,signal?:AbortSignal){const r=await super.execute(p,v,at,signal);controller.abort();return r;}}
  const scheduler=new ProbeScheduler(h.store,new Runner(),1);await register(scheduler,h.fixture.endpoints);assert.equal((await scheduler.tick(0,controller.signal)).length,1);assert.equal(h.fixture.stats().requests,1);
  const revision=(await h.store.load()).revision;assert.equal((await scheduler.tick(100,controller.signal)).length,0);assert.equal((await h.store.load()).revision,revision);
});
test("persistence failure waits for an uncancellable active probe before rejecting the tick",{timeout:10_000},async t=>{
  const h=await setup(t,3);let entered!:()=>void,release!:()=>void,failed!:()=>void;const inside=new Promise<void>(r=>entered=r),blocked=new Promise<void>(r=>release=r),failure=new Promise<void>(r=>failed=r);t.after(()=>release());
  class Store extends ReliabilityStore {override update<T>(change:(s:Awaited<ReturnType<ReliabilityStore["load"]>>)=>T){return super.update(s=>{const v=change(s);if(s.probes.some(o=>o.planId==="plan-0")){failed();throw new Error("INJECTED_PERSISTENCE_FAILURE");}return v;});}}
  class Runner extends ProbeRunner {override async execute(p:ProbePlan,v:ProbeVariant,at:number,signal?:AbortSignal){if(p.id==="plan-0")await inside;else entered();const r=await super.execute(p,v,at,signal);if(p.id==="plan-1")await blocked;return r;}}
  const scheduler=new ProbeScheduler(new Store(h.store.file),new Runner(),2);await register(scheduler,h.fixture.endpoints);let settled=false;
  const running=scheduler.tick(0).then(()=>{settled=true;},e=>{settled=true;throw e;});const expected=assert.rejects(running,/INJECTED_PERSISTENCE_FAILURE/);await failure;await delay(15);assert.equal(settled,false);release();await expected;assert.ok(h.fixture.stats().requests<=2);
});
