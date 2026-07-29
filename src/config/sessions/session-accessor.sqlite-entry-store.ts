import { uniqueStrings } from "@openclaw/normalization-core/string-normalization";
import type { Selectable } from "kysely";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
} from "../../infra/kysely-sync.js";
import type { DB as OpenClawAgentKyselyDatabase } from "../../state/openclaw-agent-db.generated.js";
import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import {
  linkSessionConversation,
  prepareSessionConversation,
  upsertConversationIdentity,
} from "./session-accessor.sqlite-conversation.js";
import { publishSqliteSessionEntryCacheInvalidation } from "./session-accessor.sqlite-entry-cache.js";
import {
  clearSessionCollaborationForKey,
  copySessionNodeArtifactsForRepair,
  deleteSessionNodeArtifacts,
  rehomeLegacySessionNodeArtifacts,
} from "./session-accessor.sqlite-node-artifacts.js";
import { resolveSessionEntryProvenanceRow } from "./session-accessor.sqlite-provenance.js";
import { collectSqliteSessionStateIdsForEntry } from "./session-accessor.sqlite-references.js";
import {
  cloneSessionEntry,
  getSessionKysely,
  normalizeSqliteSessionKey,
} from "./session-accessor.sqlite-scope.js";
import {
  bindSqliteSessionNode,
  bindSqliteSessionRoot,
  deriveSessionTitle,
  deriveSqliteSessionTitle,
  normalizeSqliteSessionEntryTimestamp,
} from "./session-accessor.sqlite-session-row.js";
import { parseSqliteSessionEntryJson as parseSessionEntryRow } from "./session-accessor.sqlite-status.js";
import { readTranscriptMutationStateInTransaction } from "./session-accessor.sqlite-transcript-state.js";
import {
  assertCanonicalSessionKeyWrite,
  duplicateCanonicalSessionKeyError,
  nonCanonicalSessionKeyRowError,
} from "./session-canonical-key.js";
import { deleteSessionTranscriptIndexInTransaction } from "./session-transcript-index.js";
import {
  foldedSessionKeyAliasCandidates,
  normalizeStoreSessionKey,
  resolveSessionEntryCandidates,
} from "./store-entry.js";
import type { SessionEntry } from "./types.js";

// Canonical owner for session_nodes row selection, alias snapshots, and writes.

type OpenClawAgentDatabaseReader = Pick<OpenClawAgentDatabase, "db">;
const SQLITE_SESSION_KEY_TRIM_CODE_POINTS = [
  9, 10, 11, 12, 13, 32, 160, 5760, 8192, 8193, 8194, 8195, 8196, 8197, 8198, 8199, 8200, 8201,
  8202, 8232, 8233, 8239, 8287, 12288, 65279,
] as const;
type SessionEntryRow = Selectable<OpenClawAgentKyselyDatabase["session_nodes"]>;
export type ResolvedSessionEntryRow = {
  entry: SessionEntry;
  legacyKeys: string[];
  row: SessionEntryRow;
};
type SqliteSessionEntrySelectionSnapshot = {
  selected: ResolvedSessionEntryRow | undefined;
  selectedRows: Array<{ entry: SessionEntry; sessionKey: string }>;
};
type SqliteLifecycleTargetSnapshot = {
  primary: { entry: SessionEntry; key: string } | undefined;
  rows: Array<{ entry: SessionEntry; sessionKey: string }>;
};

class SqliteSessionMutationConflictError extends Error {
  constructor(operationLabel: string) {
    super(`SQLite session state changed while preparing ${operationLabel}`);
    this.name = "SqliteSessionMutationConflictError";
  }
}

export function readSqliteSessionIdentitySnapshot(
  database: OpenClawAgentDatabase,
  sessionKeys: Iterable<string>,
): Map<string, SessionEntry> {
  const snapshot = new Map<string, SessionEntry>();
  for (const sessionKey of uniqueStrings([...sessionKeys].map((key) => key.trim()))) {
    const row = readExactSessionEntryRow(database, sessionKey);
    if (row) {
      snapshot.set(sessionKey, cloneSessionEntry(row.entry));
    }
  }
  return snapshot;
}

