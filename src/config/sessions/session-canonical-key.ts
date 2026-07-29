import { normalizeAgentId, parseAgentSessionKey } from "../../routing/session-key.js";
import { normalizeStoreSessionKey } from "./store-entry.js";
import type { SessionEntry } from "./types.js";

const SESSION_CANONICAL_KEY_REPAIR_COMMAND = "openclaw doctor --fix";

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
