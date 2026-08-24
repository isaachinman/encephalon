# Encephalon v0.1.0 — Complete Implementation Plan

Status: historical design input; not the maintained normative contract
Target repository: `git@github.com:isaachinman/encephalon.git`  
Local implementation repository: the dedicated checkout of `isaachinman/encephalon`  
Initial npm package: `encephalon@0.1.0`  
License: MIT  
Runtime: Node.js 24.15.0 or newer  
Maintainer toolchain: TypeScript and Bun  
Audited implementation snapshot: `9681b6c03f1cbf73263570f923493d45da1aa291` on 2026-08-13
Current maintained contract: [`docs/contract.md`](./contract.md), the README, package checks, and executable tests

## 1. Purpose of this document

This document is preserved as historical implementation input for Encephalon v0.1.0. It is not the maintained normative contract for the current codebase. When this document conflicts with [`docs/contract.md`](./contract.md), the README, package checks, or executable tests, the maintained contract wins.

The implementation must satisfy two simultaneous goals:

1. Recover the useful, generic behaviour of the private source brain's original TypeScript/Bun implementation and its later Rust implementation.
2. Produce a completely independent, public, general-purpose npm package whose public history and distributed tarball contain no private-company data, private Git objects, private URLs, internal workflows, or company-specific behaviour.

This is not a request to convert the current private repository in place. Encephalon is a new public project with a new Git object graph. Private history is evidence for behaviour only. It is never a valid branch base, public remote, cherry-pick source, merge source, or object source.

The final user experience is deliberately small:

```bash
npm install --save-dev encephalon
npx --no-install encephalon init
npx --no-install encephalon search "authentication decision" --compact
```

After installation and explicit initialisation, the consuming repository contains one canonical brain-data directory:

```text
encephalon/
  <kind>/<record-id>.json
  _artifacts/<kind>/<record-id>/...
```

All executable code, the SQLite implementation, the CLI, TypeScript declarations, and the agent skill remain inside `node_modules/encephalon`. The disposable SQLite cache lives under `node_modules/.cache/encephalon`. The package must not use installation lifecycle scripts to mutate the host repository.

## 2. Non-negotiable outcomes

The implementation is complete only when all of the following are true:

- The public repository has a clean history created specifically for Encephalon.
- No private commit, tag, tree, blob, ref, packfile, or remote from the source brain is present in the public repository.
- The published npm package is named `encephalon`, exposes an `encephalon` binary, and is versioned `0.1.0`.
- Runtime consumers need Node.js 24.15.0 or newer but do not need Bun.
- `package.json` has no runtime dependencies.
- There is no `install`, `preinstall`, `postinstall`, or `prepare` script.
- Installation itself is side-effect-free. Repository mutation begins only when the user explicitly runs `encephalon init`.
- The canonical record format preserves the generic record envelope described in this document.
- Canonical knowledge is append-only JSON. SQLite is always disposable and never authoritative.
- Every read command automatically prepares a fresh cache.
- Cache rebuilding is transactional and safe for Windows readers; normal hydration never swaps the database file.
- `init` creates a deterministic, bounded, non-semantic structural baseline without storing source bodies, scripts, secrets, or arbitrary documentation text.
- `init` installs exactly reversible managed discovery blocks in root `AGENTS.md` and `CLAUDE.md`.
- The packaged Encephalon skill tells agents how to query knowledge and how to capture only durable, high-signal knowledge.
- The distributed package contains no real records and no source-company-specific functionality.
- Tests, package inspection, and clean-room provenance checks pass before any public release.

## 3. Explicitly excluded work

The following features are outside v0.1.0 and must not be introduced indirectly through abstractions or placeholder architecture:

- Hosted services or managed Encephalon accounts.
- MCP servers or clients.
- OAuth, hosted authentication, API tokens, or network APIs.
- Daemons, background processes, filesystem watchers, or scheduled hydration.
- Embeddings, vector databases, semantic search services, or remote models.
- Plugin systems, storage providers, database providers, or generic dependency injection.
- Automatic staging, commits, pushes, pull requests, merges, or branch manipulation in consuming repositories.
- Post-install hooks or package-manager-specific mutation scripts.
- Native Bun executables or platform-specific binary distribution.
- Importers for Slack, Notion, Linear, Google Docs, or any private-company workflow.
- Company seeders, weekly-reporting code, training-record workflows, customer context, managed-agent routines, or private records.
- Incremental SQLite hydration. A validated transactional full rebuild is the v0.1 strategy.
- Yarn Plug'n'Play support. Encephalon requires a root `node_modules/encephalon` installation.

Do not create interfaces for excluded features. New layers are permitted only when required by a current v0.1 contract and exercised by production code and tests.

## 4. Source recovery and publication provenance

### 4.1 Private history is behavioural evidence

The private source-brain repository contains two useful reference points:

- The parent of the Rust conversion merge contains the last TypeScript/Bun implementation.
- The current Rust implementation contains later generic behaviour, particularly `gather`, `show --active-only`, compact search output, superseded filtering, preparation, and stronger validation.

Use read-only commands in the private repository to inspect those versions. Do not clone, fetch, or add the private repository as a remote of Encephalon. Do not use `git format-patch`, `git cherry-pick`, `git merge`, grafts, bundles, replace refs, or object copying to move private history into the public repository.

If source is reused, copy reviewed generic file content through the working tree only. Prefer a fresh implementation informed by the recovered contract when ownership or cleanliness is uncertain.

### 4.2 Publication-rights gate

Before the first public push, the maintainer must confirm that the generic implementation being published may legally be open-sourced under MIT. If that confirmation is unavailable for any copied implementation, reimplement the behaviour from this specification rather than publishing that source.

This gate applies to:

- TypeScript source.
- Test fixtures and snapshots.
- Documentation.
- The bundled skill.
- Generated bundles and declaration files.
- Any SQL schema or query copied from the private project.

### 4.3 Clean-history verification

The public-repository audit must inspect more than the working tree. Before the first push and again before publishing, inspect every reachable public Git object and the npm tarball for:

- Private company names, private repository names, and internal package scopes.
- Company-specific record kinds, subjects, sources, domains, product names, customer names, and organisation identifiers.
- Credentials, tokens, registry configuration, `.env` content, private URLs, and internal hosts.
- Absolute local paths, including home-directory paths and private workspace layouts.
- Real records copied into tests or examples.
- Rust binaries, private artifacts, SQLite databases, or historical generated files.

Synthetic fixtures may demonstrate the record format, but they must use invented generic subjects and payloads.

## 5. Git repository bootstrap

The GitHub repository is empty. The bootstrap sequence must avoid placing implementation work directly on `main`:

1. Work in the dedicated local checkout of the public Encephalon repository.
2. Rename or switch the unborn branch to `bootstrap`.
3. Make the implementation plan the first project artifact.
4. Add only minimal bootstrap material required to create the initial public base, such as the plan, MIT licence, and a minimal README if needed.
5. Commit the bootstrap content on `bootstrap`.
6. Push `bootstrap` explicitly as `origin bootstrap:bootstrap`.
7. Verify that GitHub treats `bootstrap` as the temporary default branch.
8. Create `initial-release` from the bootstrap commit without inheriting an incorrect upstream.
9. Implement v0.1.0 on `initial-release`.
10. Push with the explicit refspec `origin initial-release:initial-release` and verify its upstream.
11. Open a pull request targeting `bootstrap`.
12. Merge only after local and CI verification succeeds.
13. Rename the merged default branch from `bootstrap` to `main` using GitHub's branch rename capability.
14. Verify local tracking points to `origin/main` and that no protected/default branch was pushed to directly.
15. Publish only from the verified merged `main` commit.

British English should be used for Git commit messages and GitHub pull-request content. Existing American code/API terminology such as `artifact` must remain internally consistent.

## 6. Package layout

The intended source repository layout is:

