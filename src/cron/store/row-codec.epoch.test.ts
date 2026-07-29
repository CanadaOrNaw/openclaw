import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import {
  closeOpenClawStateDatabaseByPath,
  openOpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import { makeCronJob } from "../delivery.test-helpers.js";
import type { CronJob } from "../types.js";
import {
  CronRuntimeRevisionMismatchError,
  loadedCronStoreFromRows,
  loadCronRows,
  materializeCronRowAgentOwners,
  readCronRuntimeRevision,
  readCronStoreEpoch,
  replaceCronRows,
  updateCronRuntimeRows,
} from "./row-codec.js";

const execFileAsync = promisify(execFile);

const concurrentWriterSource = `
  const { DatabaseSync } = await import("node:sqlite");
  const { upsertCronJobRow } = await import("./src/cron/store/row-codec.ts");
  const database = new DatabaseSync(process.argv[1]);
  database.exec("PRAGMA busy_timeout = 5000");
  const now = Date.now();
  const epoch = upsertCronJobRow(database, "cron-epoch-test", {
    id: process.argv[2],
    name: process.argv[2],
    enabled: true,
    createdAtMs: now,
    updatedAtMs: now,
    schedule: { kind: "every", everyMs: 60000 },
    sessionTarget: "isolated",
    wakeMode: "next-heartbeat",
    payload: { kind: "agentTurn", message: "hello" },
    state: {},
  }, 0);
  database.close();
  process.stdout.write(String(epoch));
`;

describe("cron store epoch", () => {
  it("bumps the epoch when a job_json-only config field is removed", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-cron-sidecar-"));
    const handle = openOpenClawStateDatabase({ path: path.join(root, "state.sqlite") });
    const database = handle.db;
    const storeKey = "job-json-topology";
    const job = makeCronJob({ id: "job-json" });
    const extendedJob = { ...job, additiveConfig: { mode: "future" } } as CronJob;
    try {
      expect(
        replaceCronRows(
          database,
          storeKey,
          { version: 1, jobs: [extendedJob] },
          {
            bumpStoreEpoch: true,
          },
        ),
      ).toBe(1);
      expect(
        replaceCronRows(
          database,
          storeKey,
          { version: 1, jobs: [job] },
          {
            bumpStoreEpoch: true,
          },
        ),
      ).toBe(2);
    } finally {
      handle.walMaintenance.close();
      database.close();
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("preserves an explicit null owner through load and legacy-owner adoption", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-cron-null-owner-"));
    const handle = openOpenClawStateDatabase({ path: path.join(root, "state.sqlite") });
    const database = handle.db;
    const storeKey = "null-owner";
    const job = makeCronJob({ id: "null-owner" });
    try {
      replaceCronRows(database, storeKey, { version: 1, jobs: [job] });
      const row = loadCronRows(database, storeKey)[0];
      if (!row) {
        throw new Error("missing cron row fixture");
      }
      const jobJson = JSON.parse(row.job_json) as Record<string, unknown>;
      jobJson.agentId = null;
      database
        .prepare("UPDATE cron_jobs SET agent_id = NULL, job_json = ? WHERE store_key = ?")
        .run(JSON.stringify(jobJson), storeKey);

      const loaded = loadedCronStoreFromRows(loadCronRows(database, storeKey)).store.jobs[0];
      expect(loaded && Object.hasOwn(loaded, "agentId")).toBe(true);
      expect((loaded as unknown as { agentId: unknown }).agentId).toBeNull();
      expect(materializeCronRowAgentOwners(database, storeKey, "ops")).toBe(0);

      const unchangedRow = loadCronRows(database, storeKey)[0];
      expect(unchangedRow?.agent_id).toBeNull();
      expect(JSON.parse(unchangedRow?.job_json ?? "{}")).toHaveProperty("agentId", null);
    } finally {
      handle.walMaintenance.close();
      database.close();
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("preserves newer state-only runtime values across a stale full replacement", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-cron-runtime-revision-"));
    const handle = openOpenClawStateDatabase({ path: path.join(root, "state.sqlite") });
    const database = handle.db;
    const storeKey = "runtime-revision";
    const job = makeCronJob({ id: "runtime-revision-job" });
    const staleStore = { version: 1 as const, jobs: [structuredClone(job)] };
    const runtimeNextRunAtMs = job.updatedAtMs + 60_000;
    try {
      replaceCronRows(database, storeKey, staleStore, { bumpStoreEpoch: true });
      const epoch = readCronStoreEpoch(database, storeKey);
      const runtimeRevision = readCronRuntimeRevision(database, storeKey);
      const runtimeBaseline = new Map([[job.id, structuredClone(job.state)]]);
      updateCronRuntimeRows(database, storeKey, {
        version: 1,
        jobs: [
          {
            ...job,
            state: { nextRunAtMs: runtimeNextRunAtMs, lastStatus: "ok" },
          },
        ],
      });

      expect(() =>
        replaceCronRows(
          database,
          storeKey,
          { version: 1, jobs: [{ ...staleStore.jobs[0]!, name: "ambiguous rename" }] },
          {
            expectedStoreEpoch: epoch,
            expectedRuntimeRevision: runtimeRevision,
            bumpStoreEpoch: true,
          },
        ),
      ).toThrow(CronRuntimeRevisionMismatchError);

      expect(
        replaceCronRows(
          database,
          storeKey,
          {
            version: 1,
            jobs: [
              {
                ...staleStore.jobs[0]!,
                name: "renamed job",
                updatedAtMs: job.updatedAtMs + 30_000,
              },
            ],
          },
          {
            expectedStoreEpoch: epoch,
            expectedRuntimeRevision: runtimeRevision,
            expectedRuntimeStateByJobId: runtimeBaseline,
            bumpStoreEpoch: true,
          },
        ),
      ).toBe(epoch + 1);
      const renamed = loadedCronStoreFromRows(loadCronRows(database, storeKey), epoch + 1).store
        .jobs[0];
      expect(renamed?.name).toBe("renamed job");
      expect(renamed?.updatedAtMs).toBe(job.updatedAtMs + 30_000);
      expect(renamed?.state).toMatchObject({
        nextRunAtMs: runtimeNextRunAtMs,
        lastStatus: "ok",
      });

      const renamedRevision = readCronRuntimeRevision(database, storeKey);
      const renamedRuntimeBaseline = new Map([[renamed!.id, structuredClone(renamed!.state)]]);
      updateCronRuntimeRows(database, storeKey, {
        version: 1,
        jobs: [{ ...renamed!, state: { nextRunAtMs: runtimeNextRunAtMs + 60_000 } }],
      });
      replaceCronRows(
        database,
        storeKey,
        {
          version: 1,
          jobs: [
            {
              ...renamed!,
              schedule: { kind: "every", everyMs: 120_000 },
              state: {},
            },
          ],
        },
        {
          expectedStoreEpoch: epoch + 1,
          expectedRuntimeRevision: renamedRevision,
          expectedRuntimeStateByJobId: renamedRuntimeBaseline,
          bumpStoreEpoch: true,
        },
      );
      expect(
        loadedCronStoreFromRows(loadCronRows(database, storeKey)).store.jobs[0]?.state,
      ).toEqual({});
    } finally {
      handle.walMaintenance.close();
      database.close();
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("assigns distinct epochs to concurrent row writes from independent processes", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-cron-epoch-"));
    const databasePath = path.join(root, "state.sqlite");
    openOpenClawStateDatabase({ path: databasePath });
    closeOpenClawStateDatabaseByPath(databasePath);
    const storeKey = "cron-epoch-test";
    try {
      const results = await Promise.all(
        ["first", "second"].map((jobId) =>
          execFileAsync(
            process.execPath,
            [
              "--import",
              "tsx",
              "--input-type=module",
              "-e",
              concurrentWriterSource,
              databasePath,
              jobId,
            ],
            { cwd: process.cwd() },
          ),
        ),
      );
      expect(results.map(({ stdout }) => Number(stdout)).toSorted((a, b) => a - b)).toEqual([1, 2]);

      const database = new DatabaseSync(databasePath);
      try {
        expect(readCronStoreEpoch(database, storeKey)).toBe(2);
      } finally {
        database.close();
      }
    } finally {
      closeOpenClawStateDatabaseByPath(databasePath);
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
