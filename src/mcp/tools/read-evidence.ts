import type { TrajectoryStore } from "../../harness/trajectory-store.js";
import { evidenceReader } from "../../api-harness/tool-bundles.js";

export function createReadEvidenceTool(store: TrajectoryStore) {
  return evidenceReader(store);
}
