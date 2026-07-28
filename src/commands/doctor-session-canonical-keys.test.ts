import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readSessionArchiveContentSync } from "../config/sessions/archive-compression.js";
import { resolveStorePath } from "../config/sessions/paths.js";
import {
  loadTranscriptEvents,
  loadExactSessionEntryReadOnly,
  replaceSessionEntrySync,
} from "../config/sessions/session-accessor.js";
import { resolveSqliteTargetFromSessionStorePath } from "../config/sessions/session-sqlite-target.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "../state/openclaw-agent-db.js";
import { withStateDirEnv } from "../test-helpers/state-dir-env.js";
import { repairCanonicalSessionKeys } from "./doctor-session-canonical-keys.js";

afterEach(() => closeOpenClawAgentDatabasesForTest());

function insertLegacySession(params: {
  agentId: string;
  entry: SessionEntry;
  env: NodeJS.ProcessEnv;
  eventText?: string;
  sessionKey: string;
  storePath: string;
}): void {
  const database = openOpenClawAgentDatabase({
    agentId: params.agentId,
    env: params.env,
    path: resolveSqliteTargetFromSessionStorePath(params.storePath, {
      agentId: params.agentId,
      env: params.env,
    }).path,
  });
  database.db
    .prepare(
      "INSERT INTO session_nodes (session_key, current_session_id, entry_json, updated_at) VALUES (?, ?, ?, ?)",
    )
    .run(
      params.sessionKey,
      params.entry.sessionId,
      JSON.stringify(params.entry),
      params.entry.updatedAt,
    );
  database.db
    .prepare(
      "INSERT INTO session_windows (session_id, session_key, reason, session_scope, created_at, updated_at) VALUES (?, ?, 'initial', 'conversation', ?, ?)",
    )
    .run(params.entry.sessionId, params.sessionKey, params.entry.updatedAt, params.entry.updatedAt);
  if (params.eventText) {
    database.db
      .prepare(
        "INSERT INTO transcript_events (session_id, seq, event_json, created_at) VALUES (?, 0, ?, ?)",
      )
      .run(
        params.entry.sessionId,
        JSON.stringify({
          id: `${params.entry.sessionId}-message`,
          message: { content: params.eventText, role: "user" },
          parentId: null,
          type: "message",
        }),
        params.entry.updatedAt,
      );
  }
}

