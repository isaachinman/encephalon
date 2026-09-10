# Encephalon public contract

This is the normative development reference for the unreleased lean runtime intended for 0.4.0, not the already-published 0.3.0 package. The [README](../README.md) is the practical guide; [performance and contributor checks](./performance.md) describe maintainer tooling. Historical designs are evidence, not additional public requirements. Update this contract with any intentional public behaviour change.

## Runtime and repository

Encephalon supports Node.js 24.15.0 and later on Linux, macOS and Windows. Its installed runtime is synchronous ESM with zero runtime dependencies and no installation lifecycle scripts. Bun is development tooling only. The package exposes the root import `encephalon`; internal subpaths are unsupported. Its CLI help and version do not load repository operations.

Importing the API does not discover a repository, inspect or mutate the filesystem, or open SQLite. API calls return values and never print or exit. Encephalon performs no runtime network requests, telemetry, automatic Git operations, background work, semantic source analysis or credential discovery.

Every repository operation requires a valid Git repository and an installation exposed as its root `node_modules/encephalon`. The executing package must be that installation. Ephemeral package execution, workspace-local installations and Yarn Plug'n'Play are unsupported. User commands therefore use `npx --no-install encephalon` after root installation.

An explicit `root` resolves to that exact Git repository; it does not search parents. Without `root`, discovery walks upward from the current working directory to the nearest valid Git marker. Git worktrees with a valid marker file are supported. Repository markers, root/package identities and containment must remain valid through acceptance; malformed markers, unsafe manifests and changed roots fail with bounded errors. No operation may silently switch to a replacement repository.

## Public API

All input fields shown below are the complete supported surface. `root?: string` is available to every operation. Optional booleans default to false; optional list/search limits default to 20. `?` marks an optional field. Functions with optional input may be called without it; `gatherRecords` requires an input object, which may be empty.

| Function | Inputs besides `root` | Result |
| --- | --- | --- |
| `initEncephalon(input?)` | `refreshBaseline?: boolean`, `remove?: boolean` | `InitEncephalonResult` |
| `addRecord(input)` | `id?: string`, `kind: string`, `subject: string`, `source: string`, `payload: JsonValue`, `confidence?: number`, `supersedes?: string[]`, `artifacts?: string[]`, `searchText?: string` | Committed `BrainRecord` |
| `prepare(input?)` | None | `{ hydrated: boolean, recordsIndexed: number }` |
| `hydrate(input?)` | None | `{ recordsIndexed: number }` |
| `validateRecords(input?)` | None | `ValidateResult` |
| `listRecords(input?)` | `kind?: string`, `subject?: string`, `includeSuperseded?: boolean`, `limit?: number` | `BrainRecord[]` |
| `showRecord(input)` | `id: string`, `activeOnly?: boolean` | `BrainRecord` or `null` |
| `searchRecords(input)` | `query: string`, `kind?: string`, `includeSuperseded?: boolean`, `limit?: number` | `BrainRecord[]` |
| `searchCompactRecords(input)` | Same as `searchRecords` | `CompactBrainRecord[]` |
| `gatherRecords(input)` | `searches?: string[]`, `shows?: string[]`, `kind?: string`, `includeSuperseded?: boolean`, `limit?: number`, `hydrate?: boolean` | `GatherResult` |

`prepare` reuses an accepted fresh cache and sets `hydrated: false`, or rebuilds it and sets `hydrated: true`. `hydrate` forces a transactional rebuild. `recordsIndexed` counts the canonical records indexed, including superseded records. `validateRecords` validates canonical data and artifacts without accepting SQLite as authority. Invalid canonical data returns a validation result; repository, runtime and operational failures may throw.

