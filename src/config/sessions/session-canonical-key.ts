import type { DatabaseSync } from "node:sqlite";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../../infra/kysely-sync.js";
import {
  normalizeAgentId,
  normalizeMainKey,
  parseAgentSessionKey,
} from "../../routing/session-key.js";
import type { DB as OpenClawAgentKyselyDatabase } from "../../state/openclaw-agent-db.generated.js";
import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { normalizeStoreSessionKey } from "./store-entry.js";
import type { SessionEntry } from "./types.js";

const SESSION_CANONICAL_KEY_REPAIR_COMMAND = "openclaw doctor --fix";
type CanonicalSessionDatabase = Pick<
  OpenClawAgentKyselyDatabase,
  "session_key_contract" | "session_key_revisions" | "session_nodes"
>;
type CanonicalSessionKeyToken = { revision: number };
const validatedDatabases = new WeakMap<
  DatabaseSync,
  { mainKey: string; token: CanonicalSessionKeyToken }
>();

class SessionCanonicalKeyMigrationRequiredError extends Error {
  readonly code = "SESSION_CANONICAL_KEY_MIGRATION_REQUIRED";

  constructor(
    sessionKey: string,
    reason: "duplicate" | "non-canonical-row" | "non-canonical-write",
  ) {
    const detail =
      reason === "duplicate"
        ? `duplicate rows resolve to canonical session key ${sessionKey}`
        : reason === "non-canonical-row"
          ? `non-canonical persisted row resolves to session key ${sessionKey}`
          : `refusing non-canonical session key write ${sessionKey}`;
    super(`${detail}; stop the Gateway and run ${SESSION_CANONICAL_KEY_REPAIR_COMMAND}`);
    this.name = "SessionCanonicalKeyMigrationRequiredError";
  }
}

function isCanonicalSessionKey(sessionKey: string): boolean {
  const trimmed = sessionKey.trim();
  if (!trimmed || sessionKey !== trimmed) {
    return false;
  }
  if (normalizeStoreSessionKey(sessionKey) !== sessionKey) {
    return false;
  }
  return trimmed === "global" || trimmed === "unknown" || parseAgentSessionKey(trimmed) !== null;
}

export function assertCanonicalSessionKeyWrite(sessionKey: string, databaseAgentId?: string): void {
  const parsed = parseAgentSessionKey(sessionKey);
  if (
    !isCanonicalSessionKey(sessionKey) ||
    (databaseAgentId && parsed && parsed.agentId !== normalizeAgentId(databaseAgentId))
  ) {
    throw new SessionCanonicalKeyMigrationRequiredError(sessionKey, "non-canonical-write");
  }
}

export function duplicateCanonicalSessionKeyError(
  canonicalKey: string,
): SessionCanonicalKeyMigrationRequiredError {
  return new SessionCanonicalKeyMigrationRequiredError(canonicalKey, "duplicate");
}

export function nonCanonicalSessionKeyRowError(
  canonicalKey: string,
): SessionCanonicalKeyMigrationRequiredError {
  return new SessionCanonicalKeyMigrationRequiredError(canonicalKey, "non-canonical-row");
}

function readCanonicalSessionKeyToken(database: DatabaseSync): CanonicalSessionKeyToken {
  const db = getNodeSqliteKysely<CanonicalSessionDatabase>(database);
  const row = executeSqliteQueryTakeFirstSync(
    database,
    db.selectFrom("session_key_revisions").select("revision").where("id", "=", 1),
  );
  if (typeof row?.revision !== "number") {
    throw new Error("SQLite did not return the canonical session-key revision");
  }
  return { revision: row.revision };
}

function canonicalSessionKeyTokensEqual(
  left: CanonicalSessionKeyToken,
  right: CanonicalSessionKeyToken,
): boolean {
  return left.revision === right.revision;
}

export function assertCanonicalSqliteSessionKeysCurrent(
  database: Pick<OpenClawAgentDatabase, "agentId" | "db">,
  mainKey?: string,
): CanonicalSessionKeyToken {
  const token = readCanonicalSessionKeyToken(database.db);
  const cached = validatedDatabases.get(database.db);
  if (
    cached &&
    (mainKey === undefined || cached.mainKey === normalizeMainKey(mainKey)) &&
    canonicalSessionKeyTokensEqual(cached.token, token)
  ) {
    return token;
  }
  const db = getNodeSqliteKysely<CanonicalSessionDatabase>(database.db);
  const storedMainKey = executeSqliteQueryTakeFirstSync(
    database.db,
    db.selectFrom("session_key_contract").select("main_key").where("id", "=", 1),
  )?.main_key;
  const canonicalMainKey = normalizeMainKey(mainKey ?? storedMainKey);
  for (const row of executeSqliteQuerySync(
    database.db,
    db.selectFrom("session_nodes").select("session_key"),
  ).rows) {
    const trimmed = row.session_key.trim();
    const parsed = parseAgentSessionKey(trimmed);
    if (
      row.session_key !== trimmed ||
      normalizeStoreSessionKey(trimmed) !== trimmed ||
      (!parsed && trimmed !== "global" && trimmed !== "unknown") ||
      (parsed && parsed.agentId !== normalizeAgentId(database.agentId)) ||
      (parsed && parsed.rest === "main" && canonicalMainKey !== "main")
    ) {
      throw nonCanonicalSessionKeyRowError(trimmed || row.session_key);
    }
  }
  if (!database.db.isTransaction) {
    validatedDatabases.set(database.db, { mainKey: canonicalMainKey, token });
  }
  return token;
}

export function setCanonicalSqliteSessionMainKey(
  database: Pick<OpenClawAgentDatabase, "db">,
  mainKey: string | undefined,
): void {
  const canonicalMainKey = normalizeMainKey(mainKey);
  const db = getNodeSqliteKysely<CanonicalSessionDatabase>(database.db);
  executeSqliteQuerySync(
    database.db,
    db
      .insertInto("session_key_contract")
      .values({ id: 1, main_key: canonicalMainKey, updated_at: Date.now() })
      .onConflict((conflict) =>
        conflict.column("id").doUpdateSet({
          main_key: canonicalMainKey,
          updated_at: Date.now(),
        }),
      ),
  );
}

export function canonicalSqliteSessionKeyTokenIsCurrent(
  database: Pick<OpenClawAgentDatabase, "db">,
  token: CanonicalSessionKeyToken,
): boolean {
  return canonicalSessionKeyTokensEqual(token, readCanonicalSessionKeyToken(database.db));
}

export function mergeCanonicalSessionEntryCandidates<T>(
  candidates: readonly { entry: SessionEntry; value: T }[],
): { entry: SessionEntry; winner: T } | undefined {
  let selected: { entry: SessionEntry; winner: T } | undefined;
  for (const candidate of candidates) {
    if (!selected) {
      selected = { entry: structuredClone(candidate.entry), winner: candidate.value };
      continue;
    }
    const incomingUpdatedAt = Number.isFinite(candidate.entry.updatedAt)
      ? candidate.entry.updatedAt
      : 0;
    const selectedUpdatedAt = Number.isFinite(selected.entry.updatedAt)
      ? selected.entry.updatedAt
      : 0;
    const incomingWins =
      incomingUpdatedAt > selectedUpdatedAt ||
      (incomingUpdatedAt === selectedUpdatedAt &&
        JSON.stringify(candidate.entry).localeCompare(JSON.stringify(selected.entry)) > 0);
    if (incomingWins) {
      selected = { entry: structuredClone(candidate.entry), winner: candidate.value };
    }
  }
  return selected;
}
