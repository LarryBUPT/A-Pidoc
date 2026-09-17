import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rename, rm, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TrajectoryStore, type RunSnapshot } from "../src/harness/trajectory-store.js";
import type { RenameRetryIo } from "../src/harness/atomic-replace.js";
import { ReliabilityStore } from "../src/reliability/store.js";
import { task } from "./harness-helpers.js";

async function fixture(t: TestContext, kind: string, io: RenameRetryIo) {
  const directory = await mkdtemp(join(tmpdir(), "a-pidoc-rename-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, "store.json");
  let callbacks = 0;
  let update: () => Promise<unknown>;
  let revision: () => Promise<number>;
  if (kind === "trajectory") {
    const snapshot: RunSnapshot = {
      formatVersion: 1, run: { runId: "rename-test", task: task(), state: "running", steps: [],
        usage: { modelCalls: 0, toolCalls: 0, tokens: 0, estimatedCostUsd: 0 }, evidence: [] },
      messages: [], stateRevision: 0, workspaceRevision: 0, evidenceSequence: 0, elapsedMs: 0, artifacts: {}
    };
    await new TrajectoryStore(file).create(snapshot);
    const store = new TrajectoryStore(file, io);
    update = () => store.transact(s => { callbacks++; s.elapsedMs++; });
    revision = async () => (await store.load()).stateRevision;
  } else {
    await new ReliabilityStore(file).update(() => undefined);
    const store = new ReliabilityStore(file, io);
    update = () => store.update(s => { callbacks++; s.plans = {}; });
    revision = async () => (await store.load()).revision;
  }
  return { directory, file, update, revision, callbacks: () => callbacks,
    bytes: () => readFile(file, "utf8"), clean: async () => assert.deepEqual(await readdir(directory), ["store.json"]) };
}

for (const kind of ["trajectory", "reliability"]) {
  for (const code of ["EPERM", "EACCES"]) {
    test(`${kind} commits once after one transient Windows rename ${code}`, async t => {
      let attempts = 0;
      const waits: number[] = [], sources: string[] = [];
      const error = Object.assign(new Error("injected rename failure"), { code });
      const h = await fixture(t, kind, { platform: "win32", wait: async ms => { waits.push(ms); },
        rename: async (source, destination) => {
          attempts++; sources.push(String(source));
          if (attempts === 1) throw error;
          await rename(source, destination);
        } });
      const before = await h.revision();
      await h.update();
      assert.equal(await h.revision(), before + 1);
      assert.equal(h.callbacks(), 1, "retry must not replay the transaction callback");
      assert.equal(attempts, 2);
      assert.deepEqual(waits, [10]);
      assert.equal(new Set(sources).size, 1, "retry must reuse the fsynced temporary file");
      await h.clean();
    });

    test(`${kind} preserves old state and throws the original ${code} after bounded retries`, async t => {
      let attempts = 0;
      const waits: number[] = [];
      const error = Object.assign(new Error("persistent rename failure"), { code });
      const h = await fixture(t, kind, { platform: "win32", wait: async ms => { waits.push(ms); },
        rename: async () => { attempts++; throw error; } });
      const before = await h.bytes();
      await assert.rejects(h.update, e => e === error);
      assert.equal(attempts, 5);
      assert.deepEqual(waits, [10, 20, 40, 80]);
      assert.equal(h.callbacks(), 1);
      assert.equal(await h.bytes(), before);
      await h.clean();
    });
  }

  test(`${kind} does not retry file permission errors on Linux`, async t => {
    let attempts = 0, waits = 0;
    const error = Object.assign(new Error("Linux permission failure"), { code: "EPERM" });
    const h = await fixture(t, kind, { platform: "linux", wait: async () => { waits++; },
      rename: async () => { attempts++; throw error; } });
    const before = await h.bytes();
    await assert.rejects(h.update, e => e === error);
    assert.equal(attempts, 1);
    assert.equal(waits, 0);
    assert.equal(await h.bytes(), before);
    await h.clean();
  });

  test(`${kind} does not retry other error codes or replace the old snapshot`, async t => {
    for (const code of ["ENOENT", "EIO", "EEXIST"]) {
      let attempts = 0, waits = 0;
      const error = Object.assign(new Error("permanent rename failure"), { code });
      const h = await fixture(t, kind, { platform: "win32", wait: async () => { waits++; },
        rename: async () => { attempts++; throw error; } });
      const before = await h.bytes();
      await assert.rejects(h.update, e => e === error);
      assert.equal(attempts, 1);
      assert.equal(waits, 0);
      assert.equal(await h.bytes(), before);
      await h.clean();
    }
  });

  test(`${kind} retains its original stale-lock failure without attempting replacement`, async t => {
    let replacements = 0;
    const h = await fixture(t, kind, { platform: "win32", rename: async () => { replacements++; } });
    const before = await h.bytes();
    await mkdir(`${h.file}.lock`);
    await assert.rejects(h.update, kind === "trajectory" ? { code: "EEXIST" } : /RELIABILITY_STORE_BUSY_REQUIRES_INSPECTION/);
    assert.equal(replacements, 0);
    assert.equal(h.callbacks(), 0);
    assert.equal(await h.bytes(), before);
    await access(`${h.file}.lock`); // The lock still belongs to its original owner.
  });
}