```text
encephalon/
  .github/
    workflows/
      ci.yml
  docs/
    implementation-plan.md
  skills/
    encephalon/
      SKILL.md
  src/
    baseline.ts
    cache.ts
    cli.ts
    errors.ts
    index.ts
    init.ts
    lock.ts
    records.ts
    repository.ts
    schema.ts
    search.ts
    types.ts
  test/
    fixtures/
    baseline.test.ts
    cache.test.ts
    cli.test.ts
    init.test.ts
    records.test.ts
  LICENSE
  README.md
  bun.lock
  package.json
  tsconfig.json
```

This inventory describes responsibility boundaries, not a mandate to create unnecessary modules. Merge modules when that produces a clearer, smaller implementation. Do not create generic repository, provider, adapter, service-container, or dependency-injection class hierarchies.

The npm tarball whitelist is limited to:

```text
dist/
skills/
README.md
LICENSE
package.json
```

Tests, source, private planning notes, caches, and fixtures are not required in the tarball unless npm's normal package metadata includes them.

## 7. Package metadata and build contract

### 7.1 Required `package.json` fields

The package manifest must contain, at minimum:

```json
{
  "name": "encephalon",
  "version": "0.1.0",
  "description": "Repository-local, durable knowledge for coding agents",
  "license": "MIT",
  "type": "module",
  "engines": {
    "node": ">=24.15.0"
  },
  "bin": {
    "encephalon": "dist/cli.mjs"
  },
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.mjs"
    }
  },
  "files": [
    "dist",
    "skills",
    "README.md",
    "LICENSE"
  ]
}
```

The binary target deliberately omits a leading `./`. npm resolves the path from the package root either way, but its publish-time manifest normaliser rewrites the prefixed form and emits a warning; the canonical manifest therefore uses the already-normalised spelling.

The final manifest must also include the exact public repository URL, issue tracker, useful keywords, and a `packageManager` entry for the maintainer Bun version.

The runtime `dependencies` field must be absent or empty. Development dependencies should be limited to tooling genuinely needed to typecheck or emit declarations, such as TypeScript and Node type definitions. Do not add dependencies for parsing arguments, validation, UUIDs, globbing, SQLite, file walking, locking, or formatting JSON.

### 7.2 Lifecycle scripts

The package must not define:

- `install`
- `preinstall`
- `postinstall`
- `prepare`

A maintainer-only `prepack` command may build and validate the tarball, because it runs during packaging rather than normal registry installation. The packed artifact must still install correctly with package-manager scripts disabled.

### 7.3 Build output

Bun builds Node-targeted ESM artifacts:

- `dist/cli.mjs` with a valid `#!/usr/bin/env node` shebang and executable mode.
- `dist/index.mjs` as the public ESM API.
- `dist/index.d.ts` and any referenced declaration files.

The bundle must contain no unresolved import of Bun APIs or development-only packages. Consumer smoke tests must execute only with Node. Bun is permitted in maintainer scripts and tests but not required after package installation.

### 7.4 Import purity

Importing `encephalon` must only define functions, types, constants, and error classes. It must not:

- Discover a repository root.
- Read or write files.
- Create directories.
- Open SQLite.
- Probe FTS5.
- Inspect package locality.
- Print output.
- Register process handlers.

All environment and runtime probes occur lazily when a relevant API function or CLI command executes. `encephalon --help` and `encephalon --version` must work without a Git repository, root installation check, or SQLite access.

## 8. Supported host repositories and root discovery

### 8.1 One brain per Git repository

Encephalon is repository-local, not package-local. A monorepo has one Encephalon brain at its Git root. Workspace packages do not get independent brains in v0.1.0.

The package must be declared or installed at the Git root so that this path exists:

```text
<git-root>/node_modules/encephalon
```

Installing Encephalon only inside a workspace package is unsupported and returns `ROOT_INSTALL_REQUIRED`.

### 8.2 Implicit root discovery

When no explicit root is provided:

1. Start from the supplied starting directory or `process.cwd()`.
2. Canonicalise it with the platform-native realpath function.
3. At each ancestor, inspect `.git` with `lstat` without following an arbitrary symlink.
4. Accept a real `.git` directory.
5. Accept a regular `.git` file only if it begins with a valid `gitdir:` declaration and the resolved target is an existing directory.
6. Reject an arbitrary file named `.git` that does not contain a valid target.
7. Stop at the first valid repository marker.
8. Return `REPOSITORY_NOT_FOUND` if the filesystem root is reached.

This supports ordinary repositories, monorepos, Git worktrees, and submodules without invoking a Git subprocess during normal CLI/API operation.

### 8.3 Explicit root

When the API or CLI receives `root`/`--root`:

1. Resolve a relative value against the current working directory.
2. Canonicalise the result.
3. Validate that exact path as a Git repository root using the same `.git` rules.
4. Do not search any parent directory.
5. Return `INVALID_REPOSITORY` if the exact path is not a valid root.

### 8.4 Root installation proof

It is insufficient to test only whether `<root>/node_modules/encephalon` exists. To reject ephemeral `npx`, workspace-local resolution, or a different package copy:

1. Resolve the real package directory from `import.meta.url` in the executing distribution.
2. Resolve the realpath of `<root>/node_modules/encephalon`.
3. Require both realpaths to be equal after native path normalisation and Windows case folding.
4. Read the installed package's manifest and verify `name === "encephalon"` and that its version equals the version embedded in the running bundle.
5. Return `ROOT_INSTALL_REQUIRED` with a safe remediation message if any check fails.

The normal setup command is:

```bash
npm install --save-dev encephalon
npx --no-install encephalon init
```

Historical note: the maintained current contract uses the package-manager binary form after installation:

```bash
npx --no-install encephalon <command>
```

The direct Node entrypoint remains an implementation detail that package smoke tests exercise against the packed tarball. User and packaged-skill guidance uses `npx --no-install`, and runtime root-install verification rejects execution that is not the root `node_modules/encephalon` installation.

### 8.5 Package-manager support

Support layouts where root `node_modules/encephalon` resolves to the executing package, including npm, pnpm, Bun, and classic Yarn. Yarn Plug'n'Play is explicitly unsupported because it does not provide the required stable root path or cache location.

## 9. Canonical data layout

### 9.1 Authoritative state

Only these host-repository paths are canonical Encephalon knowledge:

```text
encephalon/<kind>/<id>.json
encephalon/_artifacts/<kind>/<id>/...
```

The SQLite cache is disposable. Reads must never rewrite, reformat, reorder, normalise, or repair canonical JSON. Repairs and changed knowledge are represented by new append-only records.

### 9.2 Record scanning

The record scanner is intentionally shallow:

- Enumerate direct children of `encephalon/`.
- Treat `_artifacts` as a reserved non-record namespace.
- Reject other leading-underscore directories.
- Treat every valid non-reserved child as a kind directory.
- Require kind directories to be real directories, not symlinks.
- Read only direct `*.json` files from each kind directory.
- Reject nested record directories or JSON files at other depths.
- Require each record file to be a regular non-symlink file.
- Require the filename stem to equal the record's `id` exactly.
- Require the parent directory name to equal the record's `kind` exactly.
- Sort paths by repository-relative POSIX path before parsing.

The scanner must not recurse through `_artifacts` while collecting records.

### 9.3 Public record types

```ts
export type JsonPrimitive = null | boolean | number | string

export type JsonValue =
  | JsonPrimitive
  | JsonValue[]
  | { [key: string]: JsonValue }

export type BrainRecordFile = {
  id: string
  kind: string
  subject: string
  source: string
  createdAt: string
  confidence?: number
  supersedes?: string[]
  artifacts?: string[]
  payload: JsonValue
  searchText?: string
}

export type BrainRecord = BrainRecordFile & {
  path: string
}
```

`path` is always repository-relative and uses `/`, for example `encephalon/decision/550e8400-e29b-41d4-a716-446655440000.json`. It must never be written into canonical JSON.

### 9.4 Field rules

`id`:

