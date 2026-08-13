# Operation Budgets Design

## Goal

Make every public request budget authoritative at the first safe parsing boundary, while retaining cache defence-in-depth and preserving the public TypeScript input shapes. Oversized arrays must fail before item validation, repository discovery, cache inspection, or intermediate mapping and set allocation.

## Chosen approach

Add one dependency-free `src/operation-budgets.ts` module containing immutable budget specifications. Consumers import the same values rather than declaring local numeric maxima. This is preferred over keeping constants in `src/cache.ts`, which would preserve parser/cache coupling and invite dependency cycles, and over a configurable budget framework, which is outside the fixed-budget scope of MAR-2561.

The authority contains:

```ts
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
```

The module imports nothing and is not re-exported through `src/index.ts`; it remains an internal authority and does not expand the package API. Artifact limits remain in `src/schema.ts`: artifacts already enforce their fixed count before mapping, and moving them is unnecessary for this ticket.

## Parsing and validation

`src/api-input.ts` replaces the generic `optionalLimit` maximum of 1,000 with operation-specific parsing backed by the shared specifications:

- list and full search use `fullResultLimit`, accepting 1–50;
- compact search and gather use `compactResultLimit`, accepting 1–100;
- full and compact search have distinct internal parser entry points backed by one private common parser, preventing callers from pairing the wrong maximum with a mode;
- gather checks `searches.length` against 16 and `shows.length` against 64 before `.every`, `.map`, query parsing, or ID validation.

`src/schema.ts` checks `supersedes.length` against 1,000 before mapping IDs or constructing a uniqueness `Set`, for both candidate input and canonical record parsing. `src/records.ts` consumes the same numeric authority for the aggregate 1,000-edge corpus limit. Exactly 1,000 targets remains accepted by the per-record parser; aggregate graph validation remains independently authoritative for the complete corpus.

Empty and omitted arrays preserve their current semantics. Sparse arrays, accessor-bearing input envelopes, and proxy-specific behaviour remain the scope of MAR-2572 and are not changed here.

## Cache execution

`src/cache.ts` consumes the shared constants and retains its defensive assertions for result counts, query bytes, query terms, gather counts, and full-response bytes. Public parsing is the first authoritative boundary; cache checks protect internal callers and future refactors. Both layers use the same specification, stable budget name, field, and maximum.

All request parsing and count checks occur before `resolveRepository`, cache-location inspection, SQLite access, or hydration. The default result limit remains 20.

## CLI and documentation

`src/cli.ts` parameterises `parseLimit` by the shared budget specification. List and non-compact search use the full limit; `search --compact` and gather use the compact limit. Search selects its specification after parsing the `--compact` flag but before invoking the API.

Help text interpolates the shared values and states:

- list and full search accept 1–50 results;
- compact search and gather accept 1–100 results per search;
- gather accepts at most 16 searches and 64 shows;
- add accepts at most 1,000 supersession targets.

README and the maintained contract describe the same public limits. Package checks run the packed CLI, validate the help fragments, and exercise one over-limit full and compact request so packaged behaviour cannot drift from source behaviour.

## Error contract

Budget failures remain `INVALID_ARGUMENT`. A shared internal helper in `src/errors.ts` constructs details containing only:

```ts
{ field, budget, maximum }
```

Existing stable budget names remain unchanged: `fullResultLimit`, `compactResultLimit`, `queryBytes`, `queryTerms`, `gatherSearches`, `gatherShows`, and `fullResponseBytes`. The new supersedes count uses `supersessionEdges`. Messages are concise and operation-specific. Details never include arrays, individual values, queries, paths, or other input contents.

CLI failures retain exit status 2 and structured JSON. CLI-specific text names the applicable range rather than the removed generic 1–1,000 range.

## Component boundaries

- `src/operation-budgets.ts` owns fixed budget data and has no dependencies.
- `src/errors.ts` owns bounded `INVALID_ARGUMENT` construction, without knowing parser or cache behaviour.
- `src/api-input.ts` owns public input-envelope parsing and the earliest request checks.
- `src/schema.ts` owns record-field validation, including supersedes count-before-normalisation.
- `src/cache.ts` owns defensive execution checks and response accounting.
- `src/cli.ts` owns command-mode selection and help rendering.
- `src/records.ts` owns aggregate corpus-edge validation using the same supersession maximum.

No public input or result type changes. No pagination, configurable limits, streaming response work, response-budget increases, or unrelated array hardening is introduced.

## Verification

The smallest complementary behavioural matrix covers:

- pure full and compact parser boundaries at the maximum and one over, with exact bounded details;
- 17 gather searches and 65 shows whose first ordinary element is invalid, proving the count error wins before item validation and before repository/cache access;
- 1,001 supersedes whose first ordinary element is invalid, proving the count error wins before ID validation, mapping, uniqueness allocation, or repository access;
- strengthened existing cache budget assertions for exact field, budget, maximum, and no cache path;
- CLI list/full-search and compact-search/gather boundaries, exact help ranges, exit status, and structured details;
- packed CLI help and representative full/compact over-limit failures;
- unchanged query-byte, query-term, response-byte, empty-array, duplicate-order, public type, and package declaration regressions.

Tests use ordinary dense arrays. They do not add proxies, getters, sparse arrays, or accessor semantics belonging to MAR-2572.
