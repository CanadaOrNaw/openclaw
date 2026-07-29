import type { DatabaseSync } from "node:sqlite";
import { executeSqliteQuerySync } from "../../infra/kysely-sync.js";
import type { CronJob, CronStoreFile } from "../types.js";
import { resolveCronRuntimeDelta } from "./runtime-merge.js";
import { getCronStoreKysely } from "./schema.js";
import { bindStateColumns, stateFromRow } from "./state-codec.js";

/** Applies state-only writes as per-job deltas when another process advanced the partition. */
export function writeCronRuntimeRowDeltas(params: {
  db: DatabaseSync;
  storeKey: string;
  store: CronStoreFile;
  expectedRuntimeRevision?: number;
  currentRuntimeRevision?: number;
  expectedRuntimeStateByJobId?: ReadonlyMap<string, CronJob["state"]>;
  conflictError: () => Error;
  incrementRevision: () => number;
}): number {
  const revisionChanged =
    params.expectedRuntimeRevision !== undefined &&
    params.currentRuntimeRevision !== undefined &&
    params.expectedRuntimeRevision !== params.currentRuntimeRevision;
  const currentStates = revisionChanged
    ? new Map(
        executeSqliteQuerySync(
          params.db,
          getCronStoreKysely(params.db)
            .selectFrom("cron_jobs")
            .selectAll()
            .where("store_key", "=", params.storeKey),
        ).rows.map((row) => [row.job_id, stateFromRow(row)]),
      )
    : undefined;
  // The caller owns the shared-state write transaction, so a later conflict
  // rolls back earlier row updates. Topology epochs fence schedule changes;
  // runtime-only writes must not rewrite topology-derived sidecars.
  for (const job of params.store.jobs) {
    if (revisionChanged) {
      const current = currentStates?.get(job.id);
      const expected = params.expectedRuntimeStateByJobId?.get(job.id);
      if (!current || expected === undefined) {
        throw params.conflictError();
      }
      const resolution = resolveCronRuntimeDelta({ current, next: job.state ?? {}, expected });
      if (resolution === "conflict") {
        throw params.conflictError();
      }
      if (resolution === "preserve") {
        job.state = structuredClone(current);
        continue;
      }
    }
    executeSqliteQuerySync(
      params.db,
      getCronStoreKysely(params.db)
        .updateTable("cron_jobs")
        .set({
          ...bindStateColumns(job.state ?? {}),
          state_json: JSON.stringify(job.state ?? {}),
          runtime_updated_at_ms: job.updatedAtMs,
        })
        .where("store_key", "=", params.storeKey)
        .where("job_id", "=", job.id),
    );
  }
  return params.incrementRevision();
}