- Generated with `crypto.randomUUID()` by default.
- May be supplied by the caller to support artifact-first workflows.
- Must be a portable segment of 1–128 characters.
- Must begin with an ASCII letter or digit.
- Remaining characters may be ASCII letters, digits, `.`, `_`, or `-`.
- Must not end in a dot or space.
- Must not be a Windows reserved basename, case-insensitively.

`kind`:

- Must match `[a-z][a-z0-9_-]{0,63}`.
- Is open-ended; recommended values are `decision`, `architecture`, `convention`, `workflow`, `incident`, and `context`.
- Values beginning with `_` are reserved.

`subject` and `source`:

- Must be strings.
- Are trimmed before a new record is emitted.
- Must remain non-empty.
- Must not exceed 1,024 UTF-8 bytes.
- Are not path segments and may contain punctuation useful for stable subjects.

`createdAt`:

- Must use canonical UTC RFC3339 with millisecond precision: `YYYY-MM-DDTHH:mm:ss.sssZ`.
- New records use `new Date().toISOString()`.
- Records are ordered by parsed timestamp and then ID, not by filesystem order.
- No cross-process or cross-machine monotonicity claim is made.

`confidence`:

- Is omitted when absent.
- Must be a finite number between 0 and 1 inclusive.
- Must not be `null`, `NaN`, or infinite.

`supersedes`:

- Is omitted when empty.
- Is an array of unique record IDs.
- Each target must exist.
- The current record may not supersede itself.
- Every target must have the same `kind` and exactly the same trimmed `subject`.
- The graph must contain no cycle.
- The whole corpus may contain at most 1,000 supersession edges.

`artifacts`:

- Is omitted when empty.
- Is an array of unique strings.
- May contain at most 256 entries.
- Each path may contain at most 1,024 UTF-8 bytes.
- Each path must satisfy the artifact rules below.
- The whole corpus may contain at most 1,000 artifact references.

`payload`:

- Is required and may be any valid `JsonValue`.
- Runtime validation rejects `undefined`, `bigint`, functions, symbols, non-finite numbers, cyclic values, sparse arrays, non-plain objects, accessors, Maps, Sets, Dates, and typed arrays.
- Objects must have `Object.prototype` or a null prototype and enumerable string keys whose values are valid JSON.
- Payload validation accepts at most 64 nested levels and 10,000 JSON nodes, counting the root value, arrays, objects, and primitive values.
- The final formatted record file must not exceed 1 MiB.

`searchText`:

- Is omitted when absent or empty after trimming.
- Must not exceed 256 KiB as UTF-8.
- Supplements, rather than replaces, indexed kind/subject/source/payload text.

Unknown top-level fields and a canonical `path` field are validation errors. Optional fields are omitted rather than serialized as `null`.

The v0.x canonical corpus may contain at most 1,000 records and 8 MiB of aggregate record JSON. Validation stops scanning when these hard corpus budgets are exceeded.

### 9.5 Append-only and supersession semantics

Canonical JSON is append-only after a record is shared. New knowledge creates a new record. Changed or corrected knowledge creates a new record with the same kind and subject and with `supersedes` pointing at all active heads for that subject.

A record is active when no other record has an incoming supersession edge to its ID. Validation requires at most one active head for every `(kind, subject)` pair.

Arrays are essential for Git mergeability. If two branches independently create replacements for the same prior record, the merged repository temporarily contains two active heads. A later resolver record supersedes both IDs without editing either branch's record.

The package must not automatically choose a winner or edit existing records. Validation reports the conflict until a resolver record is added.

## 10. Artifact contract and path security

Artifacts are optional supporting files that remain Git-mergeable alongside their record. A record with ID `<id>` and kind `<kind>` may reference only paths under:

```text
encephalon/_artifacts/<kind>/<id>/
```

Stored values are relative to `encephalon/`, for example:

```json
{
  "artifacts": [
    "_artifacts/decision/550e8400-e29b-41d4-a716-446655440000/diagram.svg"
  ]
}
```

For every path and path segment:

- Require `/` as the stored separator; reject backslashes.
- Reject absolute POSIX paths.
- Reject Windows drive prefixes and UNC paths.
- Reject empty, `.`, and `..` segments.
- Reject NUL and ASCII control characters.
- Reject trailing dots and spaces.
- Reject Windows reserved basenames such as `CON`, `PRN`, `AUX`, `NUL`, `COM1`–`COM9`, and `LPT1`–`LPT9`, case-insensitively and regardless of extension.
- Resolve the final path and confirm it remains beneath the exact record artifact directory.
- Use `lstat` for every component and reject symlinks.
- Require the final target to be a regular file.
- Detect case-insensitive collisions across record and artifact paths so a repository created on Linux remains check-outable on Windows.

Artifact-first creation works as follows:

1. The caller generates or chooses a valid ID.
2. The caller creates files under `_artifacts/<kind>/<id>/...`.
3. The caller invokes `addRecord({ id, kind, ..., artifacts })` or `encephalon add --id ... --artifact ...`.
4. Encephalon validates the entire record and all artifacts.
5. Encephalon creates the JSON record exclusively and never overwrites an existing path.

No separate reservation command or artifact copying subsystem is required.

## 11. SQLite cache architecture

### 11.1 Location and ownership

The cache path is fixed:

```text
<root>/node_modules/.cache/encephalon/brain.sqlite
```

The cache directory also contains the repository operation lock. The database stores metadata for:

- Cache schema version.
- Diagnostic Encephalon package version.
- Normalised repository realpath.
- Complete source manifest fingerprint.
- Indexed record count.
- Referenced artifact path and metadata set.

Schema version, not package version, decides cache compatibility. Package version remains diagnostic metadata.

Repository identity uses the native realpath, normalised separators, and Windows case folding. If an existing database belongs to another repository identity, return `CACHE_SCOPE_MISMATCH`. Do not silently rebind or rebuild it. This deliberately rejects multiple worktrees that share one physical `node_modules` cache.

Maintained implementations validate the exact owned table, constraint, index, and FTS5 semantics through bounded numeric-first PRAGMA probes and narrowly normalised owned-SQL checks. Existing databases validate before writer PRAGMAs or DDL; only an exclusively created primary receives schema creation. See the maintained contract for the current normative details.

### 11.2 Database schema

Use a small relational table plus FTS5. The exact SQL may evolve during TDD, but it must provide:

- A metadata table keyed by stable names.
- A records table containing the envelope, precomputed compact summary, repository-relative path, and timestamp/order columns.
- JSON-serialized columns for `supersedes`, `artifacts`, and `payload`.
- An FTS5 table indexing kind, subject, source, payload JSON, and search text.
- A manifest table or equivalent metadata representation for referenced artifacts.

Compute `summary` in TypeScript during hydration when `payload` is a plain object whose `summary` property is a string. Do not depend on SQLite JSON1 solely to implement compact output.

Configure `PRAGMA journal_mode = WAL`. A stable database file plus transactions allows concurrent readers on Windows. Normal hydration must not build a second database and rename it over an open destination.

### 11.3 Runtime capability probe

Probe SQLite only on the first cache operation in a process. Verify:

- `node:sqlite` can open the cache.
- FTS5 virtual tables can be created.
- `bm25` works for ranking.
- `snippet` works for compact excerpts.

Return `UNSUPPORTED_RUNTIME` if a required capability is missing. Do not probe JSON1 unless production SQL actually uses it.

### 11.4 Source manifest

The record manifest is a SHA-256 digest over sorted entries containing:

- Repository-relative POSIX record path.
- File size.
- Nanosecond modification time where available.
- Nanosecond change time where available.
- File type/symlink status.

The artifact manifest contains the same metadata for every artifact referenced by the currently indexed record set.

Freshness checking proceeds in two stages:

1. Scan and fingerprint the one-level record set.
2. If the record fingerprint matches, re-inspect the previously indexed artifact set through stable, descriptor-backed, no-follow validation and compare its metadata.

