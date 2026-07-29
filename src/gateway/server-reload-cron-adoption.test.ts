import { describe, expect, it, vi } from "vitest";
import type { GatewayCronServiceContract } from "./server-cron-contract.js";
import { beginGatewayCronConfigAdoption } from "./server-reload-cron-adoption.js";

function createCron() {
  let owner = "current";
  const rejectConfigAdoption = vi.fn(async () => {
    owner = "current";
  });
  const cron = {
    reloadForConfigAdoption: vi.fn(async () => {
      owner = "candidate";
    }),
    completeConfigAdoption: vi.fn(() => {
      owner = "committed";
    }),
    rejectConfigAdoption,
  } as unknown as GatewayCronServiceContract;
  return { cron, owner: () => owner, rejectConfigAdoption };
}

describe("Gateway cron config adoption", () => {
  it("restores the current scheduler owner when preparation is rejected", async () => {
    const fixture = createCron();
    const adoption = await beginGatewayCronConfigAdoption({
      cron: fixture.cron,
      enabled: true,
      nextConfig: { agents: { ownership: "explicit", entries: { ops: {}, research: {} } } },
      failureLabel: "test reload failed",
    });

    expect(fixture.owner()).toBe("candidate");
    const failure = new Error("secret preparation failed");
    await expect(adoption?.reject(failure)).resolves.toBe(failure);
    expect(fixture.owner()).toBe("current");
    expect(fixture.rejectConfigAdoption).toHaveBeenCalledOnce();
  });

  it("commits the candidate without rollback after the acceptance edge", async () => {
    const fixture = createCron();
    const adoption = await beginGatewayCronConfigAdoption({
      cron: fixture.cron,
      enabled: true,
      nextConfig: { agents: { entries: { ops: {} } } },
      failureLabel: "test reload failed",
    });

    adoption?.complete();
    await adoption?.reject(new Error("late failure"));
    expect(fixture.owner()).toBe("committed");
    expect(fixture.rejectConfigAdoption).not.toHaveBeenCalled();
  });

  it("does not let a superseded candidate roll back a newer adoption", async () => {
    let releaseFirstReload!: () => void;
    const firstReload = new Promise<void>((resolve) => {
      releaseFirstReload = resolve;
    });
    let owner = "current";
    const reloadForConfigAdoption = vi
      .fn()
      .mockImplementationOnce(async () => {
        await firstReload;
        owner = "candidate-a";
      })
      .mockImplementationOnce(async () => {
        owner = "candidate-b";
      });
    const cron = {
      reloadForConfigAdoption,
      completeConfigAdoption: vi.fn(() => {
        owner = "committed-b";
      }),
      rejectConfigAdoption: vi.fn(async () => {
        owner = "current";
      }),
    } as unknown as GatewayCronServiceContract;

    const candidateA = beginGatewayCronConfigAdoption({
      cron,
      enabled: true,
      nextConfig: { agents: { entries: { ops: {} } } },
      failureLabel: "candidate A failed",
    });
    const candidateB = beginGatewayCronConfigAdoption({
      cron,
      enabled: true,
      nextConfig: { agents: { entries: { research: {} } } },
      failureLabel: "candidate B failed",
    });
    await vi.waitFor(() => {
      expect(reloadForConfigAdoption).toHaveBeenCalledTimes(1);
    });

    releaseFirstReload();
    const adoptionA = await candidateA;
    await adoptionA?.reject(new Error("superseded"));
    const adoptionB = await candidateB;
    adoptionB?.complete();

    expect(reloadForConfigAdoption).toHaveBeenCalledTimes(2);
    expect(owner).toBe("committed-b");
  });
});
