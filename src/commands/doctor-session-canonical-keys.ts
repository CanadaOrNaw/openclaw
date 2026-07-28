import fs from "node:fs";
import { resolveStorePath } from "../config/sessions/paths.js";
import {
  applySessionEntryLifecycleMutation,
  copySessionOwnedStateForCanonicalRepair,
  listSessionEntriesReadOnly,
} from "../config/sessions/session-accessor.js";
import { mergeCanonicalSessionEntryCandidates } from "../config/sessions/session-canonical-key.js";
import { resolveAllAgentSessionStoreTargetsSync } from "../config/sessions/targets.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  resolveSessionStoreAgentId,
  resolveStoredSessionKeyForAgentStore,
} from "../gateway/session-store-key.js";
import { resolveTargetSqlitePath } from "./doctor-session-sqlite-readers.js";

type CanonicalSessionCandidate = {
  agentId: string;
  canonicalKey: string;
  entry: SessionEntry;
  sessionKey: string;
  sqlitePath: string;
  storePath: string;
};

export type CanonicalSessionKeyRepairReport = {
  archivedTranscriptDirectories: string[];
  foundGroups: number;
  removedRows: number;
  repairedGroups: number;
  scannedStores: number;
};

function collectCanonicalSessionCandidates(params: {
  cfg: OpenClawConfig;
  env: NodeJS.ProcessEnv;
}): { candidates: CanonicalSessionCandidate[]; scannedStores: number } {
  const candidates: CanonicalSessionCandidate[] = [];
  const seenDatabases = new Set<string>();
  for (const target of resolveAllAgentSessionStoreTargetsSync(params.cfg, { env: params.env })) {
    const sqlitePath = resolveTargetSqlitePath(target);
    if (seenDatabases.has(sqlitePath) || !fs.existsSync(sqlitePath)) {
      continue;
    }
    seenDatabases.add(sqlitePath);
    for (const { entry, sessionKey } of listSessionEntriesReadOnly({
      agentId: target.agentId,
      clone: false,
      storePath: target.storePath,
    })) {
      candidates.push({
        agentId: target.agentId,
        canonicalKey: resolveStoredSessionKeyForAgentStore({
          cfg: params.cfg,
          agentId: target.agentId,
          sessionKey,
        }),
        entry,
        sessionKey,
        sqlitePath,
        storePath: target.storePath,
      });
    }
  }
  return { candidates, scannedStores: seenDatabases.size };
}

function resolveCanonicalDestination(params: {
  canonicalKey: string;
  cfg: OpenClawConfig;
  env: NodeJS.ProcessEnv;
}) {
  const agentId = resolveSessionStoreAgentId(params.cfg, params.canonicalKey);
  const storePath = resolveStorePath(params.cfg.session?.store, { agentId, env: params.env });
  return {
    agentId,
    storePath,
    sqlitePath: resolveTargetSqlitePath({ agentId, storePath }),
  };
}

function groupRepairCandidates(
  candidates: readonly CanonicalSessionCandidate[],
  params: { cfg: OpenClawConfig; env: NodeJS.ProcessEnv },
) {
  const byCanonicalKey = new Map<string, CanonicalSessionCandidate[]>();
  for (const candidate of candidates) {
    const group = byCanonicalKey.get(candidate.canonicalKey) ?? [];
    group.push(candidate);
    byCanonicalKey.set(candidate.canonicalKey, group);
  }
  return [...byCanonicalKey.values()].filter((group) => {
    const first = group[0];
    if (!first) {
      return false;
    }
    const destination = resolveCanonicalDestination({
      canonicalKey: first.canonicalKey,
      cfg: params.cfg,
      env: params.env,
    });
    return (
      group.length > 1 ||
      group.some(
        (candidate) =>
          candidate.sessionKey !== candidate.canonicalKey ||
          candidate.sqlitePath !== destination.sqlitePath,
      )
    );
  });
}

function countRemovedRows(candidates: readonly CanonicalSessionCandidate[]): number {
  const selected = mergeCanonicalSessionEntryCandidates(
    candidates.map((candidate) => ({ entry: candidate.entry, value: candidate })),
  );
  if (!selected) {
    return 0;
  }
  const canonicalRowSurvives = candidates.some(
    (candidate) =>
      candidate.sqlitePath === selected.winner.sqlitePath &&
      candidate.sessionKey === candidate.canonicalKey,
  );
  return candidates.length - (canonicalRowSurvives ? 1 : 0);
}