```typescript
type CompactBrainRecord = {
  id: string;
  kind: string;
  subject: string;
  path: string;
  summary: string | null;
  rank: number;
  snippet: string;
};

type GatherResult = {
  hydrated: { recordsIndexed: number } | null;
  searches: Array<{
    query: string;
    kind: string | null;
    results: CompactBrainRecord[];
  }>;
  records: Array<{ id: string; record: BrainRecord | null }>;
};

type InitEncephalonResult = {
  recordsCreated: BrainRecord[];
  skippedConflicts: Array<{
    kind: string;
    subject: string;
    activeRecordIds: string[];
  }>;
  instructionFiles: Array<{
    file: 'AGENTS.md' | 'CLAUDE.md';
    action: 'removed' | 'updated';
  }>;
  nextAction: string;
};

type ValidationIssue = {
  code: string;
  message: string;
  path?: string;
  recordId?: string;
};

type ValidateResult = {
  valid: boolean;
  recordsChecked: number;
  errors: ValidationIssue[];
  truncated: boolean;
};
```

The package exports these types and `AddRecordInput`, `BrainRecord`, `BrainRecordFile`, `EncephalonErrorCode`, `GatherInput`, `HydrateResult`, `InitEncephalonInput`, `JsonPrimitive`, `JsonValue`, `ListRecordsInput`, `PrepareResult`, `RootInput`, `SearchRecordsInput` and `ShowRecordInput`. The packaged declarations are the authoritative machine-readable signatures.

Input envelopes accept ordinary cross-realm or null-prototype objects containing only allowed enumerable own data properties. Unknown keys, symbols, accessors, non-enumerable application fields, custom prototypes and unstable or failing reflection are invalid. Validation does not invoke getters or expose reflection-trap text. Optional fields set to `undefined` are treated as absent where allowed; `null` is not a substitute for an optional field.

Request arrays accept dense enumerable own data indices, including cross-realm arrays, and reject sparse arrays, accessors, extra named/symbol properties, non-enumerable indices and changes during validation. Count limits are checked before inspecting elements or allocating their output. Both gather array counts are checked before either array's item validation. Payload JSON follows its separate rules below.

## CLI

```text
encephalon [--root <path>] <command> [options]
```

| Command | Supported options and arguments |
| --- | --- |
| `init` | `--refresh-baseline`, `--remove` |
| `add` | Required `--kind`, `--subject`, `--source`, `--data <json>`; optional `--id`, `--confidence <0..1>`, `--text`, repeated `--supersedes <id>` and `--artifact <path>` |
| `prepare`, `hydrate`, `validate` | No command options |
| `list` | `--kind`, `--subject`, `--include-superseded`, `--limit <1..1000>` |
| `show` | Required `--id`; optional `--active-only` |
| `search` | One query argument; optional `--compact`, `--kind`, `--include-superseded`, `--limit <1..1000>` |
| `gather` | Repeated `--search <query>` and `--show <id>`; optional `--hydrate`, `--kind`, `--include-superseded`, `--limit <1..1000>` |

`--root <path>` or `--root=<path>` is global and may occur once before the `--` terminator. `--help`/`-h` and `--version`/`-v` work only when they are the sole remaining argument after root extraction; they are not per-command flags. Quote a multi-word search into one argument. Use `--` before a query beginning with a dash, and `--name=value` for option values beginning with a dash. Unsupported commands/options, missing values, repeated non-repeatable options and unexpected positional arguments fail with `INVALID_ARGUMENT`. `--data` parses JSON; `--text` maps to `searchText`; `--artifact` maps to `artifacts`.

Successful JSON commands write one JSON value to stdout and exit 0. Help/version write text. Expected user errors write `{ "error": { "code", "message", "details" } }` as one JSON value to stderr and exit 2. Internal errors exit 1 with a safe message. Canonical validation failures instead write `ValidateResult` to stdout and exit 2. CLI output omits stacks, raw causes and private absolute paths. JSON object property order is not a consumer contract.

## Search and ordering

List and search include active records by default. `includeSuperseded` includes history. Standalone `showRecord` includes history unless `activeOnly` is true; missing or filtered records return `null`. Gather shows follow its `includeSuperseded` flag and are active-only by default. The gather `kind` filter applies to searches, not explicitly requested show IDs. Empty result sets are arrays, never missing fields.

