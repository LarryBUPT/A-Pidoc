import { rename } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";

export interface RenameRetryIo {
  rename?: typeof rename;
  platform?: NodeJS.Platform;
  wait?: (milliseconds: number) => Promise<unknown>;
}

// Only retry replacement of the already-written file, never the transaction or lock.
export async function atomicReplace(source: string, destination: string, io: RenameRetryIo = {}): Promise<void> {
  const replace = io.rename ?? rename;
  const wait = io.wait ?? delay;
  const platform = io.platform ?? process.platform;
  const backoffs = [10, 20, 40, 80] as const; // Five attempts, at most 150 ms of backoff.
  for (let attempt = 0; ; attempt++) {
    try { await replace(source, destination); return; }
    catch (error) {
      const code = (error as NodeJS.ErrnoException | null)?.code;
      const backoff = backoffs[attempt];
      if (platform !== "win32" || (code !== "EPERM" && code !== "EACCES") || backoff === undefined) throw error;
      await wait(backoff);
    }
  }
}
