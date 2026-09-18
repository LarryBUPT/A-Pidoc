import test from "node:test";
import assert from "node:assert/strict";
import { pairedBootstrap, describeNumbers, type PairedObservation } from "../src/evaluation/statistics.js";

function sample(deltas: number[], repetitions = 1): PairedObservation[] {
  return deltas.flatMap((value, index) => Array.from({length:repetitions}, (_, r) => [
    {caseId:String(index), repetition:r+1, variant:"raw-pi" as const, value:10},
    {caseId:String(index), repetition:r+1, variant:"harness-pi" as const, value:10+value}
  ]).flat());
}
test("paired cluster bootstrap preserves signed differences, pairing and deterministic rerun dependence", () => {
  const rows = sample([-2, 0, 4]), r = pairedBootstrap(rows);
  assert.equal(r.estimate, 2/3); assert.equal(r.pairs, 3); assert.equal(r.clusters, 3);
  assert.deepEqual(r.ci95, [-2, 4]); assert.equal(r.degenerate, false);
  assert.deepEqual(pairedBootstrap([...rows].reverse()), r);
  assert.deepEqual(pairedBootstrap(rows), r);
  const repeated = pairedBootstrap(sample([-2, 0, 4], 3));
  assert.equal(repeated.pairs, 9); assert.equal(repeated.clusters, 3);
  assert.equal(repeated.estimate, r.estimate); assert.deepEqual(repeated.ci95, r.ci95);
  const swapped = pairedBootstrap(rows.map(row => ({...row,variant:row.variant === "raw-pi" ? "harness-pi" : "raw-pi"})));
  assert.equal(swapped.estimate, -r.estimate); assert.deepEqual(swapped.ci95, [-4, 2]);
});
test("zero contrasts are explicitly degenerate, and one case provides no interval", () => {
  const r = pairedBootstrap(sample([0, 0, 0], 3));
  assert.deepEqual(r.ci95, [0, 0]); assert.equal(r.degenerate, true);
  const one = pairedBootstrap(sample([2], 3));
  assert.equal(one.estimate, 2); assert.equal(one.ci95, null); assert.equal(one.resamples, 0);
});
test("statistical layer rejects missing, duplicate, invalid and unbalanced pairs", () => {
  const rows = sample([1, 2]);
  assert.throws(() => pairedBootstrap([]), /EMPTY/);
  assert.throws(() => pairedBootstrap(rows.slice(1)), /INCOMPLETE_PAIR/);
  assert.throws(() => pairedBootstrap([...rows, rows[0]!]), /DUPLICATE/);
  assert.throws(() => pairedBootstrap([...rows, ...sample([1], 2).slice(2)]), /UNBALANCED/);
  assert.throws(() => pairedBootstrap([{...rows[0]!, value:NaN}]), /INVALID/);
  assert.throws(() => pairedBootstrap(rows, 1, 0), /INVALID_BOOTSTRAP/);
});
test("repeat summaries report observed count, mean and range without a distribution assumption", () => {
  assert.deepEqual(describeNumbers([10, 20, 30]), {n:3,mean:20,min:10,max:30,range:20});
  assert.deepEqual(describeNumbers([10]), {n:1,mean:10,min:10,max:10,range:0});
  assert.throws(() => describeNumbers([]), /INVALID/); assert.throws(() => describeNumbers([Infinity]), /INVALID/);
});
