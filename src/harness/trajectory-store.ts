import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { AgentRun, PendingApproval, ApprovalGrant, TrajectoryStep } from "./contracts.js";
import { redactValue } from "../security/redaction.js";

export interface RunSnapshot {
  formatVersion: 1; run: AgentRun; messages: unknown[];
  stateRevision: number; workspaceRevision: number; evidenceSequence: number;
  elapsedMs: number; artifacts: Record<string, unknown>;
  pendingApproval?: PendingApproval; grant?: ApprovalGrant; approvedArgs?: unknown;
  executionInDoubt?: { toolCallId: string; actionDigest: string };
  domainState?: unknown;
}
export function appendStep(s: RunSnapshot, kind: TrajectoryStep["kind"], data: unknown): void {
  const safe = redactValue(data);
  if ((kind === "model_turn" || kind === "review" && (data as { type?:string } | null)?.type === "model_turn") && data && typeof data === "object" && safe && typeof safe === "object") {
    const count = (data as { totalTokens?: number }).totalTokens;
    if (typeof count === "number" && Number.isSafeInteger(count) && count >= 0) (safe as { totalTokens?: number }).totalTokens = count;
  }
  s.run.steps.push({ seq: s.run.steps.length + 1, at: new Date().toISOString(), kind, data: safe });
  s.evidenceSequence++; // Append-only audit/observation clock; never a Grant version.
}
// An exclusive mkdir lock rejects concurrent processes. Stale locks fail closed;
// recovery requires inspection, never silently stealing a lock or replaying writes.
export class TrajectoryStore {
  readonly file: string;
  private tail: Promise<unknown> = Promise.resolve();
  constructor(file: string) { this.file = resolve(file); }
  async load(): Promise<RunSnapshot> {
    const s = JSON.parse(await readFile(this.file, "utf8")) as RunSnapshot;
    if (s.formatVersion !== 1 || !Number.isSafeInteger(s.stateRevision) || s.run.steps.some((v, i) => v.seq !== i + 1)) throw new Error("INVALID_SNAPSHOT");
    return s;
  }
  private serialized<T>(action: () => Promise<T>): Promise<T> {
    const next = this.tail.then(action, action); this.tail = next.catch(() => undefined); return next;
  }
  async create(snapshot: RunSnapshot): Promise<void> {
    await this.serialized(() => this.locked(async () => {
      try { await readFile(this.file); throw new Error("RUN_ALREADY_EXISTS"); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
      await this.save(snapshot);
    }));
  }
  async transact(change: (s: RunSnapshot) => void, expectedRevision?: number): Promise<RunSnapshot> {
    return this.serialized(() => this.locked(async () => {
      const s = await this.load();
      if (expectedRevision !== undefined && s.stateRevision !== expectedRevision) throw new Error("REVISION_CONFLICT");
      change(s); s.stateRevision++; await this.save(s); return structuredClone(s);
    }));
  }
  private async locked<T>(action: () => Promise<T>): Promise<T> {
    await mkdir(dirname(this.file), { recursive: true });
    const lock = `${this.file}.lock`;
    await mkdir(lock); // EEXIST is intentional: no unsafe concurrent overwrite.
    try { return await action(); } finally { await rm(lock, { recursive: true }); }
  }
  private async save(s: RunSnapshot): Promise<void> {
    const temp = `${this.file}.${randomUUID()}.tmp`;
    const f = await open(temp, "wx", 0o600);
    try { await f.writeFile(JSON.stringify(s)); await f.sync(); } finally { await f.close(); }
    try { await rename(temp, this.file); } finally { await rm(temp, { force: true }); }
  }
}
