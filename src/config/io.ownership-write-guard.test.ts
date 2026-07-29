import { describe, expect, it } from "vitest";
import { assertAutomaticBindingsWriteAllowed } from "./io.ownership-write-guard.js";

const binding = { agentId: "ops", match: { channel: "telegram" } };

describe("automatic ownership binding write guard", () => {
  it("allows include-owned bindings when no append is required", () => {
    expect(() =>
      assertAutomaticBindingsWriteAllowed({
        bindingsIncludeOwned: true,
        ownershipPaths: [["bindings", "0"]],
        sourceBindings: [binding],
        nextBindings: [binding],
      }),
    ).not.toThrow();
  });

  it("rejects an automatic append into include-owned bindings", () => {
    expect(() =>
      assertAutomaticBindingsWriteAllowed({
        bindingsIncludeOwned: true,
        ownershipPaths: [["bindings"]],
        sourceBindings: [],
        nextBindings: [binding],
      }),
    ).toThrow("cannot append to $include-owned bindings");
  });
});
