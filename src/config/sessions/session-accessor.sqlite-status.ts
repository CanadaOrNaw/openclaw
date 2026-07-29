import type { Expression, ExpressionBuilder, SqlBool } from "kysely";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../../infra/kysely-sync.js";
import type { DB as OpenClawAgentKyselyDatabase } from "../../state/openclaw-agent-db.generated.js";
import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import type {
  SessionEntryStatus,
  SessionEntrySummary,
} from "./session-accessor.sqlite-contract.js";
import type { SessionEntryListQuery } from "./session-accessor.types.js";
import {
  assertCanonicalSqliteSessionKeysCurrent,
  canonicalSqliteSessionKeyTokenIsCurrent,
} from "./session-canonical-key.js";
import { projectCanonicalSessionEntryShape } from "./store-entry-shape.js";
import type { SessionEntry } from "./types.js";

type SessionStatusDatabase = Pick<OpenClawAgentKyselyDatabase, "session_nodes">;
type SessionListExpressionBuilder = ExpressionBuilder<SessionStatusDatabase, "session_nodes">;
type SessionDatabaseReader = Pick<OpenClawAgentDatabase, "agentId" | "db">;

export type SqliteSessionEntryListQueryResult = {
  creatorActors: NonNullable<SessionEntry["createdActor"]>[];
  entries: SessionEntrySummary[];
  totalCount: number;
};

export function normalizeSqliteStatus(value: unknown): SessionEntryStatus | null {
  return value === "running" ||
    value === "done" ||
    value === "failed" ||
    value === "killed" ||
    value === "timeout"
    ? value
    : null;
}

export function parseSqliteSessionEntryJson(
  row: {
    current_session_id?: string;
    entry_json: string;
    updated_at?: number;
  },
  hydratePromotedColumns = false,
): SessionEntry | null {
  try {
    const parsed = JSON.parse(row.entry_json) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }
    const record = parsed as Record<string, unknown>;
    const entry = projectCanonicalSessionEntryShape(
      hydratePromotedColumns
        ? {
            ...record,
            sessionId:
              typeof record.sessionId === "string" && record.sessionId.trim()
                ? record.sessionId
                : row.current_session_id,
            updatedAt:
              typeof record.updatedAt === "number" && Number.isFinite(record.updatedAt)
                ? record.updatedAt
                : row.updated_at,
          }
        : record,
    );
    return typeof entry.sessionId === "string" ? entry : null;
  } catch {
    return null;
  }
}