Any missing artifact, type change, symlink introduction, size change, modification-time change, or change-time change makes the cache stale. Hydration recomputes the artifact set from parsed records, validates each referenced artifact once, and constructs the new manifest directly from those verified observations.

### 11.5 One repository operation lock

The following operations share one lock:

- `addRecord`.
- Initial generated baseline creation.
- Baseline refresh.
- `prepare` when it needs to rebuild.
- Explicit `hydrate`.

The authoritative lock is a verified SQLite `BEGIN IMMEDIATE` transaction on `operation-lock.sqlite`, acquired within one 60-second deadline. Acquisition is serialised through the fixed `operation-lock.recovery` marker. New recovery owners contain canonical `{ acquiredAt, phase: 'recovering', pid, token }` metadata; after the exact gate transaction begins, a matching durable `owner.recovered.json` witness records `phase: 'recovered'`. Exact recovered evidence is reclaimable across processes, while live recovering and phase-less legacy owners remain fail-closed. Corrupt or not-a-database gate recovery requires confirmation against the exact captured gate identity before quarantine and exclusive replacement.

Each operation separately creates an exclusive random `operation.lock.<uuid>` candidate and publishes an exact canonical `{ acquiredAt, pid, token }` owner whose token is the UUID. Before the gate, it validates only that current candidate. After the gate succeeds, it removes stale fixed metadata, promotes the exact captured candidate to `operation.lock`, performs bounded maintenance while the gate remains held, and only then runs the protected operation. Promotion and release require unchanged directory identity, owner identity/metadata/raw bytes, missing recovery witness, and an exact `owner.json`-only child set. Failed-acquisition cleanup acts only on the captured candidate and never reopens its pathname or adopts a successor.

Candidate maintenance is private and best effort for unrelated entries. Per operation it visits at most 64 raw cache-directory entries, inspects at most 16 canonical lowercase UUID-v4 candidates, and attempts at most 4 quarantines. It retains at most 8 path-plus-BigInt-identity cursors so operations in one live process can resume a directory pass; restart may return to the beginning and there is no persistent or cross-process cursor. A candidate may be reclaimed only with unchanged exact directory, child, owner, and missing-witness evidence: either a canonical matching owner whose PID positively returns `ESRCH`, or missing/malformed supported owner evidence aged strictly more than 5,000 ms. Oversized, live, permission-denied, ambiguous, linked, unreadable, recovery-witness, extra-child, and changed evidence is preserved. Candidate-local failures are suppressed only after authoritative cache-location and current-lock checks remain exact; fixed lock/recovery, current-candidate, cache-location, and gate failures remain fail-closed.

Tests cover contention and deadline behaviour; corrupt-gate recovery; durable recovered-marker cleanup; current-candidate identity, owner, and child replacement; lazy work bounds; in-process cursor progress and restart limitations; crash-like ownerless and dead-owner candidates; grace handling; unrelated linked or malformed entries; uncertain liveness; and unchanged protected-operation results and errors.

### 11.6 `prepare()`

`prepare()` is the sole freshness decision boundary:

1. Resolve and validate the repository and package installation.
2. Lazily probe SQLite capability.
3. Compute the optimistic source manifest.
4. Open existing cache metadata if possible.
5. Return without a lock when the schema, repository identity, record manifest, and artifact manifest are all current.
6. If stale or absent, acquire the operation lock.
7. Recompute freshness after acquiring the lock because another process may have rebuilt it.
8. Run the hydration algorithm only when still stale.
9. Return whether hydration occurred and the indexed record count.

Every `list`, `show`, `search`, and `gather` operation calls `prepare()` automatically. Callers never need to remember to hydrate first.

### 11.7 Transactional hydration (historical v0.1 design)

Current MAR-2575 divergence: the numbered sequence below records the original cache-owned v0.1 design and is not the maintained hydration algorithm. The current implementation accepts one records-owned canonical snapshot containing the validated records, artifacts, exact manifest, repository identity, and current-generation assertion. A bounded optimistic manifest probe may run only to decide freshness before the operation lock; once validation or rebuilding begins, cache code performs no parallel full-corpus scan, graph pass, or retry loop.

Before any canonical record commits, acquisition, graph/artifact validation, cache writing, missing-primary handling, and disposable-corruption recovery share one records-owned maximum of three total attempts and one non-resetting 60-second deadline. The same sealed snapshot is asserted immediately before rebuild DML and immediately before `COMMIT`; generation churn rolls back and closes before a complete retry and never quarantines a valid cache solely for that churn. One writer/recovery session remains bound to the exact claimed database identity throughout those attempts.

After a canonical hard link commits, no canonical retry occurs. A cleanup or direct-snapshot-eligibility fallback may reacquire current records exactly once, bracketed by the accepted committed-generation authority; it cannot adopt a predecessor or successor. A mismatch returns the committed `REPOSITORY_CHANGED` publication-verification envelope with the bounded frozen committed prefix and deterministic validate-and-reconcile recovery. Cache/read and no-add init return ordinary validation for a settled invalid successor, while record-producing add/init retain their established path-free mutation classification after an observed pre-link race. Manifest JSON/hash bytes, schema version `1`, logical rows and FTS projection, public results and existing error fields, and all persisted canonical formats remain unchanged.

The original v0.1 sequence was:

Hydration uses one stable database and one transaction:

1. Acquire the operation lock unless already held by the enclosing operation.
2. Scan, parse, and validate every canonical record and referenced artifact.
3. Compute the complete pre-hydration manifest.
4. Recheck the manifest before starting the write.
5. Open the existing database or create it when absent.
6. If the database is corrupt and cannot be opened, close it, remove it under the lock, and create a fresh stable database.
7. Configure WAL mode.
8. Run `BEGIN IMMEDIATE`.
9. Create or transactionally replace the schema when its version is incompatible.
10. Delete and repopulate record rows and FTS rows.
11. Store artifact metadata.
12. Write schema, repository identity, package version, manifest, and indexed count last.
13. Recompute the complete record/artifact manifest immediately before commit.
14. Commit only if the pre- and post-hydration manifests match.
15. Roll back on any parsing, validation, insertion, manifest, or commit failure.

Under that historical design, external file changes retried the cache-owned hydration up to three times. MAR-2575 supersedes that retry ownership as described above. A failed command still must not query the preserved older cache.

### 11.8 Add consistency

`addRecord` holds the operation lock for validation, exclusive JSON creation, and cache hydration. It must:

1. Validate the input and candidate path.
2. Read and validate the current record graph.
3. Validate supplied supersession targets and artifacts.
4. Format the canonical JSON with two-space indentation and one final newline.
5. Check the 1 MiB formatted-file limit.
6. Create the kind directory if necessary.
7. Create the record file exclusively; never overwrite.
8. Rebuild the cache transactionally before returning success.

If the JSON file is created but cache rebuilding fails, the JSON remains canonical and the operation returns an error. A later successful `prepare()` can recover. Never delete newly written canonical knowledge merely because the disposable cache failed.

## 12. Search and read behaviour

### 12.1 Indexed text

FTS indexes:

- `kind`.
- `subject`.
- `source`.
- The canonical compact JSON representation of `payload`.
- `searchText` when present.

Artifacts are not indexed in v0.1.0.

### 12.2 Query grammar

Preserve the final Rust literal-term behaviour:

1. Split the user query wherever a character is not an ASCII letter, ASCII digit, or underscore.
2. Remove empty tokens.
3. Quote every token as an FTS literal.
4. Join tokens with `AND`.
5. Bind the resulting expression as a SQLite parameter.
6. Return `[]` without opening a query when there are no tokens.

Users cannot provide raw FTS operators in v0.1.0. Never concatenate untrusted input into SQL or a raw `MATCH` clause.

### 12.3 Active filtering

By default, `list`, `search`, and `gather` exclude superseded records. `--include-superseded` includes them. `show` returns a superseded record unless `--active-only` is supplied. Gather uses active-only show semantics unless superseded records were explicitly requested.

Missing `show` results are represented as `null` and are not errors. Gather preserves a requested missing ID as `{ id, record: null }`.