export function createSqliteSessionIdentitySnapshot(
  rows: readonly { entry: SessionEntry; sessionKey: string }[],
): Map<string, SessionEntry> {
  return new Map(rows.map((row) => [row.sessionKey, cloneSessionEntry(row.entry)]));
}

export function readSessionEntryRow(
  database: OpenClawAgentDatabaseReader,
  sessionKey: string,
): ResolvedSessionEntryRow | undefined {
  assertNoPaddedSqliteSessionKeyRow(database, sessionKey);
  const db = getSessionKysely(database.db);
  const lookupKeys = collectSessionEntryLookupKeys(database, sessionKey);
  if (lookupKeys.length === 0) {
    return undefined;
  }
  const rows = executeSqliteQuerySync(
    database.db,
    db
      .selectFrom("session_nodes")
      .selectAll()
      .where("session_key", "in", lookupKeys)
      .orderBy("session_key", "asc"),
  ).rows;
  const entries = new Map<string, ResolvedSessionEntryRow>();
  for (const row of rows) {
    const entry = parseSessionEntryRow(row);
    if (!entry) {
      continue;
    }
    entries.set(row.session_key, { entry, legacyKeys: [], row });
  }
  const resolved = resolveSessionEntryCandidates({
    entries: [...entries].map(([candidateKey, value]) => ({
      entry: value.entry,
      sessionKey: candidateKey,
    })),
    sessionKey,
  });
  if (!resolved.existing) {
    return undefined;
  }
  const selected = entries.get(resolved.existing.sessionKey);
  return selected ? { ...selected, legacyKeys: resolved.legacyKeys } : undefined;
}

function assertNoPaddedSqliteSessionKeyRow(
  database: OpenClawAgentDatabaseReader,
  sessionKey: string,
): void {
  const db = getSessionKysely(database.db);
  const row = executeSqliteQueryTakeFirstSync(
    database.db,
    db
      .selectFrom("session_nodes")
      .select("session_key")
      .where((eb) => {
        const trimmedKey = eb.fn<string>("trim", [
          "session_key",
          eb.fn<string>(
            "char",
            SQLITE_SESSION_KEY_TRIM_CODE_POINTS.map((codePoint) => eb.lit(codePoint)),
          ),
        ]);
        return eb.and([eb(trimmedKey, "=", sessionKey), eb("session_key", "!=", trimmedKey)]);
      })
      .limit(1),
  );
  if (row?.session_key.trim() === sessionKey) {
    throw nonCanonicalSessionKeyRowError(sessionKey);
  }
}

// Async updaters prepare against this complete selection. Capturing alias rows
// prevents the commit phase from deleting a concurrently changed legacy key.
export function readSqliteSessionEntrySelectionSnapshot(
  database: OpenClawAgentDatabase,
  sessionKey: string,
  exact: boolean,
): SqliteSessionEntrySelectionSnapshot {
  const selected = exact
    ? readExactSessionEntryRow(database, sessionKey)
    : readSessionEntryRow(database, sessionKey);
  const selectedKeys = collectSessionEntryLookupKeys(database, sessionKey).toSorted();
  return {
    selected,
    selectedRows: selectedKeys.flatMap((candidateKey) => {
      const row = readExactSessionEntryRow(database, candidateKey);
      return row ? [{ entry: cloneSessionEntry(row.entry), sessionKey: candidateKey }] : [];
    }),
  };
}

export function assertSqliteSessionEntrySelectionUnchanged(
  expected: SqliteSessionEntrySelectionSnapshot,
  current: SqliteSessionEntrySelectionSnapshot,
  operationLabel: string,
): void {
  const selectedMatches =
    expected.selected?.row.session_key === current.selected?.row.session_key &&
    sqliteSessionEntriesEqual(expected.selected?.entry, current.selected?.entry);
  if (
    !selectedMatches ||
    !sqliteSessionSnapshotRowsEqual(expected.selectedRows, current.selectedRows)
  ) {
    throw new SqliteSessionMutationConflictError(operationLabel);
  }
}