Lists sort by descending `createdAt`, then descending ordinal ID. Searches sort by ascending relevance rank, then descending creation time and ID. Rank is finite and lower values rank first; numerical scores are not comparable across changing corpora. Full and compact search use the same match and ordering rules.

Search input is literal text. The original UTF-8 bytes are bounded before NFC normalisation; accepted terms start with a Unicode letter or number, retain attached letters/numbers/combining marks and underscores that join such text, and are combined with AND. Input order and duplicate terms remain significant to expression construction. Quotes, punctuation, controls, operators and wildcards cannot inject query syntax. SQLite's default Unicode tokenisation determines case folding, diacritics and final boundaries; Encephalon adds no fuzzy search, stemming, transliteration, NFKC conversion, ICU dependency or language-specific segmentation.

Search covers kind, subject, source, payload summary, the complete JSON payload and optional `searchText`. Normalising the derived search text does not rewrite canonical JSON. Compact `summary` is a trimmed non-empty string from an object payload's `summary`, or `null`. Snippets use a bounded preview of kind, subject, source and summary, with bracketed matches and ellipses as applicable. A match outside that preview remains searchable and uses a stable preview fallback. The preview can contribute to relevance, so snippet/rank/order may differ from earlier releases. Fetch the full record when the preview does not explain a match.

A query with no extracted terms returns `[]` after repository and root-installation validation, without cache preparation. Gather with only such searches, no shows and no requested hydration likewise avoids cache work. Mixed gathers still execute their other requested work.

Gather preserves the original query/ID strings, request order within each result array and every duplicate occurrence. Shows are evaluated before searches. Each exact distinct show ID and original query is evaluated once in the accepted read snapshot; semantically similar but textually different queries remain distinct. Missing shows and empty searches can be reused too. Duplicate results never share mutable records, payloads, arrays or compact objects. Every occurrence is charged to the complete gather response budget. `hydrate: true` requests a forced rebuild and returns its result in `hydrated`; otherwise that field is `null`, including when automatic preparation rebuilds a cache.

## Canonical records and artifacts

Canonical records are UTF-8 JSON objects under `encephalon/<kind>/<id>.json`. Their path must agree with the stored kind and ID. IDs are unique across the corpus; record and artifact paths must not collide after NFC/case normalisation. These portability checks apply on every supported platform. The only supported stored fields are:

```typescript
type JsonPrimitive = null | boolean | number | string;
type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
type BrainRecordFile = {
  id: string;
  kind: string;
  subject: string;
  source: string;
  createdAt: string;
  confidence?: number;
  supersedes?: string[];
  artifacts?: string[];
  payload: JsonValue;
  searchText?: string;
};
type BrainRecord = BrainRecordFile & { path: string };
```

`path` is a repository-relative runtime field and is never stored in canonical JSON. Unknown stored fields are invalid. Optional fields are omitted rather than written as null. Stored `supersedes` and `artifacts`, when present, are non-empty unique arrays; add inputs may supply empty arrays, which are omitted from the record.

Kinds match `[a-z][a-z0-9_-]{0,63}`. IDs match `[A-Za-z0-9][A-Za-z0-9._-]{0,127}`; omitted add IDs are generated UUIDs. Both must also be portable path segments: no Windows device names, trailing dot/space or invalid length. Subjects and sources are non-empty trimmed strings. `searchText`, when present, is also non-empty and trimmed. These strings are not inferred from repository content.

`createdAt` is a real canonical UTC timestamp in `YYYY-MM-DDTHH:mm:ss.sssZ` form. Callers cannot supply it to `addRecord`. A committed timestamp is the later of the current millisecond and one millisecond after the latest validated canonical timestamp, assigned while holding the repository operation lock. Generated records advance in the same locked order. Timestamp exhaustion fails rather than wrapping or rewriting history. No global timestamp state is consumed by a failed pre-commit attempt.

