import { describe, expect, it, vi } from "vitest";
import { setupCronServiceSuite } from "../service.test-harness.js";
import { loadCronStore, saveCronStore } from "../store.js";
import type { CronJob } from "../types.js";
import { createCronServiceState } from "./state.js";
import { ensureLoaded, persist } from "./store.js";

const { logger, makeStorePath } = setupCronServiceSuite({
  prefix: "cron-service-runtime-revision",
});
const NOW = Date.parse("2026-03-23T12:00:00.000Z");

function job(id: string): CronJob {
  return {
    id,
    name: id,
    enabled: true,
    createdAtMs: NOW - 60_000,
    updatedAtMs: NOW - 60_000,
    schedule: { kind: "every", everyMs: 60_000 },
    sessionTarget: "isolated",
    wakeMode: "now",
    payload: { kind: "agentTurn", message: id },
    state: {},
  };
}

describe("cron service runtime revisions", () => {
  it("publishes merged sibling runtime state after a stale full save", async () => {
    const { storePath } = await makeStorePath();
    await saveCronStore(storePath, { version: 1, jobs: [job("edited"), job("sibling")] });
    const state = createCronServiceState({
      storePath,
      cronEnabled: true,
      log: logger,
      nowMs: () => NOW,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeat: vi.fn(),
      runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
    });
    await ensureLoaded(state, { skipRecompute: true });

    const concurrent = await loadCronStore(storePath);
    const sibling = concurrent.jobs.find((entry) => entry.id === "sibling")!;
    sibling.state = { nextRunAtMs: NOW + 120_000, lastStatus: "ok" };
    await saveCronStore(storePath, concurrent, {
      stateOnly: true,
      expectedStoreEpoch: state.storeEpoch,
      expectedRuntimeRevision: state.runtimeRevision,
    });

    const edited = state.store?.jobs.find((entry) => entry.id === "edited");
    if (!edited) {
      throw new Error("missing edited cron fixture");
    }
    edited.name = "renamed";
    edited.updatedAtMs = NOW;
    await persist(state);

    const inMemorySibling = state.store?.jobs.find((entry) => entry.id === "sibling");
    expect(state.store?.jobs.find((entry) => entry.id === "edited")?.updatedAtMs).toBe(NOW);
    expect(inMemorySibling?.state).toMatchObject({
      nextRunAtMs: NOW + 120_000,
      lastStatus: "ok",
    });
    const durable = await loadCronStore(storePath);
    expect(durable.jobs.find((entry) => entry.id === "edited")?.updatedAtMs).toBe(NOW);
    expect(durable.jobs.find((entry) => entry.id === "sibling")?.state).toEqual(
      inMemorySibling?.state,
    );
  });
});