export function collectSessionEntryLookupKeys(
  _database: OpenClawAgentDatabaseReader,
  sessionKey: string,
): string[] {
  const trimmedKey = sessionKey.trim();
  if (!trimmedKey) {
    return [];
  }
  const normalizedKey = normalizeStoreSessionKey(trimmedKey);
  // Folded opaque-id candidates retain the shipped case-preservation repair contract. Exact
  // case-sensitive rows still win in resolveSessionEntryCandidates; arbitrary aliases use doctor.
  return uniqueStrings([
    trimmedKey,
    normalizedKey,
    ...foldedSessionKeyAliasCandidates(normalizedKey),
  ]).filter(Boolean);
}

export function readExactSessionEntryRow(
  database: OpenClawAgentDatabaseReader,
  sessionKey: string,
): ResolvedSessionEntryRow | undefined {
  const db = getSessionKysely(database.db);
  const row = executeSqliteQueryTakeFirstSync(
    database.db,
    db.selectFrom("session_nodes").selectAll().where("session_key", "=", sessionKey),
  );
  if (!row) {
    return undefined;
  }
  const entry = parseSessionEntryRow(row);
  return entry ? { entry, legacyKeys: [], row } : undefined;
}

export function readSqliteSessionEntryStore(
  database: OpenClawAgentDatabase,
): Record<string, SessionEntry> {
  const db = getSessionKysely(database.db);
  const rows = executeSqliteQuerySync(
    database.db,
    db.selectFrom("session_nodes").select(["session_key", "entry_json"]).orderBy("session_key"),
  ).rows;
  const store: Record<string, SessionEntry> = {};
  for (const row of rows) {
    const entry = parseSessionEntryRow(row);
    if (entry) {
      store[row.session_key] = entry;
    }
  }
  return store;
}

export function readSqliteSessionEntryCount(database: OpenClawAgentDatabase): number {
  const db = getSessionKysely(database.db);
  const rows = executeSqliteQuerySync(
    database.db,
    db.selectFrom("session_nodes").select("entry_json"),
  ).rows;
  return rows.reduce((count, row) => count + (parseSessionEntryRow(row) ? 1 : 0), 0);
}

/** Lists persisted session keys without materializing their entry payloads. */
export function readSqliteSessionEntryKeys(database: OpenClawAgentDatabaseReader): string[] {
  const db = getSessionKysely(database.db);
  return executeSqliteQuerySync(
    database.db,
    db
      .selectFrom("session_nodes")
      .select(["entry_json", "session_key"])
      .orderBy("session_key", "asc"),
  ).rows.flatMap((row) => (parseSessionEntryRow(row) ? [row.session_key] : []));
}

export function resolveSqliteLifecyclePrimaryEntry(
  database: OpenClawAgentDatabase,
  target: { canonicalKey: string; storeKeys: string[] },
): { key: string; entry: SessionEntry } | undefined {
  const rows = target.storeKeys.flatMap((key) => {
    const sessionKey = key.trim();
    const row = readExactSessionEntryRow(database, sessionKey);
    return row ? [{ key: sessionKey, entry: row.entry }] : [];
  });
  if (rows.length > 1) {
    throw duplicateCanonicalSessionKeyError(target.canonicalKey);
  }
  const [row] = rows;
  if (row && row.key !== target.canonicalKey) {
    throw nonCanonicalSessionKeyRowError(target.canonicalKey);
  }
  return row;
}

export function readSqliteLifecycleTargetSnapshot(
  database: OpenClawAgentDatabase,
  target: { canonicalKey: string; storeKeys: string[] },
): SqliteLifecycleTargetSnapshot {
  const normalized = normalizeSqliteLifecycleTarget(target);
  return {
    primary: resolveSqliteLifecyclePrimaryEntry(database, normalized),
    rows: normalized.storeKeys.flatMap((sessionKey) => {
      const row = readExactSessionEntryRow(database, sessionKey);
      return row ? [{ entry: cloneSessionEntry(row.entry), sessionKey }] : [];
    }),
  };
}