`confidence` is a finite number from 0 through 1; negative zero becomes positive zero. Payloads accept finite JSON primitives, dense arrays and plain or null-prototype objects. Cycles, sparse arrays, accessors, symbol keys, non-plain objects, non-finite numbers, unsupported values and failed reflection are invalid. Payload traversal never invokes getters; ordinary non-enumerable object data is not serialised. Shared non-cyclic input values are permitted, and negative-zero payload numbers are normalised. New records use two-space formatted JSON and a final newline within the record-byte limit; existing valid JSON bytes need not be rewritten into that spelling.

Knowledge is append-only. A record is active if no record supersedes its ID. Every supersession target must exist, differ from the new record and have the same kind and subject; cycles are invalid. Multiple active heads for one kind/subject are a validation conflict. A resolving add must supersede every active head of that group. Normal mutations never edit or delete existing records or artifacts.

Artifacts are existing immutable regular non-symlink files beneath `encephalon/_artifacts/<kind>/<id>/`. Stored paths begin `_artifacts/<kind>/<id>/`, relative to the brain directory. They use `/`, remain under their owning record and contain no empty, dot, parent, absolute, drive-prefixed or backslash segments. Segments must be NFC, fit portable byte/UTF-16 lengths, and contain no controls, Windows-reserved characters/names or trailing dots/spaces. Ancestors must be real contained directories; missing, linked, mismatched or non-regular referenced files are invalid. Detected replacement during inspection is a repository change, not a stable validation result. Encephalon references artifacts rather than importing arbitrary file contents into search.

The reserved `_artifacts` and `_staging` trees are not record directories. Only referenced artifacts participate in canonical/cache freshness; unrelated archive files do not become knowledge records. Keep canonical files and referenced artifacts in Git and exclude the cache.

## Limits

Limits are independent and inclusive. `KiB`/`MiB` mean powers of 1,024. Counts include superseded records and duplicate emitted occurrences where stated.

| Boundary | Maximum or accepted range |
| --- | --- |
| List, full/compact search, each gather search | 1–1,000 results; default 20 |
| Gather request | 16 searches and 64 shows |
| Search input | 1,024 original UTF-8 bytes; 32 extracted terms |
| Kind / ID | 64 / 128 ASCII characters with the syntax above |
| Subject, source, artifact path | 1,024 UTF-8 bytes each |
| `searchText` | 256 KiB of UTF-8 |
| Portable path component | 255 UTF-8 bytes and 255 UTF-16 code units |
| Payload | 64 nested levels; 10,000 JSON nodes including containers, primitives and root |
| One formatted canonical record | 1 MiB |
| Canonical corpus | 1,000 records; 8 MiB aggregate record JSON |
| Supersession | 1,000 targets per add and 1,000 edges across the corpus |
| Artifacts | 256 references per record and 1,000 across the corpus |
| Canonical root | 1,002 entries and 1,000 kind directories |
| Each kind directory | 1,000 entries |
| Managed instruction file / inspected root package metadata | 1 MiB each |
| Baseline root/workflow directory | 512 raw entries per source before filtering |
| Validation output | At most 100 issues, including a truncation sentinel |
| Full, compact, complete gather response | Independent 4 MiB budgets |

The canonical root-entry count includes `_artifacts` and `_staging`, but neither counts as a kind. Directory overflow reports one deterministic `CORPUS_DIRECTORY_ENTRY_LIMIT` issue for the containing repository-relative directory, without disclosing excess filenames. Validation returns deterministic bounded issues; when its reporting ceiling is reached, it retains at most 99 concrete issues, appends `VALIDATION_ISSUES_TRUNCATED`, and sets `truncated: true`.

Full list, show and full search charge `fullResponseBytes` by the accepted record JSON representation, including the returned runtime path, rather than by transport pretty-printing. Compact search charges `compactResponseBytes`; a complete gather charges `gatherResponseBytes`. Compact/gather logical accounting adds the UTF-8 bytes of every string value and object key, plus eight bytes for each number, boolean, null, array and object, recursively. Whitespace, escaping and property order do not change that charge. Gather includes its envelopes, hydration result, shown records/nulls and compact result arrays, charging duplicates each time.