### 12.4 Deterministic ordering

- List: `createdAt` descending, then `id` descending.
- Full and compact search: `bm25` rank ascending, then `createdAt` descending, then `id` descending.
- Gather search groups: exact caller-provided order, including repeated queries.
- Gather show entries: exact caller-provided order, including repeated IDs.
- Gather does not silently deduplicate requests.
- Canonical JSON keys, generated baseline arrays, source manifests, validation output derived from scans, and supersession ID arrays use locale-independent UTF-16 code unit ordering. Sorting does not normalise or otherwise alter stored strings.

### 12.5 Compact search

Compact results contain:

```ts
export type CompactSearchResult = {
  id: string
  kind: string
  subject: string
  summary: string | null
  path: string
  rank: number
  snippet: string
}
```

Use the string `payload.summary` when available; otherwise return `null`. Generate an FTS snippet using `[` and `]` markers, `...` ellipsis, and the recovered 16-token window.

## 13. Public TypeScript API

The public API is synchronous because Node's filesystem and `node:sqlite` APIs used here are synchronous and CLI workloads benefit from a simple deterministic lifecycle.

Export these functions from the root ESM entrypoint:

```ts
export const initEncephalon: (input?: InitEncephalonInput) => InitEncephalonResult
export const addRecord: (input: AddRecordInput) => BrainRecord
export const prepare: (input?: RootInput) => PrepareResult
export const hydrate: (input?: RootInput) => HydrateResult
export const validateRecords: (input?: RootInput) => ValidateResult
export const listRecords: (input?: ListRecordsInput) => BrainRecord[]
export const showRecord: (input: ShowRecordInput) => BrainRecord | null
export const searchRecords: (input: SearchRecordsInput) => BrainRecord[]
export const searchCompactRecords: (input: SearchRecordsInput) => CompactSearchResult[]
export const gatherRecords: (input: GatherRecordsInput) => GatherResult
```

All inputs accept an optional `root` where applicable. Do not expose independent canonical-record, artifact, or database path overrides in the public v0.1 API; one root must determine the complete store.

Recommended result contracts:

```ts
export type PrepareResult = {
  hydrated: boolean
  recordsIndexed: number
}

export type HydrateResult = {
  recordsIndexed: number
}

export type ValidateResult = {
  valid: boolean
  recordsChecked: number
  errors: ValidationIssue[]
  truncated: boolean
}

export type GatherResult = {
  hydrated?: HydrateResult
  searches: Array<{
    query: string
    kind?: string
    results: CompactSearchResult[]
  }>
  records: Array<{
    id: string
    record: BrainRecord | null
  }>
}
```

Validation issues should use stable structured fields such as `code`, `message`, and optional repository-relative `path`/`recordId`, rather than unstructured strings alone. A validation result returns at most 100 issues; when additional issues exist, `truncated` is `true` and the final returned issue has code `VALIDATION_ISSUES_TRUNCATED`.

### 13.1 Error type

Export one public error class:

```ts
export class EncephalonError extends Error {
  readonly code: EncephalonErrorCode
  readonly details: Record<string, JsonValue>
  override readonly cause?: unknown
}
```

The initial stable code union is:

```text
UNSUPPORTED_RUNTIME
REPOSITORY_NOT_FOUND
INVALID_REPOSITORY
ROOT_INSTALL_REQUIRED
INVALID_ARGUMENT
VALIDATION_FAILED
RECORD_EXISTS
CACHE_BUSY
CACHE_SCOPE_MISMATCH
REPOSITORY_CHANGED
IO_ERROR
INTERNAL_ERROR
```

Known validation, repository, package-locality, conflict, and cache-state problems use their specific expected code. Filesystem failures are wrapped as `IO_ERROR`. Unexpected defects are wrapped as `INTERNAL_ERROR`. API errors retain their original `cause`, but default CLI output never prints stacks, absolute paths, or raw causes.

## 14. CLI contract

Use Node's built-in `util.parseArgs`; do not retain Commander or add another parser.

### 14.1 Global options

- `--root <path>`: exact Git repository root.
- `--help`: plain-text help, exit 0, no repository or SQLite access.
- `--version`: plain-text package version, exit 0, no repository or SQLite access.

### 14.2 Commands

`encephalon init`

- Default: initialise safely and create missing baseline records.
- `--refresh-baseline`: rescan and append changed generated snapshots.
- `--remove`: remove only managed instruction blocks.
- Refresh and remove are mutually exclusive.

`encephalon add`

- Required: `--kind`, `--subject`, `--source`, `--data <json>`.
- Optional: `--id`, `--text`, `--confidence`.
- Repeated: `--supersedes <id>`, `--artifact <path>`.

`encephalon prepare`

- Prepare the cache only when stale.

`encephalon hydrate`

- Force a validated transactional full rebuild.

`encephalon validate`

- Validate canonical records and artifacts without relying on SQLite.

`encephalon list`

- Optional: `--kind`, `--limit`, `--include-superseded`.
- Default limit: 20.
- Full-record result limit: 50.
- Full-record responses fail before returning more than 4 MiB of aggregate record JSON.

`encephalon show`

- Required: `--id`.
- Optional: `--active-only`.
- The single returned record is counted against the full-record response budget.

`encephalon search <query...>`

- Optional: `--kind`, `--limit`, `--include-superseded`, `--compact`.
- Join positional query terms with spaces before tokenisation.
- Default limit: 20.
- Query limit: 1,024 UTF-8 bytes and 32 literal terms after tokenisation.
- Full search result limit: 50 records and the 4 MiB aggregate full-record response budget.
- Compact search result limit: 100 records.

`encephalon gather`

- Repeated: `--search <query>`, `--show <id>`.
- Optional: `--kind`, `--limit`, `--include-superseded`, `--hydrate`.
- Preserve request order and `--hydrate` compatibility.
- Request limit: 16 searches and 64 shows.
- Gather searches use compact result limits. Gather shows preserve duplicate order and share the 4 MiB aggregate full-record response budget.
- Callers should narrow `kind`, reduce `limit`, or use compact search when full-record budgets are exceeded.

### 14.3 Streams and exit codes

Success:

- Write exactly one JSON value followed by `\n` to stdout.
- Write nothing to stderr.
- Exit 0.

Expected failure:

- Leave stdout empty.
- Write exactly one compact JSON error plus `\n` to stderr:

```json
{"error":{"code":"INVALID_ARGUMENT","message":"...","details":{}}}
```

- Exit 2.

Internal failure:

- Use the same safe JSON envelope on stderr.
- Use `INTERNAL_ERROR`.
- Exit 1.

Invalid validation result is the sole exception:

- Write the normal validation result to stdout.
- Write nothing to stderr.
- Exit 2.

CLI error JSON must not include a stack trace, raw cause, credential, or absolute path. Safe details may include repository-relative paths and stable field names.

## 15. `init` behaviour

### 15.1 Overall transaction shape

`init` is explicit and may mutate the host repository. It must:

1. Discover or validate the repository root.
2. Prove the executing package is the root installation.
3. Preflight both `AGENTS.md` and `CLAUDE.md` before writing either.
4. Validate existing Encephalon canonical data if present.
5. Create the cache parent and acquire the repository operation lock.
6. Create `encephalon/` when absent.
7. Run the deterministic structural scanner.
8. Create only missing generated baseline subjects, or refresh them when explicitly requested.
9. Transactionally prepare the SQLite cache.
10. Install or update the two managed instruction blocks through same-directory temporary files.
11. Release the operation lock.
12. Return a JSON result with created/refreshed/skipped records, managed-file actions, indexed count, and `nextAction`.

Preflight prevents known malformed-marker partial writes. Filesystem failures across multiple canonical files cannot be globally transactional; rerunning `init` must converge safely without rewriting already-created baseline records.

### 15.2 Deterministic structural scanner

The baseline scanner performs no network access, does not invoke models, and does not infer architectural intent. It gathers bounded, derived facts only.

