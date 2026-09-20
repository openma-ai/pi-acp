/**
 * `_meta` namespace owned by this adapter. See docs/metadata.md for the registry.
 */
export const META_NS = "pi";

export function piMeta(value: Record<string, unknown>): { [META_NS]: Record<string, unknown> } {
  return { [META_NS]: value };
}

/** Read a namespaced block from an incoming `_meta`, when present. */
export function readPiMeta(meta: unknown): Record<string, unknown> | undefined {
  if (meta === null || typeof meta !== "object") return undefined;
  const block = (meta as Record<string, unknown>)[META_NS];
  return block !== null && typeof block === "object" ? (block as Record<string, unknown>) : undefined;
}