An exact-budget response succeeds. A response that would exceed its budget fails before retaining the excess fragment; no partial or silently truncated response is returned. Request count/limit overflow is rejected before item validation, repository discovery or cache work. Payload and formatted record bounds are checked before publication work. Independent safety bounds are not relaxed by a smaller result limit.

Operation-budget failures use `INVALID_ARGUMENT` with exactly `{ field, budget, maximum }`, omitting input values, queries and paths. Stable budget names are `fullResultLimit`, `compactResultLimit`, `queryBytes`, `queryTerms`, `gatherSearches`, `gatherShows`, `supersessionEdges`, `fullResponseBytes`, `compactResponseBytes` and `gatherResponseBytes`; response failures use `field: 'response'`. Other schema/corpus bounds use their bounded field or validation diagnostics.

## Initialisation and managed instructions

`init` generates up to three records, with source `encephalon:init`: context `encephalon:init/repository-overview`, architecture `encephalon:init/tooling-layout` and workflow `encephalon:init/commands-ci`. It prepares the cache and updates root `AGENTS.md` and `CLAUDE.md` in that order. `nextAction` directs an agent to the installed skill and optional semantic enrichment.

The baseline reads only bounded root package metadata and root/`.github/workflows` entry names. It extracts package name, recognised package-manager evidence, workspace patterns, script keys/invocations, recognised top-level files/directories and workflow filenames. It never recursively inventories source directories or emits language counts/file totals. Script keys are discovery data; `scriptInvocations` provides argv when a package manager can be established. Conflicting evidence is reported rather than silently choosing a manager.

The overview retains `recognisedTopLevelFiles`, `topLevelDirectories`, `sources`, `summary`, `scanTruncated` and sorted `scanTruncationReasons`. Sources that overflow, are invalid or are stably unreadable contribute no rejected facts. The bounded reason vocabulary is `package-metadata-error`, `top-level-entry-limit`, `unreadable-directory`, `workflow-entry-limit` and `workflow-enumeration-error`. A changing source discards the attempt. Root manifest spelling is `package.json`; case-insensitive filesystem aliases do not change the literal file being opened.

Ordinary init preserves existing generated heads and reports conflicts. `refreshBaseline` appends replacements only for changed generated subjects, superseding their prior active generated heads; unchanged subjects keep their records. Existing records, including older language/file-inventory payloads, remain unchanged and searchable through history. A same-options rerun converges without duplicate generated heads or managed blocks. `remove` removes only managed instruction blocks; it does not delete records, artifacts, cache or the package.

Instruction files must be regular non-symlink files containing valid UTF-8, no NUL and at most 1 MiB. Both files are preflighted before either is changed. Unrelated bytes, BOM and line endings are preserved; malformed, nested, duplicate, unmatched or modified managed blocks fail validation rather than being guessed or overwritten.

Managed format version 1 uses an opening `<!-- encephalon:managed-instructions:start <metadata> -->` marker and closing `<!-- encephalon:managed-instructions:end -->` marker. Metadata is base64url-encoded JSON containing `formatVersion: 1`, `originalFileExisted`, `separatorBase64` and `lineEnding: 'LF' | 'CRLF'`. The generated body has the `## Encephalon` heading, directs agents to read the repository-memory skill, and names `./node_modules/encephalon/skills/encephalon/SKILL.md`. The stored separator/file-existence information makes removal reversible; users should manage blocks through `init`, not edit their metadata or body.

The exact body between markers is below, using the recorded line ending and a final line ending after the closing marker:

```text
## Encephalon
Read and follow the repository-memory skill before making repository assumptions or recording durable knowledge:
./node_modules/encephalon/skills/encephalon/SKILL.md
```

`separatorBase64` encodes the added separator (empty, one or two LF/CRLF line endings) as ordinary base64; the enclosing metadata uses base64url. These encodings and `originalFileExisted: boolean` describe restoration, not arbitrary replacement content.

Initialisation may read complete instruction bytes only to manage that block. Unrelated instruction text is never semantically scanned, stored in generated records, indexed or printed. Source bodies, README content, environment files, registry configuration, Git history/remotes and workflow contents are excluded from baseline generation and its errors. Explicitly supplied record payloads/artifacts remain the caller's responsibility.

