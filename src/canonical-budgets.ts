/** @internal */
export const CANONICAL_BUDGETS = Object.freeze({
  artifactReferences: 10_000,
  kindEntries: 50_000,
  recordBytes: 1024 * 1024,
  recordJsonBytes: 128 * 1024 * 1024,
  records: 50_000,
  supersessionEdges: 50_000,
} as const)
