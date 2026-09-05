import { DeterministicReasoner } from "./agent/deterministic-reasoner.js";
import { DebugOrchestrator } from "./core/orchestrator.js";
import type { DebugCase, Reasoner } from "./domain/types.js";
import { RequestPolicy } from "./security/request-policy.js";
import { FixtureHttpTool } from "./tools/fixture-http-tool.js";
import { RealHttpTool, type RealHttpToolOptions } from "./tools/real-http-tool.js";

export function createFixtureApp(caseData: DebugCase): DebugOrchestrator {
  return new DebugOrchestrator(
    new FixtureHttpTool(caseData),
    new DeterministicReasoner(),
    undefined,
    new RequestPolicy(new Set(["fixture.local"]))
  );
}

export function createRealApp(options: RealHttpToolOptions = {}): DebugOrchestrator {
  return createRealAppWithReasoner(options, new DeterministicReasoner());
}

export function createRealAppWithReasoner(
  options: RealHttpToolOptions = {},
  reasoner: Reasoner
): DebugOrchestrator {
  const allowedHosts = new Set(options.allowedHosts ?? ["localhost", "127.0.0.1"]);
  return new DebugOrchestrator(
    new RealHttpTool({ ...options, allowedHosts }),
    reasoner,
    undefined,
    new RequestPolicy(allowedHosts)
  );
}
