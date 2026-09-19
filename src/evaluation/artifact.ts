/** Timestamp at which an evaluation artifact is serialized. */
export function artifactGeneratedAt(nowMs = Date.now()): string {
  const value = new Date(nowMs);
  if (!Number.isFinite(value.getTime())) throw new Error("INVALID_ARTIFACT_GENERATION_TIME");
  return value.toISOString();
}
