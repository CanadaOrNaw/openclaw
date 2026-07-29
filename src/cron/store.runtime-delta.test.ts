import { describe, expect, it } from "vitest";
import { setupCronServiceSuite } from "./service.test-harness.js";
import {
  CronRuntimeRevisionMismatchError,
  loadCronJobsStoreWithConfigJobs,
  loadCronStore,
  saveCronJobsStore,
  saveCronStore,
} from "./store.js";
import type { CronJob, CronStoreFile } from "./types.js";

const { makeStorePath } = setupCronServiceSuite({ prefix: "cron-runtime-delta" });
const NOW = Date.parse("2026-07-29T00:00:00.000Z");

function job(id: string): CronJob {
  return {
    id,
    name: id,
    enabled: true,
    createdAtMs: NOW,
    updatedAtMs: NOW,
    schedule: { kind: "every", everyMs: 60_000 },
    sessionTarget: "isolated",
    wakeMode: "now",
    payload: { kind: "agentTurn", message: id },
    state: {},
  };
}

function runtimeBaseline(store: CronStoreFile) {
  return new Map(store.jobs.map((entry) => [entry.id, structuredClone(entry.state ?? {})]));
}

describe("cron state-only runtime deltas", () => {
  it("merges different-job writes and rejects a same-job conflict", async () => {
    const { storePath } = await makeStorePath();
    await saveCronStore(storePath, { version: 1, jobs: [job("runtime-a"), job("runtime-b")] });
    const loaded = await loadCronJobsStoreWithConfigJobs(storePath);
    const baseline = runtimeBaseline(loaded.store);
    const writerA = structuredClone(loaded.store);
    const writerB = structuredClone(loaded.store);
    writerA.jobs[0]!.state = { nextRunAtMs: 101 };
    writerB.jobs[1]!.state = { nextRunAtMs: 202 };

    for (const writer of [writerA, writerB]) {
      await saveCronJobsStore(storePath, writer, {
        stateOnly: true,
        expectedStoreEpoch: loaded.storeEpoch,
        expectedRuntimeRevision: loaded.runtimeRevision,
        expectedRuntimeStateByJobId: baseline,
      });
    }
    expect(writerB.jobs[0]?.state.nextRunAtMs).toBe(101);
    expect((await loadCronStore(storePath)).jobs.map((entry) => entry.state.nextRunAtMs)).toEqual([
      101, 202,
    ]);

    const conflictBase = await loadCronJobsStoreWithConfigJobs(storePath);
    const conflictBaseline = runtimeBaseline(conflictBase.store);
    const first = structuredClone(conflictBase.store);
    const stale = structuredClone(conflictBase.store);
    first.jobs[0]!.state = { nextRunAtMs: 303 };
    stale.jobs[0]!.state = { nextRunAtMs: 404 };
    await saveCronJobsStore(storePath, first, {
      stateOnly: true,
      expectedStoreEpoch: conflictBase.storeEpoch,
      expectedRuntimeRevision: conflictBase.runtimeRevision,
      expectedRuntimeStateByJobId: conflictBaseline,
    });
    await expect(
      saveCronJobsStore(storePath, stale, {
        stateOnly: true,
        expectedStoreEpoch: conflictBase.storeEpoch,
        expectedRuntimeRevision: conflictBase.runtimeRevision,
        expectedRuntimeStateByJobId: conflictBaseline,
      }),
    ).rejects.toBeInstanceOf(CronRuntimeRevisionMismatchError);
  });
});
