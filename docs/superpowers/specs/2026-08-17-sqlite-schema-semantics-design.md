# SQLite Schema Semantics Design

## Goal

Treat the disposable SQLite cache schema as untrusted structure rather than accepting tables merely because their columns have familiar names. A cache is compatible only when its ordinary tables, columns, constraints, required indexes, and FTS5 layout provide the semantics assumed by cache reads and rebuilds. Any mismatch follows the existing exact-generation quarantine, one-rebuild, one-retry policy and never changes canonical JSON or the public API.

## Chosen approach

Keep schema creation, validation, and recovery orchestration in `src/cache.ts`. The cache module already owns the DDL, prepared statements, bounded integrity probes, single-snapshot reader transaction, and recoverable `CacheSchemaMismatch` classification. Extracting a schema module would either duplicate those authorities or create a cache-specific abstraction with no independent consumer.

Replace the name-only table checks with three complementary validators:

1. structured, bounded PRAGMA validation for ordinary tables and their columns;
2. structured, bounded PRAGMA validation for the required records indexes;
3. bounded owned-object SQL checks only for semantics that SQLite PRAGMAs do not expose: the records `active` check and the exact FTS5 declaration.

The SQL text is an internal validation input, not a public formatting contract. Checks accept harmless whitespace, keyword casing, optional identifier quoting, and the historical `IF NOT EXISTS` spelling while rejecting semantic changes.

`user_version` and `application_id` are not added. The existing metadata `schemaVersion` remains the compatibility version, and header identifiers would not prove the constraints, indexes, or FTS options required by this ticket.

## Ordinary table descriptors

`metadata` and `records` use one immutable expected-column description containing:

- ordinal position;
- exact name;
- declared type (`TEXT` or `INTEGER`);
- `NOT NULL` flag;
- primary-key ordinal;
- absence of a default;
- ordinary visible-column state.

Validation first runs a numeric-only probe over `pragma_table_list` and a nested, bounded `pragma_table_xinfo` selection. The probe transfers only a bounded row count and exact flags. It requires a single `main` rowid, non-strict ordinary table, exactly the expected number of visible columns, bounded text fields, no hidden or generated columns, and no defaults. Only after the probe succeeds may a bounded iterator read the expected descriptor rows ordered by `cid` and compare exact tuples.

The expected tuples match the schema that this package already creates. In particular, SQLite reports the current `TEXT PRIMARY KEY` columns with `notnull = 0`; the validator does not silently strengthen the DDL.

## Records constraint and indexes

Column PRAGMAs do not expose `CHECK` clauses. The records table therefore receives a separate bounded `sqlite_schema.sql` probe followed by a narrow check for `CHECK (active IN (0, 1))`. The check tolerates whitespace, casing, and identifier quoting but not a widened set, additional disjunct, or missing constraint. Existing row-content validation continues to require every stored `active` value to be the SQLite integer zero or one.

Required records indexes are validated structurally:

- exactly two application-created indexes exist on `records`;
- their names are exactly `records_active_order` and `records_kind_subject`;
- both are non-unique, non-partial indexes with `origin = 'c'`;
- `records_active_order` key columns are `active ASC`, `created_at DESC`, `id DESC`, each with `BINARY` collation;
- `records_kind_subject` key columns are `kind ASC`, `subject ASC`, each with `BINARY` collation;
- expressions, extra key columns, reordered columns, renamed indexes, and additional application-created indexes are incompatible.

Numeric-only probes over bounded `pragma_index_list` and `pragma_index_xinfo` selections precede every bounded text read. SQLite-generated primary-key autoindexes are not identified by generated names and are not counted as application-created indexes.

## FTS5 schema

`record_search` remains a separate virtual-table validation path. A bounded `sqlite_schema` probe proves that exactly one bounded text definition exists. The subsequent strict semantic matcher accepts only an FTS5 table named `record_search` with this logical declaration:

```sql
fts5(id UNINDEXED, text)
```

It accepts harmless formatting and identifier quoting but rejects an ordinary table, indexed `id`, unindexed `text`, reversed or extra columns, external/contentless tables, custom tokenizers, prefixes, or changed `detail` and `columnsize` options. This preserves the assumptions behind joins, `bm25`, and `snippet(..., 1, ...)` without making raw schema SQL a public contract.

