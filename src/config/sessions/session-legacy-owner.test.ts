import path from "node:path";
import { withTempHome } from "openclaw/plugin-sdk/test-env";
import { describe, expect, it } from "vitest";
import { retainLegacyDefaultAgentId } from "../legacy.default-agent-owner.js";
import type { OpenClawConfig } from "../types.openclaw.js";
import { loadCombinedSessionStoreForGateway } from "./combined-store-gateway.js";
import { replaceSessionEntry } from "./session-accessor.js";
import { persistSessionTranscriptTurn } from "./session-accessor.transcript-turn.js";

function retainedOwnerConfig(storePath: string): OpenClawConfig {
  return retainLegacyDefaultAgentId(
    {
      agents: { ownership: "explicit", entries: { ops: {}, research: {} } },
      session: { store: storePath },
    },
    "ops",
  );
}

describe("retained legacy session ownership", () => {
  it("attributes a fixed-store bare row to the retained owner", async () => {
    await withTempHome(async (home) => {
      const storePath = path.join(home, "sessions.json");
      const cfg = retainedOwnerConfig(storePath);
      await replaceSessionEntry(
        { agentId: "ops", sessionKey: "main", storePath },
        { sessionId: "legacy-fixed-session", updatedAt: 1 },
      );

      expect(loadCombinedSessionStoreForGateway(cfg).store).toHaveProperty("agent:ops:main");
    });
  });

  it("resolves retained ownership for guarded and ordinary transcript turns", async () => {
    await withTempHome(async (home) => {
      const storePath = path.join(home, "sessions.json");
      const cfg = retainedOwnerConfig(storePath);
      const scope = {
        sessionId: "legacy-transcript-session",
        sessionKey: "main",
        storePath,
      };
      await replaceSessionEntry(
        { agentId: "ops", sessionKey: "main", storePath },
        { sessionId: scope.sessionId, updatedAt: 1 },
      );

      await expect(
        persistSessionTranscriptTurn(scope, { config: cfg, messages: [], updateMode: "none" }),
      ).resolves.toMatchObject({ appendedCount: 0 });
      await expect(
        persistSessionTranscriptTurn(scope, {
          config: cfg,
          expectedSessionId: scope.sessionId,
          messages: [],
          updateMode: "none",
        }),
      ).resolves.toMatchObject({ appendedCount: 0 });
    });
  });
});