## Commit points and recovery

Canonical reads accept one proven-stable generation, including invalid or unreadable entries that contributed validation output and referenced artifact evidence. Changed generations are discarded rather than combined. Stable invalid repositories retain normal validation results. Canonical and baseline observation retries allow at most three complete attempts under a non-resetting 60-second deadline checked before retries; continuous churn reports path-free `REPOSITORY_CHANGED`. These bounds do not promise a whole-operation wall-clock deadline for arbitrary filesystem calls.

Repository mutations are serialised by an operation lock with a 60-second acquisition deadline. A failed acquisition must not enter the protected mutation. Uncertain ownership and active recovery are never overridden merely to make progress. Cleanup only removes entries whose ownership and exact filesystem identity are established; suspicious or replaced entries are preserved.

### Record publication

The canonical hard link is the record commit point. Before it, a changed canonical generation discards the whole add plan and may retry within the existing bound. After it, Encephalon never rolls back or blindly retries the append-only addition. Success requires the accepted prior generation plus the exact committed record and completed owned cleanup; external changes or later failures report committed state instead of pretending nothing happened.

Committed add errors include bounded `canonicalCommitted`, `recordId`, repository-relative `path`, `postCommitPhase` and `recoveryAction` when applicable. Canonical changes add `repositoryChanged: true` and ordered `committedRecordIds`. An operation-cleanup failure after successful publication preserves the original subsystem error while reporting the committed record. Inspect that ID and run `validate` before deciding what to do; never retry it as a fresh uncommitted add.

Supported add `postCommitPhase` values are `publicationVerification`, `publicationFlush`, `stagingCleanup`, `cacheHydration` and `operationCleanup`. Verification requires inspecting the canonical generation; flush failure leaves directory durability unverified because `prepare` does not re-flush the kind directory. Staging cleanup permits removal only of a confirmed operation-owned leftover. Cache failure calls for `prepare` then `validate`; operation cleanup requires inspecting the committed ID before retrying. Follow the supplied `recoveryAction` for the specific failure.

Initialisation validates its generated batch before publishing. Before the first record commit it can replan; after the first it preserves the committed prefix and stops on a conflicting canonical change before further cache/instruction work. A later same-options call treats the prefix as history and creates only missing generated records.

Staging cleanup is bounded and non-recursive. It inspects at most 1,001 direct entries to enforce the 1,000-entry bound, follows no symlinks and removes only recognised operation-owned stale files/aliases. Overflow, unrecognised types/names, late arrivals or identity changes preserve affected entries and report repository-relative inspect-and-retry guidance without exposing arbitrary names. Partial cleanup can remain visible after failure.

### Managed instruction publication

Each instruction replacement commits when the new staged bytes are hard-linked at the canonical filename. Before commit, an exact predecessor is restored or retained as a reported recovery alias. After commit, predecessor bytes are never restored over the canonical path; detected concurrent successors are preserved. Removal and replacement preserve unrelated bytes and original permissions where supported.

On POSIX, staged and retained recovery bytes are written and checked privately at mode 0600 before applying and verifying the intended final mode. Windows retains exclusive creation and exact byte/identity checks with restrictive mode bits where supported; POSIX modes are not an ACL guarantee. Durable predecessor/recovery links are flushed before removing their last source. Success leaves no temporary, backup or deletion alias created by that operation; historical lookalike files are neither discovered nor removed.

Post-commit instruction errors report `instructionCommitted`, the safe `filename`, primary `postCommitPhase`/`recoveryAction`, all distinct failed or deferred actions in bounded `postCommitFailures`, and ordinal-sorted repository-relative `recoveryPaths` still proven to belong to the operation. These diagnostic phases describe publication verification/flush and backup, temporary or resource cleanup; they are not hooks callers can invoke. A later successful cumulative flush can clear an earlier transient flush failure. Any captured identity uncertainty makes the aggregate code `REPOSITORY_CHANGED`, while deterministic priority chooses the primary message. Repeating unchanged init options revalidates and syncs the canonical files but does not discover or remove retained aliases.

