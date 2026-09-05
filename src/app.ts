import { DeterministicReasoner } from "./agent/deterministic-reasoner.js";
import { DebugOrchestrator } from "./core/orchestrator.js";
import { FixtureHttpTool } from "./tools/fixture-http-tool.js";

export function createFixtureApp(): DebugOrchestrator {
  return new DebugOrchestrator(new FixtureHttpTool(), new DeterministicReasoner());
}
