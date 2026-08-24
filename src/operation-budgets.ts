/** @internal */
export const OPERATION_BUDGETS = Object.freeze({
  baselineObservationAttempts: Object.freeze({ field: 'baselineObservationAttempts', maximum: 3 }),
  baselineObservationRetryMilliseconds: Object.freeze({
    field: 'baselineObservationRetryMilliseconds',
    maximum: 60_000,
  }),
  canonicalSnapshotAttempts: Object.freeze({ field: 'canonicalSnapshotAttempts', maximum: 3 }),
  canonicalSnapshotRetryMilliseconds: Object.freeze({ field: 'canonicalSnapshotRetryMilliseconds', maximum: 60_000 }),
  compactResponseBytes: Object.freeze({ field: 'response', maximum: 4 * 1024 * 1024 }),
  compactResultLimit: Object.freeze({ default: 20, field: 'limit', maximum: 100, minimum: 1 }),
  fullResponseBytes: Object.freeze({ field: 'response', maximum: 4 * 1024 * 1024 }),
  fullResultLimit: Object.freeze({ default: 20, field: 'limit', maximum: 50, minimum: 1 }),
  gatherResponseBytes: Object.freeze({ field: 'response', maximum: 4 * 1024 * 1024 }),
  gatherSearches: Object.freeze({ field: 'searches', maximum: 16 }),
  gatherShows: Object.freeze({ field: 'shows', maximum: 64 }),
  queryBytes: Object.freeze({ field: 'query', maximum: 1024 }),
  queryTerms: Object.freeze({ field: 'query', maximum: 32 }),
  supersessionEdges: Object.freeze({ field: 'supersedes', maximum: 1000 }),
} as const)