Instruction `postCommitPhase` values, in primary-error priority order, are `publicationVerification`, `publicationFlush`, `backupCleanup`, `temporaryCleanup` and `resourceCleanup`. Each `postCommitFailures` entry contains `{ postCommitPhase, recoveryAction }` in that order. Verification requires inspecting the canonical file; flush recovery repeats the same init options. Cleanup of backup/temporary files requires confirmed operation ownership. Resource cleanup requires no alias deletion; API consumers should end the process before retrying to release any retained descriptor.

### Partial initialisation

Init is monotonic across records, disposable cache and instruction files, **not a global transaction**. A failure preserves already committed work and stops later authoritative mutations apart from safe owned cleanup. It preserves the subsystem's error code, message, cause and safe details, adding:

```typescript
type InitProgress = {
  phase: 'preflight' | 'recordPublication' | 'cachePreparation'
    | 'instructionApplication' | 'operationCleanup';
  canonicalCommitted: boolean;
  committedRecordIds: string[];
  committedInstructionFiles: Array<{
    file: 'AGENTS.md' | 'CLAUDE.md';
    action: 'updated' | 'removed';
  }>;
  cacheState: 'notAttempted' | 'disposable' | 'prepared';
  recoveryMode: 'rerun' | 'inspectAndRerun';
  recoveryAction: string;
};
```

This object appears at `details.initProgress`; `InitProgress` is explanatory notation, not an additional exported type. Commit lists contain each event once, in publication order and fixed instruction-file order. `canonicalCommitted` is true exactly when the record list is non-empty. They report events reached by this call, not ownership of a pathname after an external replacement. Preflight failures have empty lists and `cacheState: 'notAttempted'`; remove mode does not attempt cache work. Record publication or started cache work makes cache state disposable; only successful preparation makes it prepared.

For `rerun`, resolve the reported cause and repeat the same init options. For `inspectAndRerun`, first inspect the reported records, instruction files and recovery paths or operation-cleanup state. After a cache-preparation failure, run `prepare`, run `validate`, then repeat the same init options, inspecting canonical state first when directed. The progress object excludes subjects, payloads, instruction bytes, private paths, raw causes, ownership tokens, stacks and arbitrary filesystem names.

### Disposable cache

SQLite under `node_modules/.cache/encephalon/` is derived search/order infrastructure, never canonical truth. Full records come from accepted canonical JSON. Cache reads validate bounded schema/data/projection and FTS integrity against that accepted corpus, then return a result from one consistent database/canonical generation. Copied metadata cannot legitimise altered, missing, duplicate or orphaned rows or forged search state. No partially validated or mixed-generation result may escape.

Every list/show and non-empty search/gather prepares automatically. Missing, obsolete, malformed or recoverably corrupt cache state is rebuilt transactionally from canonical data. Existing incompatible caches are replaced through identity-bound recovery, not migrated into canonical authority. The first recoverable failure permits one recovery rebuild; a read retries against that exact rebuilt generation. A second failure is terminal. Canonical changes retain their bounded repository-change policy; a successor database is preserved rather than treated as the failed predecessor.

Recoverable SQLite categories are corruption, not-a-database, incompatible schema, read-only and cannot-open failures. Busy/locked contention, general operational I/O and unknown failures are terminal for that operation. Operation-lock recovery has its narrower corruption/not-a-database policy. A valid foreign cache always returns `CACHE_SCOPE_MISMATCH` and is never quarantined or rebuilt, even by forced hydration.

Cache ancestors, databases, sidecars and lock/recovery entries require real contained filesystem identities. Mutable SQLite files must have exactly one hard link. Symlink/junction redirects, unexpected types and detected replacements fail closed. Destructive recovery applies only to the exact failed identities, never same-path successors. If safe SQLite close cannot be proven, the connection is retained and further opens are rejected through bounded process-lifetime protection; correct the unsafe layout and restart the process before retrying. Cache work never authorises deleting canonical data.