async function repairCanonicalSessionGroup(
  candidates: readonly CanonicalSessionCandidate[],
  params: { cfg: OpenClawConfig; env: NodeJS.ProcessEnv },
): Promise<string[]> {
  const selected = mergeCanonicalSessionEntryCandidates(
    candidates.map((candidate) => ({ entry: candidate.entry, value: candidate })),
  );
  if (!selected) {
    return [];
  }
  const winner = selected.winner;
  const destination = resolveCanonicalDestination({
    canonicalKey: winner.canonicalKey,
    cfg: params.cfg,
    env: params.env,
  });
  const byDatabase = new Map<string, CanonicalSessionCandidate[]>();
  for (const candidate of candidates) {
    const group = byDatabase.get(candidate.sqlitePath) ?? [];
    group.push(candidate);
    byDatabase.set(candidate.sqlitePath, group);
  }

  const destinationStore = byDatabase.get(destination.sqlitePath) ?? [];
  const relatedSessionIds = new Set(
    [selected.entry.sessionId, selected.entry.previousSessionId].filter(
      (value): value is string => typeof value === "string" && value.length > 0,
    ),
  );
  const winnerResult = await applySessionEntryLifecycleMutation({
    agentId: destination.agentId,
    afterUpsertsInTransaction: (destinationDatabase) => {
      for (const [sqlitePath, storeCandidates] of byDatabase) {
        if (sqlitePath === destination.sqlitePath) {
          continue;
        }
        const [source] = storeCandidates;
        if (!source) {
          continue;
        }
        copySessionOwnedStateForCanonicalRepair({
          canonicalKey: winner.canonicalKey,
          destinationDatabase,
          preferSource: sqlitePath === winner.sqlitePath,
          ...(sqlitePath === winner.sqlitePath ? { preferredEntry: selected.entry } : {}),
          source,
          sourceEntries: storeCandidates.map((candidate) => candidate.entry),
          sourceKeys: storeCandidates.map((candidate) => candidate.sessionKey),
        });
      }
    },
    removals: destinationStore
      .filter((candidate) => candidate.sessionKey !== winner.canonicalKey)
      .map((candidate) => ({
        archiveRemovedTranscript: !relatedSessionIds.has(candidate.entry.sessionId),
        exactStoredKey: true,
        expectedEntry: candidate.entry,
        sessionKey: candidate.sessionKey,
      })),
    skipMaintenance: true,
    storePath: destination.storePath,
    upserts: [{ entry: selected.entry, sessionKey: winner.canonicalKey }],
  });
  const archivedDirectories = new Set(winnerResult.archivedTranscriptDirectories);

  for (const [sqlitePath, storeCandidates] of byDatabase) {
    if (sqlitePath === destination.sqlitePath) {
      continue;
    }
    const [storeCandidate] = storeCandidates;
    if (!storeCandidate) {
      continue;
    }
    const result = await applySessionEntryLifecycleMutation({
      agentId: storeCandidate.agentId,
      removals: storeCandidates.map((candidate) => ({
        archiveRemovedTranscript: true,
        exactStoredKey: true,
        expectedEntry: candidate.entry,
        sessionKey: candidate.sessionKey,
      })),
      skipMaintenance: true,
      storePath: storeCandidate.storePath,
    });
    for (const directory of result.archivedTranscriptDirectories) {
      archivedDirectories.add(directory);
    }
  }
  return [...archivedDirectories];
}

/** Doctor-owned durable repair; process-held incognito databases are intentionally excluded. */
export async function repairCanonicalSessionKeys(params: {
  apply: boolean;
  cfg: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
}): Promise<CanonicalSessionKeyRepairReport> {
  const { candidates, scannedStores } = collectCanonicalSessionCandidates({
    cfg: params.cfg,
    env: params.env ?? process.env,
  });
  const env = params.env ?? process.env;
  const repairGroups = groupRepairCandidates(candidates, { cfg: params.cfg, env });
  const archivedTranscriptDirectories = new Set<string>();
  let repairedGroups = 0;
  if (params.apply) {
    for (const group of repairGroups) {
      for (const directory of await repairCanonicalSessionGroup(group, {
        cfg: params.cfg,
        env,
      })) {
        archivedTranscriptDirectories.add(directory);
      }
      repairedGroups += 1;
    }
  }
  return {
    archivedTranscriptDirectories: [...archivedTranscriptDirectories].toSorted(),
    foundGroups: repairGroups.length,
    removedRows: repairGroups.reduce((total, group) => total + countRemovedRows(group), 0),
    repairedGroups,
    scannedStores,
  };
}