Directory traversal:

- Walk regular files recursively without following symlinks.
- Stream at most 513 raw entries from each language-scan directory, the repository root, and `.github/workflows`, then sort accepted bounded entries to ensure deterministic output.
- Omit an entire directory source on overflow instead of retaining a filesystem-order-dependent prefix. Bind successful enumeration to a stable real-directory generation, including each queued child and its enumerated parent, both `.github` and its `workflows` child, and one repository-root generation shared by all baseline source passes.
- Reserve the 10,000-directory traversal budget while scheduling children so queued paths and attempted directory reads cannot exceed the bound.
- Report skipped work in the repository overview through the finite, ordinal-sorted reason vocabulary: `directory-entry-limit`, `directory-limit`, `max-depth`, `package-metadata-error`, `regular-file-limit`, `top-level-entry-limit`, `unreadable-directory`, `workflow-entry-limit`, and `workflow-enumeration-error`. Any reason makes `scanTruncated` true.
- Exclude `.git`, `encephalon`, `node_modules`, common dependency/vendor directories, caches, coverage, build output, generated output, temporary directories, and package-manager stores.
- Do not read hidden environment or registry files.
- Do not inspect the Git index, Git objects, Git history, remotes, branches, or commits.
- Do not read source-file bodies for language detection; count recognised extensions.

Persistable facts:

- Safe top-level file and directory names, excluding secret-prone hidden paths.
- Recognised root manifest, lockfile, and configuration filenames.
- Root `package.json` package name, valid `packageManager` declaration, workspace presence, and discovery-only script keys, accepted only from a verified, no-follow regular file no larger than 1 MiB. Missing package metadata is normal; invalid, oversized, unreadable, or replaced metadata contributes no package facts or source attribution.
- Package-manager evidence is recorded as `unknown`, `declared`, `lockfile-derived`, `declared-and-lockfile`, or `conflicted`; `packageManager` is present only when declaration and lockfile evidence identify one unambiguous manager.
- Derived package script invocations as structured `{ executable, arguments, scriptKey }` argv data; never shell command strings or the script body. These invocations are omitted when the package manager is unknown or conflicted. Script keys beginning with `-` remain discoverable in `scriptKeys` but do not produce runnable invocations.
- CI workflow filenames under `.github/workflows`; never YAML content, triggers, jobs, steps, secrets, or environment values.
- Recognised language/file counts derived from extensions.
- Repository identity derived from a safe root package name, or the root directory basename when no manifest provides a name.
- Repository-relative safe source references identifying which manifest filenames informed the record.

Forbidden persisted content:

- Raw source bodies.
- Raw package script bodies.
- README, AGENTS, CLAUDE, or arbitrary documentation body text.
- Arbitrary commands extracted from prose.
- CI YAML contents or trigger interpretation.
- `.npmrc`, registry settings, tokens, environment files, or environment values.
- Git remotes, URLs, history, authors, emails, commit messages, or branch names.
- Absolute paths.
- Dependency, vendor, cache, coverage, generated, or build paths.
- Existing Encephalon records or managed blocks, which would make refresh self-referential.

### 15.3 Fixed baseline records

Generate no more than these subjects:

1. Kind `context`, subject `encephalon:init/repository-overview`.
   - Safe repository identity.
   - Safe top-level layout.
   - Manifest source filenames.
2. Kind `architecture`, subject `encephalon:init/tooling-layout`.
   - Recognised languages and counts.
   - Manifest, lockfile, workspace, and configuration presence.
3. Kind `workflow`, subject `encephalon:init/commands-ci`.
   - Package script keys as discovery-only data and safe derived structured invocations as the only execution source of truth.
   - CI workflow filenames.

All use `source: "encephalon:init"`. Payload keys and arrays are emitted in a stable order so canonical deep comparison is deterministic.

### 15.4 Initialisation and refresh semantics

Ordinary `init`:

- If no active record exists for a reserved subject, append the generated record.
- If an active generated record exists, leave it unchanged even if the current scan differs.
- If an active agent-authored record uses the reserved subject, return a skipped conflict and do not supersede it.
- Never rewrite an existing generated record.

`init --refresh-baseline`:

- Compute the new canonical payload for each reserved subject.
- Compare it with every active generated head while ignoring ID and timestamp.
- Write nothing when facts are unchanged.
- Append one replacement when facts changed.
- Supersede every active generated head for that subject to reconcile parallel branches.
- If an active non-generated head exists, skip with a structured conflict result.
- Never alter agent-authored records.

### 15.5 `nextAction`

The CLI cannot reliably determine whether a human or coding agent invoked it. Every successful initialisation returns a `nextAction` directing an agent to read:

```text
./node_modules/encephalon/skills/encephalon/SKILL.md
```

and perform its optional initial semantic-enrichment workflow. Humans receive the same deterministic result without the CLI attempting model detection.

## 16. Managed agent-discovery blocks

### 16.1 Target files

Manage one block in each repository-root file:

- `AGENTS.md`
- `CLAUDE.md`

Do not create `.agents/skills`, `.claude/skills`, copied skills, or symlinks. The package's single canonical skill remains under `node_modules/encephalon/skills/encephalon/SKILL.md`.

### 16.2 Marker format

Use fixed HTML comment markers with versioned hidden metadata. The visible content must remain minimal and point agents to the packaged skill. An illustrative shape is:

```markdown
<!-- encephalon:start {"version":1,"createdFile":false,"separator":"lf"} -->
For repository knowledge, read and follow `./node_modules/encephalon/skills/encephalon/SKILL.md`.
<!-- encephalon:end -->
```

The exact metadata encoding must be deterministic, parseable without dependencies, and tested. It records:

- Managed-block format version.
- Whether `init` created the file.
- Whether a separator newline was inserted before the block.
- Which line-ending sequence the block uses.

### 16.3 Preflight

Before changing either file:

- Read raw bytes when it exists.
- Reject NUL-containing or invalid UTF-8 text.
- Reject instruction files larger than 1 MiB before rewriting them.
- Detect the file's existing line ending without normalising content.
- Detect zero, one, or multiple marker pairs.
- Reject duplicate, nested, reversed, or unmatched markers.
- Validate managed metadata when a block exists.
- Complete this validation for both files before writing either.

### 16.4 Installation and update

- Preserve every byte outside the managed span.
- Preserve the existing file's line-ending convention.
- When appending, record exactly which separator bytes were inserted.
- When creating an absent file, record `createdFile: true`.
- When a file existed but was empty, record `createdFile: false`.
- Replace only the exact managed block on rerun.
- Write through a same-directory temporary file and rename after the replacement content is ready.
- Rerunning with the current format must be byte-for-byte idempotent.

### 16.5 Removal

`init --remove` removes only the managed blocks:

- Remove the exact block bytes and recorded separator.
- Preserve all user bytes before and after the block.
- Delete the file only when Encephalon originally created it and no user content remains.
- Preserve a file that existed but was originally empty.
- Preserve LF, CRLF, and no-final-newline states exactly.
- Never delete `encephalon/`, artifacts, cache, package metadata, or lockfiles.

## 17. Packaged Encephalon skill

Create `skills/encephalon/SKILL.md` as a concise general-purpose skill. Its frontmatter contains only:

```yaml
---
name: encephalon
description: Use when an installed repository may contain durable Encephalon knowledge relevant to architecture, decisions, conventions, incidents, workflows, or material technical changes.
---
```

The body must teach the following behaviour:

### 17.1 Query before assumptions

- Confirm the current repository contains the managed Encephalon instruction and root package installation.
- Use `npx --no-install encephalon gather` or compact search before loading full records.
- Search broadly first, then show only relevant IDs.
- Treat active records as durable repository knowledge while acknowledging that repository state may have changed after the record.
- Cite record ID or subject when using stored knowledge.
- State clearly when no relevant record exists.

### 17.2 Initial semantic enrichment

When an agent is asked to initialise Encephalon:

