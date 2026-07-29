import { uniqueStrings } from "@openclaw/normalization-core/string-normalization";
import type { Selectable } from "kysely";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
} from "../../infra/kysely-sync.js";
import { withOpenClawAgentDatabaseReadOnly } from "../../state/openclaw-agent-db-readonly.js";
import type { DB as OpenClawAgentKyselyDatabase } from "../../state/openclaw-agent-db.generated.js";
import {
  openOpenClawAgentDatabase,
  type OpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import type { SessionEntrySummary } from "./session-accessor.sqlite-contract.js";
import { readSqliteSessionGenerationIdsForKeys } from "./session-accessor.sqlite-lifecycle-state.js";
import {
  copySessionNodeArtifactsForRepair,
  deleteSessionNodeArtifacts,
} from "./session-accessor.sqlite-node-artifacts.js";
import { collectSqliteSessionStateIdsForEntry } from "./session-accessor.sqlite-references.js";
import {
  getSessionKysely,
  resolveSqliteScope,
  resolveSqliteStoreScope,
  toDatabaseOptions,
} from "./session-accessor.sqlite-scope.js";
import {
  deriveSqliteSessionTitle,
  refreshSqliteSessionTitleProjection,
} from "./session-accessor.sqlite-session-row.js";
import { parseSqliteSessionEntryJson } from "./session-accessor.sqlite-status.js";
import type { SessionEntryListScope } from "./session-accessor.types.js";
import {
  deleteSessionTranscriptIndexInTransaction,
  reconcileSessionTranscriptIndexInTransaction,
} from "./session-transcript-index.js";
import { normalizeStoreSessionKey } from "./store-entry.js";
import type { SessionEntry } from "./types.js";

// Doctor-only cross-store transfer. Runtime readers never reconcile aliases.

function resolveSqliteCanonicalRepairLookupKeys(
  canonicalKey: string,
  storedKeys: readonly string[],
): string[] {
  return uniqueStrings([
    canonicalKey,
    ...storedKeys.filter((key) => key.length > 0),
    ...storedKeys.flatMap((key) => {
      const trimmedKey = key.trim();
      return [trimmedKey, normalizeStoreSessionKey(trimmedKey)];
    }),
  ]).filter(Boolean);
}

/** Doctor-only cross-store copy; the source node remains until lifecycle archival succeeds. */
export function copySqliteSessionOwnedStateForCanonicalRepair(params: {
  canonicalKey: string;
  destinationDatabase: OpenClawAgentDatabase;
  preferSource: boolean;
  preferredEntry?: SessionEntry;
  preferredSessionKey?: string;
  source: { agentId: string; storePath: string };
  sourceEntries: readonly SessionEntry[];
  sourceKeys: readonly string[];
}): void {
  const source = resolveSqliteStoreScope(params.source.storePath, {
    agentId: params.source.agentId,
  });
  const sourceDatabase = openOpenClawAgentDatabase(toDatabaseOptions(source));
  copySqliteSessionOwnedStateForRepair({
    canonicalKey: params.canonicalKey,
    destination: params.destinationDatabase,
    preferSource: params.preferSource,
    ...(params.preferredEntry ? { preferredEntry: params.preferredEntry } : {}),
    ...(params.preferredSessionKey ? { preferredSessionKey: params.preferredSessionKey } : {}),
    source: sourceDatabase,
    sourceEntries: params.sourceEntries,
    sourceKeys: params.sourceKeys,
  });
}

/** Doctor-only inventory of every generation copied for one canonical-key group. */
export function listSqliteSessionGenerationIdsForCanonicalRepair(params: {
  agentId: string;
  canonicalKey: string;
  sourceKeys: readonly string[];
  storePath: string;
}): string[] {
  const source = resolveSqliteStoreScope(params.storePath, { agentId: params.agentId });
  const database = openOpenClawAgentDatabase(toDatabaseOptions(source));
  return readSqliteSessionGenerationIdsForKeys(
    database,
    resolveSqliteCanonicalRepairLookupKeys(params.canonicalKey, params.sourceKeys),
    { exactStoredKeys: true },
  );
}

/** Doctor inventory hydrates legacy blobs from promoted identity/timestamp columns. */
export function listSqliteSessionEntriesForCanonicalRepair(
  scope: SessionEntryListScope = {},
): Array<SessionEntrySummary & { rawEntryJson?: string }> {
  const resolved = resolveSqliteScope({ ...scope, sessionKey: "" });
  const result = withOpenClawAgentDatabaseReadOnly((database) => {
    const db = getSessionKysely(database.db);
    return executeSqliteQuerySync(
      database.db,
      db
        .selectFrom("session_nodes")
        .select(["session_key", "current_session_id", "entry_json", "updated_at"]),
    ).rows.flatMap((row) => {
      const persistedEntry = parseSqliteSessionEntryJson(row, false);
      const entry = parseSqliteSessionEntryJson(row, true);
      const rawCompareRequired =
        !persistedEntry || JSON.stringify(persistedEntry) !== JSON.stringify(entry);
      return [
        {
          sessionKey: row.session_key,
          entry: entry ?? { sessionId: row.current_session_id, updatedAt: row.updated_at },
          ...(rawCompareRequired ? { rawEntryJson: row.entry_json } : {}),
        },
      ];
    });
  }, toDatabaseOptions(resolved));
  return result.found ? result.value : [];
}

function copySqliteSessionOwnedStateForRepair(params: {
  canonicalKey: string;
  destination: OpenClawAgentDatabase;
  preferSource: boolean;
  preferredEntry?: SessionEntry;
  preferredSessionKey?: string;
  source: OpenClawAgentDatabase;
  sourceEntries: readonly SessionEntry[];
  sourceKeys: readonly string[];
}): void {
  const storedSourceKeys = uniqueStrings(params.sourceKeys.filter((key) => key.length > 0));
  if (storedSourceKeys.length === 0) {
    return;
  }
  const sourceKeys = resolveSqliteCanonicalRepairLookupKeys(params.canonicalKey, storedSourceKeys);
  const sourceDb = getSessionKysely(params.source.db);
  const destinationDb = getSessionKysely(params.destination.db);
  const entrySessionIds = uniqueStrings(
    params.sourceEntries.flatMap((entry) => [...collectSqliteSessionStateIdsForEntry(entry)]),
  );
  const windows = executeSqliteQuerySync(
    params.source.db,
    sourceDb
      .selectFrom("session_windows")
      .selectAll()
      .where((eb) =>
        entrySessionIds.length === 0
          ? eb("session_key", "in", sourceKeys)
          : eb.or([eb("session_key", "in", sourceKeys), eb("session_id", "in", entrySessionIds)]),
      ),
  ).rows;
  const sessionIds = uniqueStrings([...windows.map((row) => row.session_id), ...entrySessionIds]);
  const existingDestinationSessionIds = new Set(
    sessionIds.length === 0
      ? []
      : executeSqliteQuerySync(
          params.destination.db,
          destinationDb
            .selectFrom("session_windows")
            .select("session_id")
            .where("session_id", "in", sessionIds),
        ).rows.map((row) => row.session_id),
  );
  const authoritativeSourceSessionIds = new Set([
    ...windows.map((row) => row.session_id),
    ...(params.preferredEntry?.sessionId ? [params.preferredEntry.sessionId] : []),
  ]);
  const sessionLinks =
    sessionIds.length === 0
      ? []
      : executeSqliteQuerySync(
          params.source.db,
          sourceDb
            .selectFrom("session_conversations")
            .selectAll()
            .where("session_id", "in", sessionIds),
        ).rows;
  const linkedConversationIds = uniqueStrings([
    ...windows.flatMap((row) => (row.primary_conversation_id ? [row.primary_conversation_id] : [])),
    ...sessionLinks.map((row) => row.conversation_id),
  ]);
  const sourceKeyReferences = new Set(sourceKeys.flatMap((key) => [key, key.trim()]));
  const deliverySourceKeys = [...sourceKeyReferences].filter(Boolean);
  const deliveries = executeSqliteQuerySync(
    params.source.db,
    sourceDb
      .selectFrom("conversation_deliveries")
      .selectAll()
      .where((eb) =>
        linkedConversationIds.length > 0
          ? eb.or([
              eb("conversation_id", "in", linkedConversationIds),
              eb("source_session_key", "in", deliverySourceKeys),
            ])
          : eb("source_session_key", "in", deliverySourceKeys),
      ),
  ).rows;
  const conversationIds = uniqueStrings([
    ...linkedConversationIds,
    ...deliveries.map((delivery) => delivery.conversation_id),
  ]);
  if (conversationIds.length > 0) {
    const conversations = executeSqliteQuerySync(
      params.source.db,
      sourceDb
        .selectFrom("conversations")
        .selectAll()
        .where("conversation_id", "in", conversationIds),
    ).rows;
    for (const conversation of conversations) {
      const { conversation_id: _conversationId, ...replacement } = conversation;
      executeSqliteQuerySync(
        params.destination.db,
        destinationDb
          .insertInto("conversations")
          .values(conversation)
          // conversation_id hashes the same fields as the natural unique identity.
          .onConflict((conflict) =>
            params.preferSource
              ? conflict.column("conversation_id").doUpdateSet(replacement)
              : conflict.column("conversation_id").doNothing(),
          ),
      );
    }
    for (const delivery of deliveries) {
      const canonicalDelivery = {
        ...delivery,
        source_session_key:
          delivery.source_session_key && sourceKeyReferences.has(delivery.source_session_key)
            ? params.canonicalKey
            : delivery.source_session_key,
      };
      const { operation_id: _operationId, ...replacement } = canonicalDelivery;
      executeSqliteQuerySync(
        params.destination.db,
        destinationDb
          .insertInto("conversation_deliveries")
          .values(canonicalDelivery)
          .onConflict((conflict) =>
            params.preferSource
              ? conflict.column("operation_id").doUpdateSet(replacement)
              : conflict.column("operation_id").doNothing(),
          ),
      );
    }
  }
  for (const window of windows) {
    const canonicalWindow = {
      ...window,
      session_key: params.canonicalKey,
      parent_session_key:
        window.parent_session_key && sourceKeyReferences.has(window.parent_session_key)
          ? params.canonicalKey
          : window.parent_session_key,
      spawned_by:
        window.spawned_by && sourceKeyReferences.has(window.spawned_by)
          ? params.canonicalKey
          : window.spawned_by,
    };
    const { session_id: _sessionId, ...replacement } = {
      ...canonicalWindow,
    };
    executeSqliteQuerySync(
      params.destination.db,
      destinationDb
        .insertInto("session_windows")
        .values(canonicalWindow)
        .onConflict((conflict) =>
          params.preferSource
            ? conflict.column("session_id").doUpdateSet(replacement)
            : conflict.column("session_id").doNothing(),
        ),
    );
  }
  const copiedWindowIds = new Set(windows.map((row) => row.session_id));
  for (const sessionId of entrySessionIds) {
    if (copiedWindowIds.has(sessionId)) {
      continue;
    }
    const entry =
      (params.preferredEntry?.sessionId === sessionId ? params.preferredEntry : undefined) ??
      params.sourceEntries.find((candidate) => candidate.sessionId === sessionId) ??
      params.sourceEntries.find((candidate) =>
        new Set(collectSqliteSessionStateIdsForEntry(candidate)).has(sessionId),
      );
    const updatedAt = entry?.updatedAt ?? Date.now();
    const recoveryWindow = {
      session_key: params.canonicalKey,
      previous_session_id:
        entry?.sessionId === sessionId ? (entry.previousSessionId ?? null) : null,
      reason: "recovery",
      session_scope: "conversation",
      created_at: updatedAt,
      updated_at: updatedAt,
    } as const;
    executeSqliteQuerySync(
      params.destination.db,
      destinationDb
        .insertInto("session_windows")
        .values({
          session_id: sessionId,
          ...recoveryWindow,
        })
        .onConflict((conflict) =>
          params.preferSource && entry?.sessionId === sessionId
            ? conflict.column("session_id").doUpdateSet(recoveryWindow)
            : conflict.column("session_id").doNothing(),
        ),
    );
  }
  const sourceConversationSessionIds = uniqueStrings([
    ...windows.map((row) => row.session_id),
    ...sessionLinks.map((row) => row.session_id),
  ]).filter((sessionId) => authoritativeSourceSessionIds.has(sessionId));
  if (params.preferSource && sourceConversationSessionIds.length > 0) {
    executeSqliteQuerySync(
      params.destination.db,
      destinationDb
        .deleteFrom("session_conversations")
        .where("session_id", "in", sourceConversationSessionIds),
    );
  }
  for (const link of sessionLinks) {
    if (
      existingDestinationSessionIds.has(link.session_id) &&
      (!params.preferSource || !authoritativeSourceSessionIds.has(link.session_id))
    ) {
      continue;
    }
    executeSqliteQuerySync(
      params.destination.db,
      destinationDb
        .insertInto("session_conversations")
        .values(link)
        .onConflict((conflict) => conflict.doNothing()),
    );
  }
  for (const sessionId of sessionIds) {
    const sourceIsAuthoritative = authoritativeSourceSessionIds.has(sessionId);
    const copyTranscripts = !(
      existingDestinationSessionIds.has(sessionId) &&
      (!params.preferSource || !sourceIsAuthoritative) &&
      hasSqliteSessionTranscriptContent(params.destination, sessionId)
    );
    copySqliteSessionGenerationRows({
      copyTranscripts,
      destination: params.destination,
      preferSource: params.preferSource,
      sessionId,
      source: params.source,
      sourceIsAuthoritative,
    });
    if (copyTranscripts) {
      // Search and active-event tables are derived from transcript_events; force their canonical rebuild.
      deleteSessionTranscriptIndexInTransaction(params.destination.db, sessionId);
      reconcileSessionTranscriptIndexInTransaction(params.destination.db, sessionId);
      refreshSqliteSessionTitleProjection(params.destination.db, sessionId);
    }
  }
  if (params.preferSource) {
    // Node artifacts follow the selected winner; merging loser memberships can restore access.
    deleteSessionNodeArtifacts(params.destination, params.canonicalKey);
    copySessionNodeArtifactsForRepair(
      params.source,
      params.destination,
      params.preferredSessionKey ? [params.preferredSessionKey] : sourceKeys,
      params.canonicalKey,
    );
    if (params.preferredEntry && params.preferredSessionKey) {
      const sourceTitle = executeSqliteQueryTakeFirstSync(
        params.source.db,
        sourceDb
          .selectFrom("session_nodes")
          .select("display_name")
          .where("session_key", "=", params.preferredSessionKey),
      )?.display_name;
      const derivedTitle = deriveSqliteSessionTitle(params.source.db, params.preferredEntry);
      executeSqliteQuerySync(
        params.destination.db,
        destinationDb
          .updateTable("session_nodes")
          .set({ display_name: sourceTitle ?? derivedTitle })
          .where("session_key", "=", params.canonicalKey),
      );
    }
  }
}

function mergeTrajectoryRuntimeEvents(
  destination: OpenClawAgentDatabase,
  rows: readonly Selectable<OpenClawAgentKyselyDatabase["trajectory_runtime_events"]>[],
  sessionId: string,
): void {
  const db = getSessionKysely(destination.db);
  const existing = executeSqliteQuerySync(
    destination.db,
    db.selectFrom("trajectory_runtime_events").selectAll().where("session_id", "=", sessionId),
  ).rows;
  const bySeq = new Map(existing.map((row) => [row.seq, row]));
  const identity = (row: (typeof existing)[number]) =>
    JSON.stringify([row.run_id, row.created_at, row.event_json]);
  const destinationCounts = new Map<string, number>();
  for (const row of existing) {
    const key = identity(row);
    destinationCounts.set(key, (destinationCounts.get(key) ?? 0) + 1);
  }
  const sourceCounts = new Map<string, number>();
  for (const row of rows) {
    const key = identity(row);
    sourceCounts.set(key, (sourceCounts.get(key) ?? 0) + 1);
  }
  const remainingByIdentity = new Map(
    [...sourceCounts].map(([key, count]) => [
      key,
      Math.max(0, count - (destinationCounts.get(key) ?? 0)),
    ]),
  );
  let nextSeq = 0;
  for (const row of existing) {
    nextSeq = Math.max(nextSeq, row.seq + 1);
  }
  let remapping = false;
  for (const row of rows.toSorted((left, right) => left.seq - right.seq)) {
    const key = identity(row);
    const original = bySeq.get(row.seq);
    if (original && identity(original) !== key) {
      remapping = true;
    }
    const remaining = remainingByIdentity.get(key) ?? 0;
    if (remaining <= 0) {
      continue;
    }
    remapping ||= bySeq.has(row.seq);
    if (remapping) {
      while (bySeq.has(nextSeq)) {
        nextSeq += 1;
      }
    }
    const seq = remapping ? nextSeq : row.seq;
    const merged = { ...row, seq };
    executeSqliteQuerySync(
      destination.db,
      db.insertInto("trajectory_runtime_events").values(merged),
    );
    bySeq.set(seq, merged);
    remainingByIdentity.set(key, remaining - 1);
    nextSeq = Math.max(nextSeq, seq + 1);
  }
}

function mergeAcpParentStreamEvents(
  destination: OpenClawAgentDatabase,
  rows: readonly Selectable<OpenClawAgentKyselyDatabase["acp_parent_stream_events"]>[],
  sessionId: string,
): void {
  const db = getSessionKysely(destination.db);
  const existing = executeSqliteQuerySync(
    destination.db,
    db.selectFrom("acp_parent_stream_events").selectAll().where("session_id", "=", sessionId),
  ).rows;
  const eventKey = (runId: string, seq: number) => `${runId}\0${seq}`;
  const byKey = new Map(existing.map((row) => [eventKey(row.run_id, row.seq), row]));
  const identity = (row: (typeof existing)[number]) =>
    JSON.stringify([row.run_id, row.created_at, row.event_json]);
  const destinationCounts = new Map<string, number>();
  for (const row of existing) {
    const key = identity(row);
    destinationCounts.set(key, (destinationCounts.get(key) ?? 0) + 1);
  }
  const sourceCounts = new Map<string, number>();
  for (const row of rows) {
    const key = identity(row);
    sourceCounts.set(key, (sourceCounts.get(key) ?? 0) + 1);
  }
  const remainingByIdentity = new Map(
    [...sourceCounts].map(([key, count]) => [
      key,
      Math.max(0, count - (destinationCounts.get(key) ?? 0)),
    ]),
  );
  const nextSeqByRun = new Map<string, number>();
  for (const row of existing) {
    nextSeqByRun.set(row.run_id, Math.max(nextSeqByRun.get(row.run_id) ?? 0, row.seq + 1));
  }
  const remappedRuns = new Set<string>();
  for (const row of rows.toSorted((left, right) => {
    const byRun = left.run_id.localeCompare(right.run_id);
    return byRun || left.seq - right.seq;
  })) {
    const key = identity(row);
    const original = byKey.get(eventKey(row.run_id, row.seq));
    if (original && identity(original) !== key) {
      remappedRuns.add(row.run_id);
    }
    const remaining = remainingByIdentity.get(key) ?? 0;
    if (remaining <= 0) {
      continue;
    }
    if (byKey.has(eventKey(row.run_id, row.seq))) {
      remappedRuns.add(row.run_id);
    }
    let nextSeq = nextSeqByRun.get(row.run_id) ?? 0;
    if (remappedRuns.has(row.run_id)) {
      while (byKey.has(eventKey(row.run_id, nextSeq))) {
        nextSeq += 1;
      }
    }
    const seq = remappedRuns.has(row.run_id) ? nextSeq : row.seq;
    nextSeqByRun.set(row.run_id, Math.max(nextSeqByRun.get(row.run_id) ?? 0, seq + 1));
    const merged = { ...row, seq };
    executeSqliteQuerySync(
      destination.db,
      db.insertInto("acp_parent_stream_events").values(merged),
    );
    byKey.set(eventKey(row.run_id, seq), merged);
    remainingByIdentity.set(key, remaining - 1);
  }
}

function copySqliteSessionGenerationRows(params: {
  copyTranscripts: boolean;
  destination: OpenClawAgentDatabase;
  preferSource: boolean;
  sessionId: string;
  source: OpenClawAgentDatabase;
  sourceIsAuthoritative: boolean;
}): void {
  const sourceDb = getSessionKysely(params.source.db);
  const destinationDb = getSessionKysely(params.destination.db);
  const transcriptEvents = executeSqliteQuerySync(
    params.source.db,
    sourceDb.selectFrom("transcript_events").selectAll().where("session_id", "=", params.sessionId),
  ).rows;
  const transcriptIdentities = executeSqliteQuerySync(
    params.source.db,
    sourceDb
      .selectFrom("transcript_event_identities")
      .selectAll()
      .where("session_id", "=", params.sessionId),
  ).rows;
  const rewriteWatermarks = executeSqliteQuerySync(
    params.source.db,
    sourceDb
      .selectFrom("transcript_rewrite_watermarks")
      .selectAll()
      .where("session_id", "=", params.sessionId),
  ).rows;
  const trajectoryEvents = executeSqliteQuerySync(
    params.source.db,
    sourceDb
      .selectFrom("trajectory_runtime_events")
      .selectAll()
      .where("session_id", "=", params.sessionId),
  ).rows;
  const parentStreamEvents = executeSqliteQuerySync(
    params.source.db,
    sourceDb
      .selectFrom("acp_parent_stream_events")
      .selectAll()
      .where("session_id", "=", params.sessionId),
  ).rows;
  // Cross-store rows have no deletion tombstone. Empty winner tables cannot authorize
  // destructive loss, so doctor replaces only tables backed by winner rows.
  if (
    params.copyTranscripts &&
    params.preferSource &&
    params.sourceIsAuthoritative &&
    transcriptEvents.length > 0
  ) {
    executeSqliteQuerySync(
      params.destination.db,
      destinationDb
        .deleteFrom("transcript_event_identities")
        .where("session_id", "=", params.sessionId),
    );
    executeSqliteQuerySync(
      params.destination.db,
      destinationDb.deleteFrom("transcript_events").where("session_id", "=", params.sessionId),
    );
  }
  if (
    params.copyTranscripts &&
    params.preferSource &&
    params.sourceIsAuthoritative &&
    (transcriptEvents.length > 0 || rewriteWatermarks.length > 0)
  ) {
    executeSqliteQuerySync(
      params.destination.db,
      destinationDb
        .deleteFrom("transcript_rewrite_watermarks")
        .where("session_id", "=", params.sessionId),
    );
  }
  if (params.copyTranscripts) {
    for (const row of transcriptEvents) {
      executeSqliteQuerySync(
        params.destination.db,
        destinationDb
          .insertInto("transcript_events")
          .values(row)
          .onConflict((conflict) => conflict.doNothing()),
      );
    }
    for (const row of transcriptIdentities) {
      executeSqliteQuerySync(
        params.destination.db,
        destinationDb
          .insertInto("transcript_event_identities")
          .values(row)
          .onConflict((conflict) => conflict.doNothing()),
      );
    }
    for (const row of rewriteWatermarks) {
      executeSqliteQuerySync(
        params.destination.db,
        destinationDb
          .insertInto("transcript_rewrite_watermarks")
          .values(row)
          .onConflict((conflict) => conflict.doNothing()),
      );
    }
  }
  mergeTrajectoryRuntimeEvents(params.destination, trajectoryEvents, params.sessionId);
  mergeAcpParentStreamEvents(params.destination, parentStreamEvents, params.sessionId);
}

function hasSqliteSessionTranscriptContent(
  database: OpenClawAgentDatabase,
  sessionId: string,
): boolean {
  const db = getSessionKysely(database.db);
  return (
    executeSqliteQueryTakeFirstSync(
      database.db,
      db.selectFrom("transcript_events").select("seq").where("session_id", "=", sessionId).limit(1),
    ) !== undefined
  );
}
