import type { TraceEvent } from "../domain/types.js";
import { safeError } from "../security/errors.js";

export class TraceRecorder {
  private readonly events: TraceEvent[] = [];
  private seq = 0;

  async span<T>(stage: string, work: () => Promise<T>, metadata?: Record<string, unknown>): Promise<T> {
    const start = performance.now();
    this.push(stage, "started", metadata);
    try {
      const value = await work();
      this.push(stage, "succeeded", { ...metadata, durationMs: Math.round(performance.now() - start) });
      return value;
    } catch (error) {
      const safe = safeError(error);
      this.push(stage, "failed", {
        ...metadata,
        durationMs: Math.round(performance.now() - start),
        errorCode: safe.code,
        error: safe.message
      });
      throw error;
    }
  }

  snapshot(): TraceEvent[] {
    return structuredClone(this.events);
  }

  private push(stage: string, status: TraceEvent["status"], metadata?: Record<string, unknown>): void {
    const durationMs = typeof metadata?.durationMs === "number" ? metadata.durationMs : undefined;
    const cleanMetadata = metadata ? { ...metadata } : undefined;
    if (cleanMetadata) delete cleanMetadata.durationMs;
    this.events.push({
      seq: ++this.seq,
      stage,
      status,
      at: new Date().toISOString(),
      ...(durationMs === undefined ? {} : { durationMs }),
      ...(cleanMetadata && Object.keys(cleanMetadata).length > 0 ? { metadata: cleanMetadata } : {})
    });
  }
}