describe("doctor canonical session-key repair", () => {
  it("is a no-op for fresh stores and remains idempotent after repair", async () => {
    await withStateDirEnv("openclaw-doctor-canonical-fresh-", async ({ stateDir }) => {
      const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
      const storeTemplate = path.join(stateDir, "agents", "{agentId}", "sessions.json");
      const storePath = resolveStorePath(storeTemplate, { agentId: "main", env });
      const cfg = {
        agents: { list: [{ id: "main", default: true }] },
        session: { store: storeTemplate },
      } as OpenClawConfig;
      replaceSessionEntrySync(
        { agentId: "main", env, sessionKey: "agent:main:main", storePath },
        { sessionId: "fresh", updatedAt: 10 },
      );

      expect(await repairCanonicalSessionKeys({ apply: false, cfg, env })).toMatchObject({
        foundGroups: 0,
        repairedGroups: 0,
      });
      expect(await repairCanonicalSessionKeys({ apply: true, cfg, env })).toMatchObject({
        foundGroups: 0,
        repairedGroups: 0,
      });
    });
  });

  it("rehomes matching in-store transcript generations under the canonical key", async () => {
    await withStateDirEnv("openclaw-doctor-canonical-rehome-", async ({ stateDir }) => {
      const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
      const storeTemplate = path.join(stateDir, "agents", "{agentId}", "sessions.json");
      const storePath = resolveStorePath(storeTemplate, { agentId: "main", env });
      const cfg = {
        agents: { list: [{ id: "main", default: true }] },
        session: { mainKey: "work", store: storeTemplate },
      } as OpenClawConfig;
      replaceSessionEntrySync(
        { agentId: "main", env, sessionKey: "agent:main:work", storePath },
        { previousSessionId: "older", sessionId: "newer", updatedAt: 20 },
      );
      insertLegacySession({
        agentId: "main",
        entry: { sessionId: "older", subject: "preserved", updatedAt: 10 },
        env,
        eventText: "older history",
        sessionKey: "agent:main:main",
        storePath,
      });

      const first = await repairCanonicalSessionKeys({ apply: true, cfg, env });
      expect(first).toMatchObject({ foundGroups: 1, removedRows: 1, repairedGroups: 1 });
      expect(first.archivedTranscriptDirectories).toEqual([]);
      const database = openOpenClawAgentDatabase({
        agentId: "main",
        env,
        path: resolveSqliteTargetFromSessionStorePath(storePath, { agentId: "main", env }).path,
      });
      expect(
        database.db
          .prepare("SELECT session_key FROM session_windows WHERE session_id = ?")
          .get("older"),
      ).toEqual({ session_key: "agent:main:work" });
      expect(
        database.db
          .prepare("SELECT count(*) AS count FROM transcript_events WHERE session_id = ?")
          .get("older"),
      ).toEqual({ count: 1 });
      expect(await repairCanonicalSessionKeys({ apply: true, cfg, env })).toMatchObject({
        foundGroups: 0,
        repairedGroups: 0,
      });
    });
  });

  it("moves a lone alias row to its canonical key", async () => {
    await withStateDirEnv("openclaw-doctor-canonical-single-alias-", async ({ stateDir }) => {
      const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
      const storeTemplate = path.join(stateDir, "agents", "{agentId}", "sessions.json");
      const storePath = resolveStorePath(storeTemplate, { agentId: "main", env });
      const cfg = {
        agents: { list: [{ id: "main", default: true }] },
        session: { mainKey: "work", store: storeTemplate },
      } as OpenClawConfig;
      insertLegacySession({
        agentId: "main",
        entry: { sessionId: "legacy", updatedAt: 10 },
        env,
        sessionKey: "agent:main:main",
        storePath,
      });

      expect(await repairCanonicalSessionKeys({ apply: true, cfg, env })).toMatchObject({
        foundGroups: 1,
        removedRows: 1,
        repairedGroups: 1,
      });
      expect(
        loadExactSessionEntryReadOnly({
          agentId: "main",
          env,
          sessionKey: "agent:main:main",
          storePath,
        }),
      ).toBeUndefined();
      expect(
        loadExactSessionEntryReadOnly({
          agentId: "main",
          env,
          sessionKey: "agent:main:work",
          storePath,
        })?.entry.sessionId,
      ).toBe("legacy");
    });
  });

  it("archives cross-store loser history before removing the duplicate", async () => {
    await withStateDirEnv("openclaw-doctor-canonical-cross-store-", async ({ stateDir }) => {
      const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
      const storeTemplate = path.join(stateDir, "agents", "{agentId}", "sessions.json");
      const mainStore = resolveStorePath(storeTemplate, { agentId: "main", env });
      const opsStore = resolveStorePath(storeTemplate, { agentId: "ops", env });
      const cfg = {
        agents: { list: [{ id: "main", default: true }, { id: "ops" }] },
        session: { store: storeTemplate },
      } as OpenClawConfig;
      replaceSessionEntrySync(
        { agentId: "main", env, sessionKey: "agent:main:shared", storePath: mainStore },
        { sessionId: "older-main", updatedAt: 10 },
      );
      insertLegacySession({
        agentId: "ops",
        entry: { sessionId: "winner", subject: "merged subject", updatedAt: 20 },
        env,
        eventText: "cross-store history",
        sessionKey: "agent:main:shared",
        storePath: opsStore,
      });

      const report = await repairCanonicalSessionKeys({ apply: true, cfg, env });
      expect(report).toMatchObject({ foundGroups: 1, removedRows: 1, repairedGroups: 1 });
      expect(report.archivedTranscriptDirectories).toHaveLength(1);
      expect(
        loadExactSessionEntryReadOnly({
          agentId: "main",
          env,
          sessionKey: "agent:main:shared",
          storePath: mainStore,
        })?.entry,
      ).toMatchObject({ sessionId: "winner", subject: "merged subject" });
      await expect(
        loadTranscriptEvents({
          agentId: "main",
          env,
          sessionId: "winner",
          sessionKey: "agent:main:shared",
          storePath: mainStore,
        }),
      ).resolves.toEqual([
        expect.objectContaining({
          message: expect.objectContaining({ content: "cross-store history" }),
        }),
      ]);
      expect(
        loadExactSessionEntryReadOnly({
          agentId: "ops",
          env,
          sessionKey: "agent:main:shared",
          storePath: opsStore,
        }),
      ).toBeUndefined();
      const archiveDirectory = report.archivedTranscriptDirectories[0];
      if (!archiveDirectory) {
        throw new Error("expected cross-store transcript archive directory");
      }
      const archiveName = fs
        .readdirSync(archiveDirectory)
        .find((name) => name.startsWith("winner.jsonl"));
      expect(archiveName).toBeTruthy();
      expect(
        readSessionArchiveContentSync(path.join(archiveDirectory, archiveName ?? "")),
      ).toContain("cross-store history");
    });
  });
});
