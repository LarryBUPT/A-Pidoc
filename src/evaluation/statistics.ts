export function describeNumbers(values: readonly number[]) {
  if (!values.length || values.some(v => !Number.isFinite(v))) throw new Error("INVALID_STATISTICAL_SAMPLE");
  const min = Math.min(...values), max = Math.max(...values);
  return { n: values.length, mean: values.reduce((a, b) => a + b, 0) / values.length, min, max, range: max - min };
}

export interface PairedObservation {
  caseId: string;
  repetition: number;
  variant: "raw-pi" | "harness-pi";
  value: number;
}

// Resample whole cases: deterministic reruns of a fixture are not new independent tasks.
export function pairedBootstrap(rows: readonly PairedObservation[], seed = 20260917, resamples = 10_000) {
  if (!Number.isSafeInteger(seed) || seed < 0 || seed > 0xffffffff || !Number.isSafeInteger(resamples) || resamples < 100) throw new Error("INVALID_BOOTSTRAP_OPTIONS");
  const pairs = new Map<string, Partial<Record<PairedObservation["variant"], number>>>();
  const cases = new Map<string, Map<number, number>>();
  for (const row of rows) {
    if (!row.caseId || !Number.isSafeInteger(row.repetition) || row.repetition < 1 || !Number.isFinite(row.value) || !["raw-pi", "harness-pi"].includes(row.variant)) throw new Error("INVALID_PAIRED_OBSERVATION");
    const key = JSON.stringify([row.caseId, row.repetition]), pair = pairs.get(key) ?? {};
    if (pair[row.variant] !== undefined) throw new Error("DUPLICATE_PAIRED_OBSERVATION");
    pair[row.variant] = row.value; pairs.set(key, pair);
  }
  for (const [key, pair] of pairs) {
    if (pair["raw-pi"] === undefined || pair["harness-pi"] === undefined) throw new Error("INCOMPLETE_PAIR");
    const [caseId, repetition] = JSON.parse(key) as [string, number];
    const group = cases.get(caseId) ?? new Map<number, number>();
    group.set(repetition, pair["harness-pi"] - pair["raw-pi"]); cases.set(caseId, group);
  }
  if (!cases.size) throw new Error("EMPTY_PAIRED_SAMPLE");
  const groups = [...cases].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
  const repetitions = [...groups[0]![1].keys()].sort((a, b) => a - b);
  if (groups.some(([, group]) => JSON.stringify([...group.keys()].sort((a, b) => a - b)) !== JSON.stringify(repetitions))) throw new Error("UNBALANCED_CASE_REPETITIONS");
  const deltas = groups.map(([, group]) => describeNumbers([...group.entries()].sort(([a], [b]) => a - b).map(([, value]) => value)).mean);
  const estimate = describeNumbers(deltas).mean;
  let state = seed >>> 0;
  const draws: number[] = [];
  if (groups.length >= 2) for (let i = 0; i < resamples; i++) {
    let sum = 0;
    for (let j = 0; j < groups.length; j++) {
      state = (Math.imul(1664525, state) + 1013904223) >>> 0;
      sum += deltas[Math.floor(state / 0x100000000 * deltas.length)]!;
    }
    draws.push(sum / groups.length);
  }
  draws.sort((a, b) => a - b);
  const quantile = (p: number) => {
    const position = (draws.length - 1) * p, lower = Math.floor(position), fraction = position - lower;
    return draws[lower]! + fraction * (draws[Math.min(lower + 1, draws.length - 1)]! - draws[lower]!);
  };
  const ci95 = draws.length ? [quantile(0.025), quantile(0.975)] : null;
  return { estimate, ci95, pairs: pairs.size, clusters: groups.length, repetitionsPerCase: repetitions.length,
    direction: "harness-pi minus raw-pi", method: "paired case-cluster percentile bootstrap", confidenceLevel: 0.95,
    seed, resamples: draws.length, randomGenerator: "LCG32 (1664525, 1013904223)", quantile: "linear interpolation",
    degenerate: ci95 !== null && ci95[0] === ci95[1],
    limitation: groups.length < 2 ? "Insufficient case clusters; no confidence interval" : "Describes fixed fixtures only; few clusters and deterministic repeats do not establish population coverage or generalization" };
}
