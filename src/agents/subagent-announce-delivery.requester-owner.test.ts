import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { loadRequesterSessionEntry, testing } from "./subagent-announce-delivery.test-support.js";

afterEach(() => {
  testing.setDepsForTest();
});

describe("subagent requester session ownership", () => {
  it("loads an unscoped requester key through its supplied owner", () => {
    const loadSessionEntry = vi.fn(() => ({
      sessionId: "requester-session",
      updatedAt: 1,
    }));
    const cfg = {
      agents: {
        ownership: "explicit",
        entries: { main: {}, work: {} },
      },
      session: { store: "/tmp/shared-sessions.json" },
    } satisfies OpenClawConfig;
    testing.setDepsForTest({
      getRuntimeConfig: () => cfg,
      loadSessionEntry: loadSessionEntry as never,
    });

    expect(loadRequesterSessionEntry("global", "work")).toMatchObject({
      canonicalKey: "global",
      entry: { sessionId: "requester-session" },
    });
    expect(loadSessionEntry).toHaveBeenCalledWith({
      storePath: "/tmp/shared-sessions.json",
      sessionKey: "global",
      agentId: "work",
      clone: false,
    });
  });
});
