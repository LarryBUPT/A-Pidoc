import { loadExternalOpenApiManifest } from "./contracts.js";
import { createManifestDocumentLoader, probeExternalOpenApiCorpus } from "./corpus-probe.js";
import { evaluateExternalBenchmark, type ExternalBenchmarkArm } from "./external-eval.js";
import { DeterministicReasoner } from "../agent/deterministic-reasoner.js";
import { createConfiguredReasoner } from "../config/reasoner.js";
import { createRunnerReceipt, writeRunnerReceipt } from "./runner-receipt.js";

function values(args: string[], flag: string): string[] {
  const output: string[] = [];
  for (let index = 0; index < args.length; index += 1) if (args[index] === flag) {
    const value = args[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for ${flag}`);
    output.push(value);
  }
  return output;
}

function required(args: string[], flag: string): string {
  const all = values(args, flag);
  if (all.length !== 1) throw new Error(`${flag} must be supplied exactly once`);
  return all[0]!;
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  if (command === "probe") {
    const manifest = await loadExternalOpenApiManifest(required(args, "--manifest"));
    const hosts = values(args, "--allow-host");
    console.log(JSON.stringify(await probeExternalOpenApiCorpus(manifest.value, createManifestDocumentLoader(hosts)), null, 2));
    return;
  }
  if (command === "eval") {
    const hosts = values(args, "--allow-host");
    const ports = values(args, "--allow-port").map(Number);
    if (ports.some((port) => !Number.isInteger(port) || port < 1 || port > 65535)) throw new Error("--allow-port must be an integer between 1 and 65535");
    const arms: ExternalBenchmarkArm[] = [{ id: "deterministic", reasoner: new DeterministicReasoner() }];
    if (args.includes("--model")) {
      const reasoner = createConfiguredReasoner();
      if (reasoner.runtime.mode !== "pi") throw new Error("--model requires A_PIDOC_REASONER=pi and an explicitly configured provider/model");
      arms.push({ id: "configured-model", reasoner });
    }
    const report = await evaluateExternalBenchmark({
      casesPath: required(args, "--cases"),
      oraclePath: required(args, "--oracle"),
      allowedHosts: hosts,
      allowedPorts: ports,
      arms
    });
    console.log(JSON.stringify(report, null, 2));
    if (!report.passed) process.exitCode = 1;
    return;
  }
  if (command === "receipt") {
    const runner = required(args, "--runner");
    if (runner !== "hurl" && runner !== "schemathesis") throw new Error("--runner must be hurl or schemathesis");
    const integer = (flag: string): number => {
      const value = Number(required(args, flag));
      if (!Number.isInteger(value)) throw new Error(`${flag} must be an integer`);
      return value;
    };
    const receipt = await createRunnerReceipt({
      runner,
      runnerVersion: required(args, "--runner-version"),
      caseId: required(args, "--case-id"),
      rawReportPath: required(args, "--raw-report"),
      exitCode: integer("--exit-code"),
      requests: integer("--requests"),
      failures: integer("--failures")
    });
    await writeRunnerReceipt(required(args, "--output"), receipt);
    console.log(JSON.stringify(receipt, null, 2));
    return;
  }
  throw new Error("Usage: benchmark <probe --manifest FILE --allow-host HOST... | eval ... | receipt --runner KIND --runner-version VERSION --case-id ID --raw-report FILE --exit-code N --requests N --failures N --output FILE>");
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Benchmark failed safely");
  process.exitCode = 1;
});
