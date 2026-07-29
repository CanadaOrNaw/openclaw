import { isDeepStrictEqual } from "node:util";
import { tryCronScheduleIdentity } from "../schedule-identity.js";
import type { CronJob } from "../types.js";

type CronRuntimeDeltaResolution = "write" | "preserve" | "conflict";

/** Resolves one state-only delta against the row state the caller originally loaded. */
export function resolveCronRuntimeDelta(params: {
  current: CronJob["state"];
  next: CronJob["state"];
  expected: CronJob["state"];
}): CronRuntimeDeltaResolution {
  const currentChanged = !isDeepStrictEqual(params.current, params.expected);
  const nextChanged = !isDeepStrictEqual(params.next, params.expected);
  if (!currentChanged) {
    return "write";
  }
  if (!nextChanged || isDeepStrictEqual(params.current, params.next)) {
    return "preserve";
  }
  return "conflict";
}

function runtimePreservationIdentity(
  job: CronJob,
): { id: string; schedulingIdentity: string } | undefined {
  // The canonical scheduling identity includes enabled, schedule, pacing, and trigger presence.
  const schedulingIdentity = tryCronScheduleIdentity(job as unknown as Record<string, unknown>);
  return schedulingIdentity ? { id: job.id, schedulingIdentity } : undefined;
}

/** Preserves a concurrent runtime-only write when the full-save caller left that state untouched. */
export function preserveConcurrentCronRuntime(params: {
  current: CronJob | undefined;
  next: CronJob;
  expectedRuntimeState: CronJob["state"];
}): CronJob {
  const currentIdentity = params.current ? runtimePreservationIdentity(params.current) : undefined;
  const nextIdentity = runtimePreservationIdentity(params.next);
  if (
    !params.current ||
    !currentIdentity ||
    !nextIdentity ||
    currentIdentity.id !== nextIdentity.id ||
    currentIdentity.schedulingIdentity !== nextIdentity.schedulingIdentity
  ) {
    return params.next;
  }
  const incomingState = params.next.state ?? {};
  const currentState = params.current.state ?? {};
  if (
    !isDeepStrictEqual(incomingState, params.expectedRuntimeState) ||
    isDeepStrictEqual(currentState, params.expectedRuntimeState)
  ) {
    return params.next;
  }
  // Metadata-only edits keep a concurrently changed row, while intentional state edits win.
  return {
    ...params.next,
    updatedAtMs: Math.max(params.next.updatedAtMs, params.current.updatedAtMs),
    state: structuredClone(currentState),
  };
}
