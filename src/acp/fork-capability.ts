// Contract owned by openma-ai/openma-common (src/acp-runtime/fork-support.ts, ACP_INCLUSIVE_FORK_CAPABILITY). Keep byte-identical.
export const ACP_INCLUSIVE_FORK_VERSION = 1 as const;

export interface AcpInclusiveForkCapability {
  version: typeof ACP_INCLUSIVE_FORK_VERSION;
  inclusive: true;
}

export const ACP_INCLUSIVE_FORK_CAPABILITY: AcpInclusiveForkCapability = Object.freeze({
  version: ACP_INCLUSIVE_FORK_VERSION,
  inclusive: true,
});

/** `{ jetbrains: { air: { fork: ACP_INCLUSIVE_FORK_CAPABILITY } } }`, to deep-merge into agentCapabilities._meta. */
export function acpInclusiveForkCapabilityMeta(): {
  jetbrains: { air: { fork: AcpInclusiveForkCapability } };
} {
  return { jetbrains: { air: { fork: ACP_INCLUSIVE_FORK_CAPABILITY } } };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Deep-merge capability metadata so `jetbrains` does not replace `pi` or `authStatus`. */
export function mergeCapabilityMeta(
  base: Record<string, unknown>,
  extra: Record<string, unknown>,
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(extra)) {
    const current = merged[key];
    merged[key] = isRecord(current) && isRecord(value) ? mergeCapabilityMeta(current, value) : value;
  }
  return merged;
}