function buildSessionListPredicate(
  eb: SessionListExpressionBuilder,
  query: SessionEntryListQuery,
  includeCreator: boolean,
) {
  const conditions: Expression<SqlBool>[] = [];
  if (query.archived !== "all") {
    conditions.push(eb("archived_at", query.archived === true ? "is not" : "is", null));
  }
  if (query.activeAfter !== undefined) {
    conditions.push(eb("updated_at", ">=", query.activeAfter));
  }
  if (query.requireLastInteraction) {
    conditions.push(eb("last_interaction_at", ">", 0));
  }
  if (query.label) {
    conditions.push(eb("label", "=", query.label));
  }
  if (includeCreator && query.createdActorId) {
    conditions.push(eb("created_actor_id", "=", query.createdActorId));
  }
  if (query.sessionId) {
    conditions.push(
      eb.or([
        eb("current_session_id", "=", query.sessionId),
        eb("session_key", "=", query.sessionId),
      ]),
    );
  }
  if (!query.includeGlobal) {
    conditions.push(eb("session_key", "!=", "global"));
  }
  if (!query.includeUnknown) {
    conditions.push(eb("session_key", "!=", "unknown"));
  }
  const agentTail = eb.fn<string>("substr", ["session_key", eb.val(7)]);
  const agentDelimiter = eb.fn<number>("instr", [agentTail, eb.val(":")]);
  if (query.ownerAgentId) {
    const ownerConditions: Expression<SqlBool>[] = [
      eb.and([
        eb("session_key", "like", "agent:%"),
        eb(agentDelimiter, ">", 0),
        eb(
          eb.fn<string>("substr", [agentTail, eb.val(1), eb(agentDelimiter, "-", 1)]),
          "=",
          query.ownerAgentId,
        ),
      ]),
    ];
    if (query.includeGlobal) {
      ownerConditions.push(eb("session_key", "=", "global"));
    }
    if (query.includeUnknown) {
      ownerConditions.push(eb("session_key", "=", "unknown"));
    }
    // Doctor owns legacy key migration; runtime accepts canonical agent keys plus explicit sentinels.
    conditions.push(eb.or(ownerConditions));
  }
  const agentRest = eb.fn<string>("substr", [agentTail, eb(agentDelimiter, "+", 1)]);
  if (!query.includeHidden) {
    const isCronRun = (rest: Expression<string>) => {
      const cronTail = eb.fn<string>("substr", [rest, eb.val(6)]);
      const delimiter = eb.fn<number>("instr", [cronTail, eb.val(":")]);
      const afterJob = eb.fn<string>("substr", [cronTail, eb(delimiter, "+", 1)]);
      return eb.and([
        eb(rest, "like", "cron:%"),
        eb(delimiter, ">", 1),
        eb(eb.fn<number>("glob", [eb.val("run:[^:]*"), afterJob]), "=", 1),
      ]);
    };
    const asInteger = (condition: Expression<SqlBool>) =>
      eb.case().when(condition).then(1).else(0).end();
    const hidden = eb
      .case()
      .when("session_key", "like", "internal-session-effects:%")
      .then(1)
      .when("session_key", "like", "cron:%")
      .then(asInteger(isCronRun(eb.ref("session_key"))))
      .when(
        eb.or([
          eb("session_key", "like", "agent:%:internal-session-effects:%"),
          eb("session_key", "like", "agent:%:cron:%:run:%"),
        ]),
      )
      .then(
        asInteger(
          eb.or([eb(agentRest, "like", "internal-session-effects:%"), isCronRun(agentRest)]),
        ),
      )
      .else(0)
      .end();
    conditions.push(eb(hidden, "=", 0));
  }
  const reservedPlaceholderKey = eb
    .case()
    .when("session_key", "=", "sessions")
    .then(1)
    .when("session_key", "like", "agent:%:sessions")
    .then(eb.case().when(agentRest, "=", "sessions").then(1).else(0).end())
    .else(0)
    .end();
  conditions.push(eb(eb.fn<number>("json_valid", ["entry_json"]), "=", eb.lit(1)));
  conditions.push(
    eb(
      eb.fn<string>("substr", [eb.fn<string>("ltrim", ["entry_json"]), eb.lit(1), eb.lit(1)]),
      "=",
      "{",
    ),
  );
  conditions.push(eb.or([eb(reservedPlaceholderKey, "=", 0), eb("entry_json", "!=", "{}")]));
  if (query.spawnedBy) {
    // Canonical sentinels are valid rows, but they never participate in child lineage.
    conditions.push(eb("session_key", "!=", "global"));
    conditions.push(eb("session_key", "!=", "unknown"));
    const lineageKeys = query.lineageKeys?.length ? [...query.lineageKeys] : [query.spawnedBy];
    const storedLineage = eb.or([
      eb("parent_session_key", "in", lineageKeys),
      eb("spawned_by", "in", lineageKeys),
    ]);
    const excluded = query.excludeLineageSessionKeys ?? [];
    if (excluded.length > 400) {
      throw new Error("SQLite lineage exclusion query must use residual selection above 400 keys");
    }
    const storedSelection = excluded.length
      ? eb.and([eb("session_key", "not in", [...excluded]), storedLineage])
      : storedLineage;
    conditions.push(
      query.includeLineageSessionKeys?.length
        ? eb.or([eb("session_key", "in", [...query.includeLineageSessionKeys]), storedSelection])
        : storedSelection,
    );
  }
  return eb.and(conditions);
}

