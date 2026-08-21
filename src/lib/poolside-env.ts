import type { PoolsideEnv } from "../../API/poolside";

/**
 * Resolve the Poolside API key supporting both spellings.
 * Canonical: POOLSIDE_API_KEY (2 O's). Legacy alias: POOOLSIDE_API_KEY (3 O's).
 * Legacy takes precedence for backward compat if both are set.
 */
export function getPoolsideApiKey(env: PoolsideEnv): string | undefined {
  const legacy = (env as Record<string, string | undefined>)["POOOLSIDE_API_KEY"];
  const canonical = (env as Record<string, string | undefined>)["POOLSIDE_API_KEY"];
  return legacy ?? canonical;
}

export function hasPoolsideKey(env: PoolsideEnv): boolean {
  return !!getPoolsideApiKey(env);
}