1. Run the installed `init` command.
2. Read the returned structural baseline.
3. Inspect only relevant high-signal code and documentation.
4. Add concise records explaining important architectural boundaries, conventions, and durable decisions that deterministic scanning cannot infer.
5. Avoid narrating every file or duplicating the structural baseline.
6. Validate the resulting records.

### 17.3 Automatic capture threshold

Create a record only for durable, high-signal information future agents would otherwise need to rediscover, including:

- A consequential architectural decision and its rationale.
- A material technology, dependency, deployment, API, schema, or persistence change.
- A repository-wide convention or workflow that affects future work.
- A significant incident, root cause, or non-obvious operational constraint.
- A material pull-request change whose intent is not obvious from code alone.

Do not record:

- Routine edits or mechanical refactors.
- Transient task state or status updates.
- Chat logs, raw terminal output, raw exports, or broad source dumps.
- Secrets, credentials, tokens, environment values, or private URLs.
- Local absolute paths.
- Speculation presented as fact.
- Information already represented by an equivalent active record.

### 17.4 Append-only updates

- Search the intended kind and subject before writing.
- Add new knowledge with a stable subject.
- When meaning changes, create a new same-kind/same-subject record superseding every active head.
- Never edit an already-shared record to change meaning.
- Use resolver records for parallel active heads.
- Validate after writing.
- Include the new record and artifacts with the related source change, but never stage, commit, push, or open a PR automatically.

The skill must remain compact enough to load frequently. It should refer agents to CLI `--help` rather than reproducing every option.

## 18. Test-driven implementation sequence

Production behaviour must be developed with red-green-refactor cycles. Each step below begins with a focused failing test whose failure is caused by missing behaviour, followed by the smallest implementation that makes it pass.

### Phase A — bootstrap and package shell

1. Add the plan, MIT licence, minimal README, package manifest, TypeScript configuration, and ignore rules.
2. Add a package-contract test that inspects `package.json` and initially fails because the expected exports/build outputs are absent.
3. Add the minimal source entrypoints and build scripts.
4. Build and verify import purity with a subprocess that imports the bundle outside a repository.

### Phase B — portable schema and validation

1. Write synthetic golden fixtures matching the recovered TypeScript/Rust envelope.
2. Test valid records, omitted optional fields, arrays for supersedes/artifacts, and runtime-only paths.
3. Test every invalid primitive, field limit, safe-name rule, Windows reserved name, traversal form, symlink form, duplicate ID, and case collision.
4. Test missing/self/cyclic/cross-subject supersession and multiple active heads.
5. Implement the minimum schema parser and validator.

### Phase C — canonical reads and writes

1. Test exact one-level record scanning and `_artifacts` exclusion.
2. Test deterministic timestamp/ID ordering and repository-relative paths.
3. Test exclusive record creation and `RECORD_EXISTS`.
4. Test caller-supplied IDs and the artifact-first workflow.
5. Implement record scanning, formatted writing, and append-only graph validation.

### Phase D — root and package resolution

1. Test ordinary repositories, nested working directories, monorepos, worktree `.git` files, invalid `.git` files, submodules, explicit roots, and missing repositories.
2. Test root-local npm-style and symlinked pnpm/Bun-style installations.
3. Test ephemeral or workspace-local execution returning `ROOT_INSTALL_REQUIRED`.
4. Implement root discovery and package-realpath comparison.

### Phase E — SQLite and search

1. Test lazy runtime capability probing.
2. Test hydration of golden fixtures into a stable WAL database.
3. Test full and compact search, literal tokenisation, summary extraction, snippets, rank ordering, kind filters, limits, and active filtering.
4. Test list/show ordering and missing `show` as `null`.
5. Test gather request ordering, repetitions, missing IDs, and `--hydrate` compatibility.
6. Implement the minimal database schema and queries.

### Phase F — freshness, transactions, and concurrency

1. Test that unchanged records skip hydration.
2. Test that record creation, replacement, deletion, type change, and timestamp/size changes invalidate freshness.
3. Test that referenced artifact deletion/change/symlink introduction invalidates freshness.
4. Test rollback when validation or insertion fails.
5. Test that a failed prepare never proceeds to query the stale cache.
6. Test external changes during hydration and the three-attempt `REPOSITORY_CHANGED` failure.
7. Test lock contention and `CACHE_BUSY` with real child processes where practical.
8. Test shared-cache repository mismatch.
9. Implement locking, manifest logic, prepare, and transactional hydrate.

### Phase G — CLI

1. Test help/version without repository access.
2. Test every command's JSON output and relevant flags through the built Node CLI.
3. Test expected versus internal error envelopes and exit codes.
4. Test invalid validation as stdout plus exit 2.
5. Implement parsing with `util.parseArgs` and a thin API-to-process adapter.

### Phase H — baseline and managed files

1. Test the allowlisted scanner against a fixture containing secrets, raw scripts, docs, CI steps, build output, symlinks, and an existing `encephalon/` tree.
2. Assert that only safe derived facts enter baseline payloads.
3. Test ordinary init idempotence and explicit refresh supersession.
4. Test parallel generated heads and agent-authored reserved-subject conflicts.
5. Test managed blocks for absent, empty, LF, CRLF, and no-final-newline files.
6. Test malformed markers preflight both files before either changes.
7. Test exact `--remove` round trips.
8. Implement scanner, baseline, managed blocks, and init orchestration.

### Phase I — skill and distribution

1. Define pressure scenarios for query-first behaviour, high-signal capture, refusal to record secrets/noise, supersession, and no automatic Git operations.
2. Author the smallest skill that makes those expectations explicit.
3. Validate the skill's frontmatter and directory shape.
4. Build and inspect the npm tarball.
5. Install it with scripts disabled into temporary Git repositories using supported package-manager layouts.
6. Execute init and representative CLI/API operations with Node only.

## 19. Complementary test suites

Keep the total suite focused. Prefer table-driven cases inside a small number of files over one test per trivial branch.

### 19.1 `records.test.ts`

Cover:

- Golden valid envelope.
- Strict optional-field handling.
- Runtime JSON validation.
- Portable kind/ID/path predicates.
- Exact one-level scanning.
- Supersession graph semantics.
- Artifact containment and regular-file checks.
- Exclusive append-only creation.
- Deterministic ordering.

### 19.2 `cache.test.ts`

Cover:

- WAL schema and FTS capability.
- Full/compact search and active filtering.
- Prepare freshness.
- Artifact invalidation.
- Transaction rollback.
- External-change retry.
- Lock contention.
- Repository scope mismatch.

### 19.3 `cli.test.ts`

Cover:

- Help/version purity.
- JSON stdout/stderr separation.
- Exit 0/1/2 semantics.
- Commands and repeated flags.
- Missing show, empty search, and gather order.

### 19.4 `init.test.ts`

Cover:

- Root-install enforcement.
- Safe structural baseline.
- Idempotence and explicit refresh.
- Generated-subject conflict handling.
- Managed-block preflight, update, and removal round trips.

### 19.5 `package.test.ts` or package smoke script

Cover:

- ESM export map and declarations.
- Executable bin and shebang.
- Node engine.
- Zero runtime dependencies.
- Forbidden lifecycle scripts absent.
- Tarball whitelist.
- No unresolved Bun imports.
- Node-only install and execution with scripts disabled.

## 20. CI contract

Create a GitHub Actions matrix for Ubuntu, macOS, and Windows using Node 24. CI must:

1. Check out the clean public repository.
2. Install the pinned Bun maintainer toolchain.
3. Install dependencies from the committed lockfile.
4. Run formatting/linting if configured.
5. Run TypeScript typechecking.
6. Run the test suite.
7. Build the Node ESM distribution.
8. Inspect package contents with machine-readable `npm pack` output.
9. Run `npm publish --dry-run` after the build and package inspection so npm's publish-time manifest normalisation is part of the release gate without uploading anything.
10. Install the actual tarball into a temporary Git repository with scripts disabled.
11. Run help/version, init, validate, add, prepare, list, show, search, and gather through Node.

