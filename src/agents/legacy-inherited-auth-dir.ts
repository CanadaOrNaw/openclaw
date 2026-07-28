import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { tryGetLegacyDefaultAgentId } from "../config/legacy.default-agent-owner.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveAgentDir, tryResolveSoleAgentId } from "./agent-scope-config.js";

/** Resolves the shared auth store used until H2-2 relocates inherited credentials. */
export function resolveLegacyInheritedAuthDir(
  config: OpenClawConfig,
  env: NodeJS.ProcessEnv = process.env,
): string {
  // H2-2 owns credential relocation; this upgrade-only binding prevents marker retirement
  // from switching inherited credentials before that relocation completes.
  const inheritedOwnerId =
    normalizeOptionalString(config.agents?.defaults?.authInheritance?.agentId) ??
    tryGetLegacyDefaultAgentId(config) ??
    tryResolveSoleAgentId(config) ??
    "main";
  return resolveAgentDir(config, inheritedOwnerId, env);
}