## Errors

`EncephalonError` extends `Error` with `code: EncephalonErrorCode` and `details: Record<string, JsonValue>`. Its constructor accepts `(code, message, details?, options?)`, including the standard error cause option. Consumers should branch on stable codes and documented detail fields rather than parse private diagnostic prose.

| Code | Meaning / response |
| --- | --- |
| `UNSUPPORTED_RUNTIME` | Use a supported Node runtime. |
| `REPOSITORY_NOT_FOUND` | Discovery found no valid Git repository. |
| `INVALID_REPOSITORY` | The selected repository/marker/layout is invalid or changed during resolution. |
| `ROOT_INSTALL_REQUIRED` | Install and execute the package from the Git root. |
| `INVALID_ARGUMENT` | Correct the input, field or operation-budget failure. |
| `VALIDATION_FAILED` | Inspect canonical, artifact or instruction validation details. |
| `RECORD_EXISTS` | The requested ID is already present; inspect it before retrying. |
| `CACHE_BUSY` | The operation lock could not be acquired within its bound. |
| `CACHE_SCOPE_MISMATCH` | A valid cache belongs to another repository; do not treat it as current data. |
| `REPOSITORY_CHANGED` | Accepted filesystem/canonical evidence changed; inspect any reported committed work before retrying. |
| `IO_ERROR` | A recognised filesystem/SQLite environment failure prevented the operation. |
| `INTERNAL_ERROR` | An unexpected internal failure; preserve evidence and report it. |

Public messages and structured details are bounded. Budget errors omit rejected input content. Validation identifies only safe repository-relative paths and valid record IDs where appropriate; cache errors do not expose raw SQLite rows, schema text or parser excerpts through their public cause chain. Internal diagnostic causes for other subsystems can carry implementation information and must not be logged or serialised as a public response. CLI serialisation independently strips unsafe details and never prints a raw cause or stack.

## Compatibility and threat boundary

Valid published 0.3 canonical records, artifacts and managed blocks remain readable. Existing historical JSON is not rewritten by upgrade, cache rebuilding or non-refresh init. Explicit refresh can append superseding generated records. The lean baseline omits nested source/language/file inventories; compact previews and relevance may change while complete payload/search-text matching remains supported. Public result limits, synchronous API, CLI protocol and canonical append-only guarantees remain intact.

Disposable cache schema, SQL spelling, helper names, test hooks, recovery implementation and exact benchmark phase instrumentation are not public formats. An older runtime may rebuild its own disposable cache when reopening the same canonical repository; compatibility verification characterises upgrade and downgrade without changing canonical bytes. Numerical performance results depend on the machine and fixture; regression policy is in the performance guide, not a user latency promise.

Filesystem protections cover static unsafe layouts and replacements detected at validation boundaries: containment, real directory ancestry, no-follow regular-file reads, hard-link restrictions for mutable cache files, exclusive publication and ownership-bound cleanup remain mandatory. Canonical publication itself deliberately uses guarded hard links. Directory durability is best effort where directory fsync is unsupported; regular-file flush and identity checks remain required.

Node's pathname-based SQLite and filesystem interfaces do not provide portable conditional descriptor-relative mutation. A malicious process running as the same user can race inside the final pathname syscall window despite adjacent checks. That window, forced random-name collisions, hostile filesystem/kernel behaviour, administrator access and Windows ACL equivalence to POSIX modes are outside the supported security boundary. Detected replacement must still preserve successors and fail closed. Encephalon is not an encryption system, sandbox or access-control boundary, and does not promise cross-process cleanup fairness.

Maintained public guarantees and their behavioural tests change together. Design rationale and retired details belong in immutable history. The pre-rewrite documents and baseline are owned by context record `3ae9fa5c-490d-4a55-b988-22609b49ba00`; original links resolve against its recorded source commit. Use `show --id` or search for documentation history to find them. Release checks must use the actual pinned published oracle and exact reviewed/trusted candidate; npm publication remains a manual maintainer action as described in the contributor guide.
