export const OPERATION_BUDGETS = {
  compactResultLimit: { default: 20, field: 'limit', maximum: 100, minimum: 1 },
  fullResponseBytes: { field: 'response', maximum: 4 * 1024 * 1024 },
  fullResultLimit: { default: 20, field: 'limit', maximum: 50, minimum: 1 },
  gatherSearches: { field: 'searches', maximum: 16 },
  gatherShows: { field: 'shows', maximum: 64 },
  queryBytes: { field: 'query', maximum: 1024 },
  queryTerms: { field: 'query', maximum: 32 },
  supersessionEdges: { field: 'supersedes', maximum: 1000 },
} as const