At least one local or CI smoke path must verify pnpm-style symlink resolution. Unit tests cover Windows path predicates even when the host filesystem cannot create reserved names.

CI must not publish. Release remains a deliberate maintainer action for 0.1.0.

## 21. Documentation requirements

The public README must explain:

- What Encephalon is: durable, repository-local, Git-mergeable knowledge for coding agents.
- The distinction between canonical JSON and disposable SQLite.
- Node 24.15.0 requirement and absence of a Bun runtime requirement.
- Root dev-dependency installation and `npx --no-install encephalon init`.
- The generated `encephalon/` structure.
- The managed AGENTS/CLAUDE discovery blocks.
- Basic add, search, gather, show, validate, and refresh examples.
- Append-only supersession and resolver records.
- Artifact placement and the explicit-ID workflow.
- Supported package-manager layouts and Yarn PnP limitation.
- Privacy and safety guidance: do not store secrets or raw dumps.
- How to uninstall discovery blocks safely with `init --remove`.
- That removing blocks does not remove records.
- MIT licence and contribution expectations.

Do not market unimplemented hosted, semantic, or native-binary features.

## 22. Release sequence

### 22.1 Pre-release validation

Before merging the initial release:

- Run every formatting, lint, typecheck, test, build, and package-check script except irrelevant browser E2E tests.
- Confirm the working tree contains no SQLite database, generated host `encephalon/` directory, secrets, or private files.
- Inspect the complete branch diff from bootstrap.
- Inspect all reachable Git objects intended for the public remote.
- Inspect the generated `dist` output.
- Inspect the exact npm tarball.
- Smoke-install the tarball with lifecycle scripts disabled.
- Run the installed CLI under Node without Bun available on the execution path.
- Verify no runtime dependencies or native additions were introduced.

### 22.2 Public Git flow

- Push `bootstrap` explicitly.
- Push `initial-release` explicitly.
- Open a PR into `bootstrap` with British-English prose and a complete verification summary.
- Wait for all required CI checks.
- Merge the PR without rewriting private history into the branch.
- Rename the default branch to `main`.
- Fetch and verify the local `main` tracking relationship.

### 22.3 npm publication

Immediately before publication:

1. Recheck that the unscoped npm name `encephalon` remains available or belongs to the maintainer.
2. Confirm the merged commit and clean worktree.
3. Build from the merged commit.
4. Re-run package inspection, smoke installation, and the npm publication dry-run.
5. Authenticate to npm with the intended public account and 2FA.
6. Run the manual public publish for `0.1.0`.
7. Verify npm metadata, tarball contents, install behaviour, CLI version, and API import from the registry package.

Publishing is an external irreversible action. If interactive 2FA or an account choice is required, stop at the prepared publish command and request the maintainer's direct participation rather than guessing credentials or account intent.

### 22.4 Post-0.1 publishing hardening

After the first manual package exists:

- Configure npm trusted publishing for the exact GitHub repository and workflow.
- Add a minimal GitHub-hosted OIDC publish workflow with `id-token: write` and no long-lived npm token.
- Enable npm provenance.
- Use future GitHub Releases/tags only after CI succeeds.

This hardening is deliberately sequenced after 0.1.0 and must not delay the first release.

## 23. Detailed acceptance checklist

### Provenance and repository

- [ ] The plan is the first project artifact.
- [ ] Work occurs on `bootstrap` and `initial-release`, never directly on `main`.
- [ ] The public repository has no private source-project remote.
- [ ] No private commit or object was imported.
- [ ] Publication rights for reused generic source are confirmed, or the behaviour is freshly implemented.
- [ ] Complete Git-object scanning finds no private data.

### Package

- [ ] `encephalon@0.1.0` has MIT metadata and the exact repository URL.
- [ ] Node engine is `>=24.15.0`.
- [ ] Runtime dependencies are empty.
- [ ] Forbidden lifecycle scripts are absent.
- [ ] ESM API, declarations, and CLI are present in the tarball.
- [ ] CLI shebang and executable mode are correct.
- [ ] Consumer execution has no Bun requirement.

### Canonical data

- [ ] Records exist only at `encephalon/<kind>/<id>.json`.
- [ ] Artifacts exist only under the matching `_artifacts/<kind>/<id>/` tree.
- [ ] Runtime `path` is never serialized.
- [ ] Strict field, JSON, size, path, and Windows-portability validation works.
- [ ] Supersession arrays support multi-head resolver records.
- [ ] Existing canonical records are never rewritten during reads or hydration.

### Cache and concurrency

- [ ] Cache lives only at `node_modules/.cache/encephalon/brain.sqlite`.
- [ ] It uses one stable WAL database and transactional full rebuilds.
- [ ] Every read performs the preparation state machine once and uses the retained verified transaction for its result.
- [ ] Record and artifact changes invalidate freshness.
- [ ] Failed hydration rolls back and does not query stale data.
- [ ] Operation locking covers add, baseline, refresh, prepare, and hydrate.
- [ ] Live locks are not broken based only on age.
- [ ] Shared-cache repository identity fails closed.
- [ ] Incompatible owned table, constraint, index, and FTS5 semantics are quarantined and rebuilt once rather than repaired in place.

### API and CLI

- [ ] All documented synchronous functions and types are exported.
- [ ] Module import has no filesystem or SQLite side effects.
- [ ] Stable error codes and JSON envelopes match the contract.
- [ ] CLI stream and exit behaviour is exact.
- [ ] Literal search grammar and deterministic ordering match golden tests.
- [ ] Missing show results are `null`.
- [ ] Gather preserves repeated request order.

### Init and agents

- [ ] Install alone makes no host-repository changes beyond normal package-manager files.
- [ ] Init verifies the root-local executing package.
- [ ] Baseline scanning persists only safe derived facts.
- [ ] Initialisation is idempotent.
- [ ] Refresh appends changed generated snapshots and supersedes all generated heads.
- [ ] Agent-authored reserved subjects are never overwritten.
- [ ] The CLI returns `nextAction` without model detection.
- [ ] Managed blocks are preflighted together and exactly reversible.
- [ ] No copied or symlinked agent skill directories are created.
- [ ] The packaged skill queries before assumptions and records only high-signal durable knowledge.
- [ ] The skill never stages, commits, pushes, or creates PRs automatically.

### Verification and release

- [ ] Tests pass on Ubuntu, macOS, and Windows Node 24.
- [ ] Tarball smoke installation passes with scripts disabled.
- [ ] npm/pnpm/Bun node_modules layouts are covered; Yarn PnP fails clearly.
- [ ] Source, bundle, skill, fixtures, history, and tarball contain no private-company data, secrets, private URLs, or local absolute paths.
- [ ] The first release is manually published with the maintainer's npm account and 2FA.
- [ ] OIDC/provenance hardening is handled after the first release.

## 24. Implementation completion definition

Implementation is not complete merely because source code compiles or unit tests pass. Completion requires all of the following:

1. The public clean-room source is implemented on the feature branch.
2. Every specified API and CLI behaviour is exercised by complementary tests.
3. The Node-targeted distribution builds and runs without Bun.
4. Package inspection and scripts-disabled smoke installation pass.
5. Cross-platform CI passes.
6. Managed blocks and baseline generation satisfy byte-preservation and privacy tests.
7. Provenance scans cover both the working tree and complete public Git object graph.
8. The implementation PR is merged through the bootstrap default branch and renamed to `main`.
9. The exact merged tarball is reviewed.
10. `encephalon@0.1.0` is published and verified from the npm registry, unless publication is waiting solely for unavoidable maintainer authentication or 2FA—in which case the prepared release and exact remaining manual action must be reported clearly.

No later speculative feature should delay these requirements. The v0.1.0 package succeeds when agents can install it in an existing Git repository, explicitly initialise a safe baseline, query durable knowledge quickly through the CLI or typed API, and append high-signal records that remain portable and mergeable for the lifetime of the repository.
