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

  it("moves a lone canonical row out of the wrong agent database", async () => {
    await withStateDirEnv("openclaw-doctor-canonical-wrong-store-", async ({ stateDir }) => {
      const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
      const storeTemplate = path.join(stateDir, "agents", "{agentId}", "sessions.json");
      const mainStore = resolveStorePath(storeTemplate, { agentId: "main", env });
      const opsStore = resolveStorePath(storeTemplate, { agentId: "ops", env });
      const cfg = {
        agents: { list: [{ id: "main", default: true }, { id: "ops" }] },
        session: { store: storeTemplate },
      } as OpenClawConfig;
      insertLegacySession({
        agentId: "ops",
        entry: { sessionId: "misplaced", updatedAt: 10 },
        env,
        eventText: "misplaced history",
        sessionKey: "agent:main:misplaced",
        storePath: opsStore,
      });

      expect(await repairCanonicalSessionKeys({ apply: true, cfg, env })).toMatchObject({
        foundGroups: 1,
        repairedGroups: 1,
      });
      expect(
        loadExactSessionEntryReadOnly({
          agentId: "main",
          env,
          sessionKey: "agent:main:misplaced",
          storePath: mainStore,
        })?.entry.sessionId,
      ).toBe("misplaced");
      expect(
        loadExactSessionEntryReadOnly({
          agentId: "ops",
          env,
          sessionKey: "agent:main:misplaced",
          storePath: opsStore,
        }),
      ).toBeUndefined();
      await expect(
        loadTranscriptEvents({
          agentId: "main",
          env,
          sessionId: "misplaced",
          sessionKey: "agent:main:misplaced",
          storePath: mainStore,
        }),
      ).resolves.toEqual([
        expect.objectContaining({
          message: expect.objectContaining({ content: "misplaced history" }),
        }),
      ]);
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
        session: { mainKey: "shared", store: storeTemplate },
      } as OpenClawConfig;
      const sourceAlias = "agent:main:main ";
      replaceSessionEntrySync(
        { agentId: "main", env, sessionKey: "agent:main:shared", storePath: mainStore },
        { archivedAt: 10, sessionId: "destination-only", updatedAt: 10 },
      );
      const staleDestinationDatabase = openOpenClawAgentDatabase({
        agentId: "main",
        env,
        path: resolveSqliteTargetFromSessionStorePath(mainStore, { agentId: "main", env }).path,
      });
      staleDestinationDatabase.db
        .prepare(
          "INSERT INTO transcript_events (session_id, seq, event_json, created_at) VALUES ('destination-only', 0, ?, 10)",
        )
        .run(
          JSON.stringify({
            id: "destination-only-message",
            message: { content: "destination-only history", role: "user" },
            parentId: null,
            type: "message",
          }),
        );
      staleDestinationDatabase.db
        .prepare(
          "INSERT INTO session_windows (session_id, session_key, reason, session_scope, created_at, updated_at) VALUES ('winner', 'agent:main:shared', 'recovery', 'conversation', 10, 10)",
        )
        .run();
      staleDestinationDatabase.db
        .prepare(
          "INSERT INTO transcript_events (session_id, seq, event_json, created_at) VALUES ('winner', 0, ?, 10)",
        )
        .run(
          JSON.stringify({
            id: "stale-winner-message",
            message: { content: "stale destination history", role: "user" },
            parentId: null,
            type: "message",
          }),
        );
      insertLegacySession({
        agentId: "ops",
        entry: {
          previousSessionId: "destination-only",
          sessionId: "winner",
          subject: "merged subject",
          updatedAt: 20,
        },
        env,
        eventText: "cross-store history",
        sessionKey: sourceAlias,
        storePath: opsStore,
      });
      const opsDatabase = openOpenClawAgentDatabase({
        agentId: "ops",
        env,
        path: resolveSqliteTargetFromSessionStorePath(opsStore, { agentId: "ops", env }).path,
      });
      opsDatabase.db
        .prepare(
          "INSERT INTO session_windows (session_id, session_key, previous_session_id, reason, session_scope, created_at, updated_at) VALUES ('winner-previous', ?, NULL, 'reset', 'conversation', 15, 15)",
        )
        .run(sourceAlias);
      opsDatabase.db
        .prepare(
          "INSERT INTO transcript_events (session_id, seq, event_json, created_at) VALUES ('winner-previous', 0, ?, 15)",
        )
        .run(
          JSON.stringify({
            id: "winner-previous-message",
            message: { content: "previous generation history", role: "user" },
            parentId: null,
            type: "message",
          }),
        );
      opsDatabase.db
        .prepare(
          "INSERT INTO board_tabs (session_key, tab_id, title, position, created_by, revision) VALUES (?, 'tab-1', 'Board', 0, 'user', 1)",
        )
        .run(sourceAlias);
      opsDatabase.db
        .prepare(
          "INSERT INTO board_widgets (session_key, name, tab_id, content_kind, html, sha256, view_generation, revision, size_w, size_h, position, created_by, created_at, updated_at) VALUES (?, 'widget-1', 'tab-1', 'html', X'00', 'sha', 'view-1', 1, 1, 1, 0, 'user', 1, 20)",
        )
        .run(sourceAlias);
      opsDatabase.db
        .prepare(
          "INSERT INTO session_members (session_key, identity_id, added_by, added_at) VALUES (?, 'member-1', 'owner-1', 20)",
        )
        .run(sourceAlias);
      opsDatabase.db
        .prepare(
          "INSERT INTO heartbeat_outcomes (session_key, run_session_key, outcome, summary, occurred_at, updated_at) VALUES (?, ?, 'done', 'complete', 20, 20)",
        )
        .run(sourceAlias, sourceAlias);
      opsDatabase.db.exec("PRAGMA foreign_keys = OFF;");
      opsDatabase.db.prepare("DELETE FROM session_windows WHERE session_id = 'winner'").run();
      opsDatabase.db.exec("PRAGMA foreign_keys = ON;");

      const report = await repairCanonicalSessionKeys({ apply: true, cfg, env });
      expect(report).toMatchObject({ foundGroups: 1, removedRows: 2, repairedGroups: 1 });
      expect(report.archivedTranscriptDirectories).toHaveLength(2);
      const repairedEntry = loadExactSessionEntryReadOnly({
        agentId: "main",
        env,
        sessionKey: "agent:main:shared",
        storePath: mainStore,
      })?.entry;
      expect(repairedEntry).toMatchObject({ sessionId: "winner", subject: "merged subject" });
      expect(repairedEntry?.archivedAt).toBeUndefined();
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
      await expect(
        loadTranscriptEvents({
          agentId: "main",
          env,
          sessionId: "winner-previous",
          sessionKey: "agent:main:shared",
          storePath: mainStore,
        }),
      ).resolves.toEqual([
        expect.objectContaining({
          message: expect.objectContaining({ content: "previous generation history" }),
        }),
      ]);
      await expect(
        loadTranscriptEvents({
          agentId: "main",
          env,
          sessionId: "destination-only",
          sessionKey: "agent:main:shared",
          storePath: mainStore,
        }),
      ).resolves.toEqual([
        expect.objectContaining({
          message: expect.objectContaining({ content: "destination-only history" }),
        }),
      ]);
      const mainDatabase = openOpenClawAgentDatabase({
        agentId: "main",
        env,
        path: resolveSqliteTargetFromSessionStorePath(mainStore, { agentId: "main", env }).path,
      });
      expect(
        mainDatabase.db
          .prepare("SELECT session_key FROM session_windows ORDER BY session_id")
          .all(),
      ).toEqual([
        { session_key: "agent:main:shared" },
        { session_key: "agent:main:shared" },
        { session_key: "agent:main:shared" },
      ]);
      expect(
        mainDatabase.db
          .prepare(
            "SELECT previous_session_id, updated_at FROM session_windows WHERE session_id = 'winner'",
          )
          .get(),
      ).toEqual({ previous_session_id: "destination-only", updated_at: 20 });
      expect(
        mainDatabase.db
          .prepare("SELECT display_name FROM session_nodes WHERE session_key = 'agent:main:shared'")
          .get(),
      ).toEqual({ display_name: "merged subject" });
      expect(mainDatabase.db.prepare("SELECT session_key FROM board_tabs").get()).toEqual({
        session_key: "agent:main:shared",
      });
      expect(mainDatabase.db.prepare("SELECT session_key FROM board_widgets").get()).toEqual({
        session_key: "agent:main:shared",
      });
      expect(mainDatabase.db.prepare("SELECT session_key FROM session_members").get()).toEqual({
        session_key: "agent:main:shared",
      });
      expect(
        mainDatabase.db
          .prepare("SELECT session_key, run_session_key FROM heartbeat_outcomes")
          .get(),
      ).toEqual({
        session_key: "agent:main:shared",
        run_session_key: "agent:main:shared",
      });
      expect(
        loadExactSessionEntryReadOnly({
          agentId: "ops",
          env,
          sessionKey: sourceAlias,
          storePath: opsStore,
        }),
      ).toBeUndefined();
      const archiveContents = report.archivedTranscriptDirectories.flatMap((archiveDirectory) =>
        fs
          .readdirSync(archiveDirectory)
          .filter((name) => name.startsWith("winner.jsonl"))
          .map((name) => readSessionArchiveContentSync(path.join(archiveDirectory, name))),
      );
      expect(archiveContents).toEqual(
        expect.arrayContaining([
          expect.stringContaining("cross-store history"),
          expect.stringContaining("stale destination history"),
        ]),
      );

      insertLegacySession({
        agentId: "ops",
        entry: { sessionId: "destination-only", updatedAt: 5 },
        env,
        eventText: "late stale history",
        sessionKey: "agent:main:main\t",
        storePath: opsStore,
      });
      opsDatabase.db
        .prepare(
          "INSERT INTO session_members (session_key, identity_id, added_by, added_at) VALUES ('agent:main:main' || char(9), 'stale-member', 'owner-2', 5)",
        )
        .run();
      expect(await repairCanonicalSessionKeys({ apply: true, cfg, env })).toMatchObject({
        foundGroups: 1,
        removedRows: 1,
        repairedGroups: 1,
      });
      await expect(
        loadTranscriptEvents({
          agentId: "main",
          env,
          sessionId: "destination-only",
          sessionKey: "agent:main:shared",
          storePath: mainStore,
        }),
      ).resolves.toEqual([
        expect.objectContaining({
          message: expect.objectContaining({ content: "destination-only history" }),
        }),
      ]);
      expect(
        mainDatabase.db
          .prepare("SELECT identity_id FROM session_members ORDER BY identity_id")
          .all(),
      ).toEqual([{ identity_id: "member-1" }]);
    });
  });
});
