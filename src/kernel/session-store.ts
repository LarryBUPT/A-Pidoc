import { appendFile, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { HarnessEvent, RunSnapshot } from "./types.js";

export interface RunSummary {
  runId: string;
  title: string;
  goal: string;
  kind: RunSnapshot["task"]["kind"];
  status: RunSnapshot["status"];
  archived: boolean;
  createdAt: string;
  updatedAt: string;
  metrics: RunSnapshot["metrics"];
  evidenceCount: number;
  pendingApprovalId?: string;
}

const RETRYABLE_FS_CODES = new Set(["EPERM", "EBUSY", "EACCES"]);

async function delay(ms: number): Promise<void> {
  await new Promise((resolveTimer) => setTimeout(resolveTimer, ms));
}

/**
 * Windows 友好型原子落盘：
 * 在 Windows NTFS 上，并发读写目标文件可能短暂触发 rename EPERM/EBUSY。
 * 通过短暂退避重试 + 失败时直接安全覆写，既保持 POSIX 原子性又杜绝 Windows 误报。
 */
async function safeWriteJson(filePath: string, data: unknown): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  const payload = `${JSON.stringify(data, null, 2)}\n`;
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2, 6)}.tmp`;
  await writeFile(tempPath, payload, "utf8");

  for (let attempt = 1; attempt <= 5; attempt += 1) {
    try {
      await rename(tempPath, filePath);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (!code || !RETRYABLE_FS_CODES.has(code)) {
        await rm(tempPath, { force: true }).catch(() => {});
        throw error;
      }
      await delay(15 * attempt);
    }
  }

  // 极端文件占用场景下安全兜底覆写并清理临时文件
  await rm(tempPath, { force: true }).catch(() => {});
  await writeFile(filePath, payload, "utf8");
}

/**
 * 持久化存储：每个 Run 独立目录
 * - 内置按 runId 串行化写队列 + 内存热缓存，彻底消除并发写冲突与 Windows 文件锁 EPERM
 * - snapshot.json: 完整运行状态（支持中断恢复、审批恢复、Trace 查看）
 * - events.jsonl:  时序事件流（支持逐步回放与故障归因）
 */
export class SessionStore {
  readonly rootDir: string;
  private readonly writeQueues = new Map<string, Promise<void>>();
  private readonly snapshotCache = new Map<string, RunSnapshot>();

  constructor(rootDir = resolve(".private/runs")) {
    this.rootDir = resolve(rootDir);
  }

  private runDir(runId: string): string {
    const safeId = runId.replace(/[^A-Za-z0-9._-]/g, "_");
    return join(this.rootDir, safeId);
  }

  snapshotPath(runId: string): string {
    return join(this.runDir(runId), "snapshot.json");
  }

  eventsPath(runId: string): string {
    return join(this.runDir(runId), "events.jsonl");
  }

  private enqueueWrite(runId: string, operation: () => Promise<void>): Promise<void> {
    const previous = this.writeQueues.get(runId) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(operation);
    this.writeQueues.set(runId, next);
    void next.finally(() => {
      if (this.writeQueues.get(runId) === next) {
        this.writeQueues.delete(runId);
      }
    });
    return next;
  }

  async saveSnapshot(snapshot: RunSnapshot): Promise<void> {
    snapshot.updatedAt = new Date().toISOString();
    const frozenCopy = structuredClone(snapshot);
    this.snapshotCache.set(snapshot.runId, frozenCopy);

    await this.enqueueWrite(snapshot.runId, async () => {
      await safeWriteJson(this.snapshotPath(snapshot.runId), frozenCopy);
    });
  }

  async loadSnapshot(runId: string): Promise<RunSnapshot | null> {
    const cached = this.snapshotCache.get(runId);
    if (cached) {
      return structuredClone(cached);
    }
    try {
      const raw = await readFile(this.snapshotPath(runId), "utf8");
      const parsed = JSON.parse(raw) as RunSnapshot;
      this.snapshotCache.set(runId, parsed);
      return structuredClone(parsed);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  async appendEvent(event: HarnessEvent): Promise<void> {
    const filePath = this.eventsPath(event.runId);
    await this.enqueueWrite(`${event.runId}:events`, async () => {
      await mkdir(dirname(filePath), { recursive: true });
      await appendFile(filePath, `${JSON.stringify(event)}\n`, "utf8");
    });
  }

  async readEvents(runId: string): Promise<HarnessEvent[]> {
    try {
      const raw = await readFile(this.eventsPath(runId), "utf8");
      return raw
        .split(/\r?\n/)
        .filter((line) => line.trim().length > 0)
        .map((line) => JSON.parse(line) as HarnessEvent);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }

  async listRuns(limit = 50): Promise<RunSummary[]> {
    try {
      const entries = await readdir(this.rootDir, { withFileTypes: true });
      const summaries: RunSummary[] = [];

      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const snapshot = await this.loadSnapshot(entry.name);
        if (!snapshot || snapshot.version !== 2) continue;

        const pending = snapshot.approvals.find((item) => item.status === "pending");
        summaries.push({
          runId: snapshot.runId,
          title: snapshot.task.title,
          goal: snapshot.task.goal,
          kind: snapshot.task.kind,
          status: snapshot.status,
          archived: Boolean(snapshot.archived),
          createdAt: snapshot.createdAt,
          updatedAt: snapshot.updatedAt,
          metrics: snapshot.metrics,
          evidenceCount: snapshot.evidence.length,
          ...(pending ? { pendingApprovalId: pending.approvalId } : {})
        });
      }

      return summaries
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
        .slice(0, limit);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }

  async updateRunMeta(
    runId: string,
    patch: { title?: string; archived?: boolean }
  ): Promise<RunSnapshot | null> {
    const snapshot = await this.loadSnapshot(runId);
    if (!snapshot) return null;
    if (patch.title !== undefined && patch.title.trim()) {
      snapshot.task.title = patch.title.trim();
    }
    if (patch.archived !== undefined) {
      snapshot.archived = patch.archived;
    }
    await this.saveSnapshot(snapshot);
    return snapshot;
  }

  async deleteRun(runId: string): Promise<boolean> {
    const existing = await this.loadSnapshot(runId);
    if (!existing) return false;
    await this.enqueueWrite(runId, async () => {
      this.snapshotCache.delete(runId);
      await rm(this.runDir(runId), { recursive: true, force: true });
    });
    return true;
  }
}