export function assertSqliteLifecycleTargetSnapshotUnchanged(
  expected: SqliteLifecycleTargetSnapshot,
  current: SqliteLifecycleTargetSnapshot,
  operationLabel: string,
): void {
  const primaryMatches =
    expected.primary?.key === current.primary?.key &&
    sqliteSessionEntriesEqual(expected.primary?.entry, current.primary?.entry);
  if (!primaryMatches || !sqliteSessionSnapshotRowsEqual(expected.rows, current.rows)) {
    throw new SqliteSessionMutationConflictError(operationLabel);
  }
}

export function normalizeSqliteLifecycleTarget(target: {
  canonicalKey: string;
  storeKeys: string[];
}): {
  canonicalKey: string;
  storeKeys: string[];
} {
  const canonicalKey = normalizeSqliteSessionKey(target.canonicalKey);
  return {
    canonicalKey,
    storeKeys: uniqueStrings([canonicalKey, ...target.storeKeys.map(normalizeSqliteSessionKey)]),
  };
}

export function deleteSqliteSessionEntryRows(
  database: OpenClawAgentDatabase,
  sessionKey: string,
): void {
  const db = getSessionKysely(database.db);
  const windows = executeSqliteQuerySync(
    database.db,
    db.selectFrom("session_windows").select("session_id").where("session_key", "=", sessionKey),
  ).rows;
  const survivingNodes = executeSqliteQuerySync(
    database.db,
    db
      .selectFrom("session_nodes")
      .select(["current_session_id", "entry_json", "session_key"])
      .where("session_key", "!=", sessionKey)
      .orderBy("session_key", "asc"),
  ).rows;
  for (const window of windows) {
    const survivingNode = survivingNodes.find((node) => {
      if (node.current_session_id === window.session_id) {
        return true;
      }
      const entry = parseSessionEntryRow(node);
      return entry
        ? collectSqliteSessionStateIdsForEntry(entry).includes(window.session_id)
        : false;
    });
    if (survivingNode) {
      executeSqliteQuerySync(
        database.db,
        db
          .updateTable("session_windows")
          .set({ session_key: survivingNode.session_key })
          .where("session_id", "=", window.session_id),
      );
    }
  }
  const remainingWindow = executeSqliteQueryTakeFirstSync(
    database.db,
    db
      .selectFrom("session_windows")
      .select(["session_id", "updated_at"])
      .where("session_key", "=", sessionKey)
      .orderBy("updated_at", "desc")
      .orderBy("session_id", "asc")
      .limit(1),
  );
  if (remainingWindow) {
    deleteSessionNodeArtifacts(database, sessionKey);
    clearSqliteSessionEntryPreservingWindows(database, {
      sessionId: remainingWindow.session_id,
      sessionKey,
      updatedAt: remainingWindow.updated_at,
    });
    publishSqliteSessionEntryCacheInvalidation(database);
    return;
  }
  executeSqliteQuerySync(
    database.db,
    db.deleteFrom("session_nodes").where("session_key", "=", sessionKey),
  );
  publishSqliteSessionEntryCacheInvalidation(database);
}

/** Remove the logical entry while retaining its node-owned transcript windows. */
function clearSqliteSessionEntryPreservingWindows(
  database: OpenClawAgentDatabase,
  params: { sessionId: string; sessionKey: string; updatedAt: number },
): void {
  const db = getSessionKysely(database.db);
  const cleared = {
    current_session_id: params.sessionId,
    entry_json: "{}",
    updated_at: params.updatedAt,
    status: null,
    created_at: null,
    created_via: null,
    created_actor_type: null,
    created_actor_id: null,
    parent_session_key: null,
    spawned_by: null,
    fork_source_session_key: null,
    fork_source_session_id: null,
    fork_source_entry_id: null,
    label: null,
    display_name: null,
    category: null,
    icon: null,
    pinned_at: null,
    archived_at: null,
    last_read_at: null,
    last_interaction_at: null,
    last_activity_at: null,
  } as const;
  executeSqliteQuerySync(
    database.db,
    db
      .insertInto("session_nodes")
      .values({ session_key: params.sessionKey, ...cleared })
      .onConflict((conflict) => conflict.column("session_key").doUpdateSet(cleared)),
  );
}