export function querySqliteSessionEntries(
  database: SessionDatabaseReader,
  query: SessionEntryListQuery,
  options: {
    projection?: "full" | "list";
    setProjectedTitle: (entry: SessionEntry, title: string | null) => void;
  },
  attempt = 0,
): SqliteSessionEntryListQueryResult {
  const validationToken = assertCanonicalSqliteSessionKeysCurrent(database, query.mainKey);
  const finish = (result: SqliteSessionEntryListQueryResult) => {
    if (canonicalSqliteSessionKeyTokenIsCurrent(database, validationToken)) {
      return result;
    }
    if (attempt >= 2) {
      throw new Error("SQLite session state changed repeatedly during list selection");
    }
    return querySqliteSessionEntries(database, query, options, attempt + 1);
  };
  const included = query.includeLineageSessionKeys;
  if (included && included.length > 400) {
    const entries = new Map<string, SessionEntrySummary>();
    const creatorActors = new Map<string, NonNullable<SessionEntry["createdActor"]>>();
    for (let offset = 0; offset < included.length; offset += 400) {
      const result = querySqliteSessionEntries(
        database,
        {
          ...query,
          includeLineageSessionKeys: included.slice(offset, offset + 400),
          limit: undefined,
        },
        options,
      );
      for (const entry of result.entries) {
        entries.set(entry.sessionKey, entry);
      }
      for (const actor of result.creatorActors) {
        creatorActors.set(`${actor.type}\0${actor.id ?? ""}`, actor);
      }
    }
    return finish({
      creatorActors: [...creatorActors.values()],
      entries: [...entries.values()],
      totalCount: entries.size,
    });
  }
  const db = getNodeSqliteKysely<SessionStatusDatabase>(database.db);
  const base = db
    .selectFrom("session_nodes")
    .where((eb) => buildSessionListPredicate(eb, query, true));
  const selected = base.select([
    "session_key",
    "current_session_id",
    "entry_json",
    "updated_at",
    "display_name",
  ]);
  const limit = query.limit === undefined ? undefined : Math.max(1, Math.floor(query.limit));
  const rows =
    query.sortBy === "lastInteractionAt"
      ? executeSqliteQuerySync(
          database.db,
          (limit ? selected.limit(limit) : selected)
            .orderBy("last_interaction_at", "desc")
            .orderBy("session_key", "asc"),
        ).rows
      : (() => {
          const pinned = executeSqliteQuerySync(
            database.db,
            (limit ? selected.limit(limit) : selected)
              .where("pinned_at", "is not", null)
              .orderBy("pinned_at", "desc")
              .orderBy("updated_at", "desc")
              .orderBy("session_key", "asc"),
          ).rows;
          const remaining = limit === undefined ? undefined : limit - pinned.length;
          if (remaining !== undefined && remaining <= 0) {
            return pinned;
          }
          const unpinned = executeSqliteQuerySync(
            database.db,
            (remaining === undefined ? selected : selected.limit(remaining))
              .where("pinned_at", "is", null)
              .orderBy("updated_at", "desc")
              .orderBy("session_key", "asc"),
          ).rows;
          return [...pinned, ...unpinned];
        })();
  const entries = rows.flatMap((row) => {
    const entry = parseSqliteSessionEntryJson(row, true);
    if (!entry) {
      return [];
    }
    const projected = entry;
    if (options.projection === "list") {
      delete projected.skillsSnapshot;
      delete projected.systemPromptReport;
    }
    options.setProjectedTitle(projected, row.display_name);
    return [{ sessionKey: row.session_key, entry: projected }];
  });
  const count = executeSqliteQueryTakeFirstSync(
    database.db,
    base.clearSelect().select((eb) => eb.fn.countAll<number>().as("count")),
  )?.count;
  const creatorRows = executeSqliteQuerySync(
    database.db,
    db
      .selectFrom("session_nodes")
      .select((eb) => [
        "created_actor_id",
        "created_actor_type",
        eb
          .case()
          .when(eb(eb.fn<number>("json_valid", ["entry_json"]), "=", 1))
          .then(
            eb
              .case()
              .when(
                eb(
                  eb.fn<string | null>("json_type", ["entry_json", eb.val("$.createdActor.label")]),
                  "=",
                  "text",
                ),
              )
              .then(eb.fn<string>("json_extract", ["entry_json", eb.val("$.createdActor.label")]))
              .else(null)
              .end(),
          )
          .else(null)
          .end()
          .as("created_actor_label"),
      ])
      .distinct()
      .where((eb) => buildSessionListPredicate(eb, query, false))
      .where("created_actor_id", "is not", null),
  ).rows;
  const creatorActors = new Map<string, NonNullable<SessionEntry["createdActor"]>>();
  for (const row of creatorRows) {
    const actorType = row.created_actor_type;
    if (
      !row.created_actor_id ||
      (actorType !== "agent" && actorType !== "human" && actorType !== "system")
    ) {
      continue;
    }
    const label =
      typeof row.created_actor_label === "string" ? row.created_actor_label.trim() : undefined;
    const key = `${actorType}\0${row.created_actor_id}`;
    const existing = creatorActors.get(key);
    if (!existing?.label || (label && label.localeCompare(existing.label) < 0)) {
      creatorActors.set(key, {
        id: row.created_actor_id,
        type: actorType,
        ...(label ? { label } : {}),
      });
    }
  }
  return finish({
    creatorActors: [...creatorActors.values()],
    entries,
    totalCount: count ?? 0,
  });
}

export function readSqliteSessionEntriesByStatus(
  database: OpenClawAgentDatabase,
  statuses: readonly SessionEntryStatus[],
  sessionKeys?: readonly string[],
): SessionEntrySummary[] {
  const selectedStatuses = [...new Set(statuses)];
  const selectedSessionKeys = sessionKeys ? [...new Set(sessionKeys)] : undefined;
  if (selectedStatuses.length === 0 || selectedSessionKeys?.length === 0) {
    return [];
  }
  const db = getNodeSqliteKysely<SessionStatusDatabase>(database.db);
  let query = db
    .selectFrom("session_nodes")
    .select(["session_key", "entry_json", "current_session_id", "updated_at"])
    .where("status", "in", selectedStatuses);
  if (selectedSessionKeys) {
    query = query.where("session_key", "in", selectedSessionKeys);
  }
  return executeSqliteQuerySync(database.db, query)
    .rows.flatMap((row) => {
      const entry = parseSqliteSessionEntryJson(row);
      return entry ? [{ entry, sessionKey: row.session_key }] : [];
    })
    .toSorted((a, b) => a.sessionKey.localeCompare(b.sessionKey));
}
