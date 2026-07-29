import path from "node:path";
import { runOpenClawStateWriteTransaction } from "../../state/openclaw-state-db.js";
import { materializeLegacyDefaultCronJobOwnersInRecords } from "../legacy-default-agent-owner-records.js";
import type { CronJob } from "../types.js";
import { cronStoreKey } from "./key.js";
import {
  loadedCronStoreFromRows,
  loadCronRowsWithEpoch,
  materializeCronRowAgentOwners,
  upsertCronJobRow,
} from "./row-codec.js";

/** Materializes known rows and imports legacy-file jobs without replacing unrelated raw rows. */
export async function materializeCronJobsStoreOwners(params: {
  storePath: string;
  legacyDefaultAgentId: string;
  records: CronJob[];
  legacyImportedJobIds: ReadonlySet<string>;
  expectedStoreEpoch?: number;
  env?: NodeJS.ProcessEnv;
}): Promise<{ matched: boolean; rewritten: number }> {
  const storeKey = cronStoreKey(path.resolve(params.storePath));
  return runOpenClawStateWriteTransaction(
    ({ db }) => {
      const { rows, storeEpoch } = loadCronRowsWithEpoch(db, storeKey);
      if (params.expectedStoreEpoch !== undefined && params.expectedStoreEpoch !== storeEpoch) {
        return { matched: false, rewritten: 0 };
      }
      const existingJobIds = new Set(rows.map((row) => row.job_id));
      const decodedCurrentJobIds = new Set(
        loadedCronStoreFromRows(rows).store.jobs.map((job) => job.id),
      );
      const persistedJobIds = new Set(
        params.records
          .filter((record) => decodedCurrentJobIds.has(record.id))
          .map((record) => record.id),
      );
      // Both row helpers advance the partition epoch inside this outer transaction,
      // so stale full-store writers cannot overwrite ownership or imported rows.
      let rewritten = materializeCronRowAgentOwners(db, storeKey, params.legacyDefaultAgentId, {
        jobIds: persistedJobIds,
      });
      let sortOrder = rows.reduce((maximum, row) => Math.max(maximum, row.sort_order), -1) + 1;
      for (const record of params.records) {
        if (!params.legacyImportedJobIds.has(record.id)) {
          continue;
        }
        if (existingJobIds.has(record.id)) {
          if (!decodedCurrentJobIds.has(record.id)) {
            throw new Error(
              `Cannot import legacy cron job "${record.id}": an undecodable SQLite row already uses that id`,
            );
          }
          continue;
        }
        const importedRecord = structuredClone(record);
        materializeLegacyDefaultCronJobOwnersInRecords(
          [importedRecord as unknown as Record<string, unknown>],
          params.legacyDefaultAgentId,
        );
        upsertCronJobRow(db, storeKey, importedRecord, sortOrder++);
        existingJobIds.add(record.id);
        rewritten += 1;
      }
      return { matched: true, rewritten };
    },
    { env: params.env },
  );
}