export function deleteSqliteLifecycleTargetRows(
  database: OpenClawAgentDatabase,
  target: { canonicalKey: string; storeKeys: string[] },
): void {
  for (const sessionKey of uniqueStrings([target.canonicalKey, ...target.storeKeys])) {
    const trimmed = sessionKey.trim();
    if (trimmed) {
      deleteSqliteSessionEntryRows(database, trimmed);
    }
  }
}

export function sqliteSessionEntriesEqual(
  left: SessionEntry | undefined,
  right: SessionEntry | undefined,
): boolean {
  if (!left || !right) {
    return left === right;
  }
  return JSON.stringify(left) === JSON.stringify(right);
}

function sqliteSessionSnapshotRowsEqual(
  left: Array<{ entry: SessionEntry; sessionKey: string }>,
  right: Array<{ entry: SessionEntry; sessionKey: string }>,
): boolean {
  return (
    left.length === right.length &&
    left.every(
      (row, index) =>
        row.sessionKey === right[index]?.sessionKey &&
        sqliteSessionEntriesEqual(row.entry, right[index]?.entry),
    )
  );
}

function sqliteLifecycleTargetMatchesExpectedEntry(
  database: OpenClawAgentDatabase,
  target: { canonicalKey: string; storeKeys: string[] },
  expectedEntry: SessionEntry | undefined,
): boolean {
  const current = resolveSqliteLifecyclePrimaryEntry(database, target)?.entry;
  if (!current || !expectedEntry) {
    return current === expectedEntry;
  }
  return sqliteSessionEntriesEqual(current, expectedEntry);
}

export function assertSqliteLifecycleTargetUnchanged(
  database: OpenClawAgentDatabase,
  target: { canonicalKey: string; storeKeys: string[] },
  expectedEntry: SessionEntry | undefined,
  operation: "deleted" | "reset",
): void {
  if (sqliteLifecycleTargetMatchesExpectedEntry(database, target, expectedEntry)) {
    return;
  }
  throw new Error(`SQLite session entry changed before ${operation} lifecycle mutation`);
}

export function deleteLegacySessionEntryRows(
  database: OpenClawAgentDatabase,
  legacyKeys: string[],
  sessionKey: string,
  options: { rehomeMembers?: boolean } = {},
): void {
  if (legacyKeys.length === 0) {
    return;
  }
  const db = getSessionKysely(database.db);
  for (const legacyKey of legacyKeys) {
    if (legacyKey === sessionKey) {
      continue;
    }
    rehomeSqliteSessionWindows(database, sessionKey, [legacyKey]);
    rehomeLegacySessionNodeArtifacts(database, legacyKey, sessionKey, options);
    executeSqliteQuerySync(
      database.db,
      db.deleteFrom("session_nodes").where("session_key", "=", legacyKey),
    );
    publishSqliteSessionEntryCacheInvalidation(database);
  }
}

/** Move retained generations to the canonical node before removing key aliases. */
export function rehomeSqliteSessionWindows(
  database: OpenClawAgentDatabase,
  canonicalKey: string,
  previousKeys: Iterable<string>,
): void {
  const legacyKeys = uniqueStrings([...previousKeys].map((key) => key.trim())).filter(
    (key) => key && key !== canonicalKey,
  );
  if (legacyKeys.length === 0) {
    return;
  }
  const db = getSessionKysely(database.db);
  executeSqliteQuerySync(
    database.db,
    db
      .updateTable("session_windows")
      .set({ session_key: canonicalKey })
      .where("session_key", "in", legacyKeys),
  );
}