FTS row text equality remains MAR-2550. This ticket validates the virtual-table semantics only.

## Metadata uniqueness

The metadata schema primary key is authoritative, but row validation remains defensive. The bounded metadata iteration rejects a key already present in the local `Map` before assigning it. A malformed table without its key constraint therefore cannot hide a duplicate by overwriting an earlier value, even if its total row count still equals six.

## Writer ordering and exact recovery

Readers already begin one SQLite transaction before `assertCacheSchema`, metadata validation, content validation, freshness decisions, and the public read. That snapshot boundary remains unchanged.

Writers must stop repairing incompatible databases in place. `openVerifiedCacheDatabase` will report whether it exclusively created the primary used by the verified open:

- a confirmed-new empty primary receives the canonical schema, then immediately validates it;
- an existing or expected-owned primary validates before any `journal_mode` or `CREATE` statement can mutate it;
- the rebuild transaction validates again after `BEGIN IMMEDIATE` and before deleting or inserting rows.

Schema creation uses ordinary `CREATE` statements only for a confirmed-new primary. It does not use `IF NOT EXISTS` as a migration mechanism. A mismatch on an existing generation throws `CacheSchemaMismatch` through the verified-open boundary, retaining the exact primary and sidecar identities already used by MAR-2549 recovery. The central recovery coordinator quarantines that exact generation under the operation lock, rebuilds once from canonical JSON, and retries once. A second mismatch is terminal and bounded.

No in-place migration, truncation, best-effort repair, or schema text is exposed through public error messages, details, or causes.

## Component boundaries

- `src/cache.ts` owns canonical cache DDL, expected schema descriptors, bounded PRAGMA and owned-SQL checks, metadata uniqueness, cache read/write transactions, and recovery classification.
- `src/cache-location.ts` owns verified database creation/open identity and reports whether the verified primary was created by that call.
- `src/sqlite-error.ts` and `src/errors.ts` retain SQLite categorisation and public error wrapping.
- Canonical records, cache value budgets, FTS content equality, and public API types do not change.

No new public export, package dependency, cache migration API, CLI option, or canonical record field is introduced.

## Verification

The smallest complementary behavioural matrix covers:

- same-name ordinary tables with missing primary keys, changed nullability, types, defaults, hidden/generated columns, or a widened/missing `active` constraint;
- required indexes missing, renamed, reordered, direction-changed, or otherwise structurally incompatible, plus a positive control created in a different order;
- an ordinary `record_search` table and FTS5 declarations with indexed IDs, reversed columns, changed unindexed columns, or custom options, plus harmless formatting controls;
- six metadata rows with one required key missing and a duplicate key, rejected before metadata text is accepted into the map;
- one representative public read proving exact corrupt-primary quarantine, one rebuild, canonical results, and a subsequent fresh prepare;
- forced writer preparation proving an incompatible existing database is quarantined rather than repaired in place;
- a second incompatible generation proving recovery remains bounded and private schema text never enters the terminal public error chain;
- a schema change attempt at the numeric-probe boundary proving the reader sees one transaction snapshot;
- a valid generated schema proving prepare, list, show, full and compact search, and gather do not alter the database.

Existing read-recovery coverage already proves the public routing matrix for recoverable cache failures, so individual semantic mutations use `prepare` and one representative read rather than duplicating every API by every corruption.

The complete lint, four-project typecheck, full test, benchmark, build, package, publish-contract, frozen-install, cross-platform CI, declaration, Bun configuration, plaintext lockfile, diff, and documentation-provenance gates remain required.

## Scope exclusions

- FTS row-text equality remains MAR-2550.
- Cached record JSON equality with canonical files remains MAR-2571.
- Per-operation cache-generation memoisation remains MAR-2552.
- In-place cache migration, user-configurable cache schemas, attached databases, triggers unrelated to the owned schema, and arbitrary same-user mutation inside SQLite's pathname-only open window remain out of scope.

## Reviewed implementation provenance

The exact reviewed code and behavioural-test snapshot implementing this design is `029775c46f4a07b56bac8985a098e61d27ea20a8`. Documentation changes do not alter the runtime API, package exports, canonical records, or generated declarations.
