import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const gatewayCall = vi.fn();

vi.mock("../../gateway/call.js", () => ({
  callGateway: (request: unknown) => gatewayCall(request),
}));

vi.mock("./sessions-send-tool.a2a.js", () => ({
  runSessionsSendA2AFlow: vi.fn(),
}));

let createSessionsSendTool: typeof import("./sessions-send-tool.js").createSessionsSendTool;

beforeAll(async () => {
  ({ createSessionsSendTool } = await import("./sessions-send-tool.js"));
});

beforeEach(() => {
  gatewayCall.mockReset();
});

function createTool(options: { a2aEnabled?: boolean } = {}) {
  return createSessionsSendTool({
    agentId: "main",
    agentSessionKey: "agent:main:main",
    config: {
      agents: { ownership: "explicit", entries: { main: {}, other: {} } },
      tools: {
        agentToAgent: { enabled: options.a2aEnabled ?? false },
        sessions: { visibility: "all" },
      },
    },
  });
}

function details(result: { details?: unknown }) {
  if (!result.details || typeof result.details !== "object") {
    throw new Error("expected sessions_send details");
  }
  return result.details as Record<string, unknown>;
}

describe("sessions_send resolved-owner authorization", () => {
  it("denies a bare key resolved to another agent when A2A is disabled", async () => {
    gatewayCall.mockImplementation(async (request: { method?: string }) => {
      if (request.method === "sessions.resolve") {
        return { key: "incident-42", agentId: "other" };
      }
      return {};
    });

    const result = await createTool().execute("cross-agent-bare", {
      sessionKey: "b0d79b63-0f73-4bc9-a6b5-6d8e20f42c3c",
      message: "status?",
      timeoutSeconds: 0,
    });

    expect(details(result)).toMatchObject({
      status: "forbidden",
      error: expect.stringContaining("Agent-to-agent messaging is disabled"),
    });
    expect(gatewayCall).not.toHaveBeenCalledWith(expect.objectContaining({ method: "agent" }));
  });

  it("allows a bare key resolved to the requester agent", async () => {
    gatewayCall.mockImplementation(async (request: { method?: string }) => {
      if (request.method === "sessions.resolve") {
        return { key: "incident-42", agentId: "main" };
      }
      if (request.method === "agent") {
        return { runId: "run-same-agent", acceptedAt: 1 };
      }
      return {};
    });

    const result = await createTool().execute("same-agent-bare", {
      sessionKey: "b0d79b63-0f73-4bc9-a6b5-6d8e20f42c3c",
      message: "status?",
      timeoutSeconds: 0,
    });

    expect(details(result).status).toBe("accepted");
    expect(gatewayCall).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "agent",
        params: expect.objectContaining({ agentId: "main", sessionKey: "incident-42" }),
      }),
    );
  });

  it("keeps an owned global sentinel subject to cross-agent policy", async () => {
    gatewayCall.mockImplementation(async (request: { method?: string }) => {
      if (request.method === "sessions.resolve") {
        return { key: "global", agentId: "other" };
      }
      return {};
    });

    const result = await createTool().execute("cross-agent-global", {
      sessionKey: "b0d79b63-0f73-4bc9-a6b5-6d8e20f42c3c",
      message: "status?",
      timeoutSeconds: 0,
    });

    expect(details(result)).toMatchObject({
      status: "forbidden",
      error: expect.stringContaining("Agent-to-agent messaging is disabled"),
    });
  });

  it("denies a malformed agent-prefixed key owned by another agent", async () => {
    gatewayCall.mockImplementation(async (request: { method?: string }) => {
      if (request.method === "sessions.resolve") {
        return { key: "agent:broken", agentId: "other" };
      }
      return {};
    });

    const result = await createTool().execute("cross-agent-malformed", {
      sessionKey: "d8b7b15b-fc10-4a9b-810b-e65e7ed2c3b0",
      message: "status?",
      timeoutSeconds: 0,
    });

    expect(details(result)).toMatchObject({
      status: "forbidden",
      error: expect.stringContaining("Agent-to-agent messaging is disabled"),
    });
    expect(gatewayCall).not.toHaveBeenCalledWith(expect.objectContaining({ method: "agent" }));
  });

  it("carries a bare main session owner through resolve and create", async () => {
    gatewayCall.mockImplementation(
      async (request: { method?: string; params?: { agentId?: string } }) => {
        if (request.method === "sessions.resolve" && request.params?.agentId === "other") {
          throw new Error("missing");
        }
        if (request.method === "sessions.resolve") {
          return { key: "main", agentId: "other" };
        }
        if (request.method === "sessions.create") {
          return { key: "main", agentId: "other" };
        }
        if (request.method === "agent") {
          return { runId: "run-other-main", acceptedAt: 1 };
        }
        return {};
      },
    );

    const result = await createTool({ a2aEnabled: true }).execute("other-main", {
      sessionKey: "33c37740-d450-44d1-90f6-abbdd4aabf88",
      message: "status?",
      timeoutSeconds: 0,
    });

    expect(details(result).status).toBe("accepted");
    expect(gatewayCall).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "sessions.resolve",
        params: { key: "main", agentId: "other" },
      }),
    );
    expect(gatewayCall).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "sessions.create",
        params: { key: "main", agentId: "other" },
      }),
    );
  });
});