/** Copy every durable generation before doctor removes a cross-database duplicate node. */
export function resolveSqliteCanonicalRepairLookupKeys(
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

export function copySqliteSessionOwnedStateForRepair(params: {
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
  const conversationIds = uniqueStrings([
    ...windows.flatMap((row) => (row.primary_conversation_id ? [row.primary_conversation_id] : [])),
    ...sessionLinks.map((row) => row.conversation_id),
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
  }
  const sourceKeyReferences = new Set(sourceKeys.flatMap((key) => [key, key.trim()]));
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
    if (
      existingDestinationSessionIds.has(sessionId) &&
      (!params.preferSource || !sourceIsAuthoritative) &&
      hasSqliteSessionGenerationContent(params.destination, sessionId)
    ) {
      continue;
    }
    copySqliteSessionGenerationRows({
      destination: params.destination,
      preferSource: params.preferSource,
      sessionId,
      source: params.source,
      sourceIsAuthoritative,
    });
    // Search and active-event tables are derived from transcript_events; force their canonical rebuild.
    deleteSessionTranscriptIndexInTransaction(params.destination.db, sessionId);
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
      executeSqliteQuerySync(
        params.destination.db,
        destinationDb
          .updateTable("session_nodes")
          .set({ display_name: sourceTitle ?? deriveSessionTitle(params.preferredEntry) ?? null })
          .where("session_key", "=", params.canonicalKey),
      );
    }
  }
}

function copySqliteSessionGenerationRows(params: {
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
  if (params.preferSource && params.sourceIsAuthoritative && transcriptEvents.length > 0) {
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
  if (params.preferSource && params.sourceIsAuthoritative && trajectoryEvents.length > 0) {
    executeSqliteQuerySync(
      params.destination.db,
      destinationDb
        .deleteFrom("trajectory_runtime_events")
        .where("session_id", "=", params.sessionId),
    );
  }
  if (params.preferSource && params.sourceIsAuthoritative && parentStreamEvents.length > 0) {
    executeSqliteQuerySync(
      params.destination.db,
      destinationDb
        .deleteFrom("acp_parent_stream_events")
        .where("session_id", "=", params.sessionId),
    );
  }
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
  for (const row of trajectoryEvents) {
    executeSqliteQuerySync(
      params.destination.db,
      destinationDb
        .insertInto("trajectory_runtime_events")
        .values(row)
        .onConflict((conflict) => conflict.doNothing()),
    );
  }
  for (const row of parentStreamEvents) {
    executeSqliteQuerySync(
      params.destination.db,
      destinationDb
        .insertInto("acp_parent_stream_events")
        .values(row)
        .onConflict((conflict) => conflict.doNothing()),
    );
  }
}

function hasSqliteSessionGenerationContent(
  database: OpenClawAgentDatabase,
  sessionId: string,
): boolean {
  const db = getSessionKysely(database.db);
  return (
    executeSqliteQueryTakeFirstSync(
      database.db,
      db.selectFrom("transcript_events").select("seq").where("session_id", "=", sessionId).limit(1),
    ) !== undefined ||
    executeSqliteQueryTakeFirstSync(
      database.db,
      db
        .selectFrom("trajectory_runtime_events")
        .select("seq")
        .where("session_id", "=", sessionId)
        .limit(1),
    ) !== undefined ||
    executeSqliteQueryTakeFirstSync(
      database.db,
      db
        .selectFrom("acp_parent_stream_events")
        .select("seq")
        .where("session_id", "=", sessionId)
        .limit(1),
    ) !== undefined
  );
}

export function writeSessionEntry(
  database: OpenClawAgentDatabase,
  sessionKey: string,
  entry: SessionEntry,
  options: { allowStoredAliases?: boolean; previousEntry?: SessionEntry | null } = {},
): void {
  assertCanonicalSessionKeyWrite(sessionKey, database.agentId);
  const db = getSessionKysely(database.db);
  if (!options.allowStoredAliases) {
    assertNoPaddedSqliteSessionKeyRow(database, sessionKey);
  }
  const normalizedEntry = normalizeSqliteSessionEntryTimestamp(entry);
  const updatedAt = normalizedEntry.updatedAt;
  const canonicalPreviousEntry = readExactSessionEntryRow(database, sessionKey)?.entry;
  const previousEntry =
    options.previousEntry === undefined
      ? canonicalPreviousEntry
      : (options.previousEntry ?? undefined);
  // The lifecycle-selected entry owns visibility copy-forward semantics.
  if (previousEntry && previousEntry.sessionId !== normalizedEntry.sessionId) {
    delete normalizedEntry.visibility;
  }
  // Collaboration rows belong to the exact canonical node being overwritten,
  // which can differ from the selected alias during canonicalization.
  if (canonicalPreviousEntry && canonicalPreviousEntry.sessionId !== normalizedEntry.sessionId) {
    clearSessionCollaborationForKey(database, sessionKey);
  }
  // Registry writes snapshot the current transcript watermark so recovery can
  // distinguish same-millisecond transcript writes before and after this row.
  const transcriptObservedAt =
    readTranscriptMutationStateInTransaction(database, normalizedEntry.sessionId).updatedAt ??
    updatedAt;
  const boundSessionRoot = bindSqliteSessionRoot({
    entry: normalizedEntry,
    sessionKey,
    updatedAt,
  });
  const conversation = prepareSessionConversation({
    entry: normalizedEntry,
    sessionScope: boundSessionRoot.session_scope,
  });
  if (conversation) {
    upsertConversationIdentity(database, conversation.identity, updatedAt);
  }
  const boundSessionRow = {
    ...boundSessionRoot,
    primary_conversation_id:
      conversation?.role === "primary" ? conversation.identity.conversationRef : null,
    transcript_observed_at: transcriptObservedAt,
  };
  const sessionRow = resolveSessionEntryProvenanceRow({
    boundSessionRow,
    database,
    entry: normalizedEntry,
    previousEntry,
  });
  const sessionNode = bindSqliteSessionNode({
    entry: normalizedEntry,
    projectedTitle: deriveSqliteSessionTitle(database.db, normalizedEntry),
    sessionKey,
    updatedAt,
  });
  executeSqliteQuerySync(
    database.db,
    db
      .insertInto("session_nodes")
      .values(sessionNode)
      .onConflict((conflict) =>
        conflict.column("session_key").doUpdateSet({
          current_session_id: sessionNode.current_session_id,
          entry_json: sessionNode.entry_json,
          updated_at: sessionNode.updated_at,
          status: sessionNode.status,
          created_at: sessionNode.created_at,
          created_via: sessionNode.created_via,
          created_actor_type: sessionNode.created_actor_type,
          created_actor_id: sessionNode.created_actor_id,
          parent_session_key: sessionNode.parent_session_key,
          spawned_by: sessionNode.spawned_by,
          fork_source_session_key: sessionNode.fork_source_session_key,
          fork_source_session_id: sessionNode.fork_source_session_id,
          fork_source_entry_id: sessionNode.fork_source_entry_id,
          label: sessionNode.label,
          display_name: sessionNode.display_name,
          category: sessionNode.category,
          icon: sessionNode.icon,
          pinned_at: sessionNode.pinned_at,
          archived_at: sessionNode.archived_at,
          last_read_at: sessionNode.last_read_at,
          last_interaction_at: sessionNode.last_interaction_at,
          last_activity_at: sessionNode.last_activity_at,
        }),
      ),
  );
  executeSqliteQuerySync(
    database.db,
    db
      .insertInto("session_windows")
      .values(sessionRow)
      .onConflict((conflict) =>
        conflict.column("session_id").doUpdateSet({
          session_key: sessionKey,
          previous_session_id: sessionRow.previous_session_id,
          reason: sessionRow.reason,
          session_scope: sessionRow.session_scope,
          transcript_observed_at: transcriptObservedAt,
          session_entry_provenance: sessionRow.session_entry_provenance,
          acp_owned: sessionRow.acp_owned,
          plugin_owner_id: sessionRow.plugin_owner_id,
          hook_external_content_source: sessionRow.hook_external_content_source,
          updated_at: updatedAt,
          started_at: sessionRow.started_at,
          ended_at: sessionRow.ended_at,
          status: sessionRow.status,
          chat_type: sessionRow.chat_type,
          channel: sessionRow.channel,
          account_id: sessionRow.account_id,
          primary_conversation_id: sessionRow.primary_conversation_id,
          model_provider: sessionRow.model_provider,
          model: sessionRow.model,
          agent_harness_id: sessionRow.agent_harness_id,
          parent_session_key: sessionRow.parent_session_key,
          spawned_by: sessionRow.spawned_by,
          display_name: sessionRow.display_name,
        }),
      ),
  );
  if (conversation) {
    linkSessionConversation({
      database,
      sessionId: sessionRow.session_id,
      conversation,
      updatedAt,
    });
  }
  publishSqliteSessionEntryCacheInvalidation(database);
}

/** Resolves the parent fork decision using SQLite transcript rows when totals are stale. */
