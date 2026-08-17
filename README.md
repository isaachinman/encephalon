<p align="center">
  <img src="./assets/encephalon.png" alt="Encephalon" width="240">
</p>

# Encephalon

Encephalon gives coding agents durable, repository-local knowledge. Canonical records are small, structured JSON files that travel with the code; a disposable SQLite full-text index makes them quick to query through the CLI or synchronous API.

Encephalon is general-purpose. It does not include hosted services, accounts, telemetry, network access, automatic Git operations, embeddings, daemons, or project records.

## Requirements

- Node.js 24.15.0 or later
- A Git repository using a package-manager layout that exposes `node_modules/encephalon` at the repository root

Bun is used to build and test Encephalon itself. Installed projects run the bundled ESM distribution with Node and do not need Bun. The package has zero runtime dependencies and no installation lifecycle scripts.

Yarn Plug'n'Play is not supported in v0.2.0.

## Install

Install Encephalon at the root of the Git repository:

```bash
npm install --save-dev encephalon
npx --no-install encephalon init
```

`init` safely derives bounded repository metadata, creates up to three baseline records, builds the local cache, and adds a reversible managed block to root `AGENTS.md` and `CLAUDE.md`. For baseline records, it reads only a bounded, verified `package.json` and extracts fields such as package name, package manager, workspace globs, and script keys. It streams at most 513 raw entries from each top-level, language-scan, or workflow directory to distinguish the 512-entry limit from overflow before filtering, and schedules at most 10,000 language directories. Directory children remain bound to their enumerated parents, and all source passes must share one stable repository generation. An overflowed, unreadable, or replaced source contributes no rejected facts; the repository overview reports bounded, stable reason codes instead.

`init` reads root `AGENTS.md` and `CLAUDE.md` byte-for-byte only to preserve, replace, or remove the managed Encephalon block safely. Unrelated instruction text is not semantically scanned, stored in generated records, indexed for search, printed to stdout, or included in error details. `init` does not read source bodies, README content, environment files, registry configuration, Git history, Git remotes, or CI workflow contents.

Existing instruction files must be valid UTF-8, NUL-free, regular non-symlink files no larger than 1 MiB. Invalid files are rejected before either instruction file is changed.

Initialisation is monotonic across its records, disposable cache, and managed instruction files; it is not one global transaction. If an `init` call fails, the original `EncephalonError` code, message, cause, and safe subsystem details are preserved, and `details.initProgress` reports the phase, whether any canonical record commit occurred, committed record IDs in publication order, committed `AGENTS.md` or `CLAUDE.md` update/removal actions in file order, cache state, recovery mode, and fixed recovery action. Those lists report commit events reached during that call, not that the same pathname incarnation is still current after a repository change.

Use `rerun` by repeating the same init operation with the same options. For `inspectAndRerun`, first inspect the reported canonical records, instruction files and repository-relative recovery paths, or operation-cleanup state named by the recovery action. A disposable cache is never canonical: after cache preparation fails, inspect canonical state when directed, run `prepare`, run `validate`, then repeat the same init operation with the same options. Reruns rescan and replan so partial baseline creation, baseline refresh, instruction updates, and `--remove` converge without duplicate active generated heads or duplicate managed blocks. `initProgress` is bounded and excludes subjects, payloads, instruction bytes, absolute or cache paths, raw causes, ownership tokens, stacks, and arbitrary filesystem names.

Managed instruction writes and removals bind the repository root to one fixed no-follow directory identity and, where supported, a held directory descriptor. Staged files and predecessors remain on operation-owned or read-only no-follow descriptors. Unrelated root entries do not invalidate that authority, but replacing the root path or any affected source or destination fails closed. On POSIX filesystems, staged and recovery files are created and verified at mode `0600` while their frozen expected bytes are written, flushed, and checked; the intended final mode is then applied, flushed, and verified again. Windows applies and checks restrictive mode bits where the filesystem supports them, while exclusive creation, exact bytes, and descriptor/path identity remain mandatory without claiming a POSIX-permission guarantee for Windows ACLs. An existing predecessor is moved with exclusive hard-link-and-unlink steps: the new backup alias is verified and the directory is flushed before the canonical alias is removed. A pre-commit restoration is likewise flushed before its last durable recovery source is removed, and a fallback recovery alias is flushed before it is reported as the last predecessor pathname.

The replacement commits when the staged file is hard-linked at the canonical `AGENTS.md` or `CLAUDE.md` path. After commit, Encephalon never restores predecessor bytes over the canonical path; a detected concurrent canonical or operation-path successor is preserved and reported as `REPOSITORY_CHANGED`. A successful replacement leaves the canonical file and no temporary, backup, or deletion alias created by that operation; generated-looking historical files are not discovered or removed. If final temporary cleanup loses the last staged pathname, an exact private staged recovery alias is retained before its descriptor is closed.

Post-commit errors return the primary phase, a bounded `postCommitFailures` list of every distinct failed or deferred recovery phase, and an ordinal-sorted `recoveryPaths` list of exact repository-relative aliases still proved to belong to this operation. Those paths never contain instruction contents or absolute paths, and users should not infer ownership from other generated-looking names. Any identity-uncertain captured failure makes the aggregate code `REPOSITORY_CHANGED`, while phase priority still chooses the primary message. A later successful cumulative directory flush supersedes an earlier transient publication-flush failure. Repeating the same `init` operation with the same options after the managed result is unchanged revalidates the planned canonical files and performs the containing-directory sync; it does not discover or remove retained aliases. Node has no portable descriptor-relative `linkat` or conditional `unlinkat`: checks immediately bracket each pathname link and unlink, but a narrow same-user root-replacement window remains inside those syscalls. A detected replacement is reported and its successor is preserved; that syscall window is not a supported security boundary. Directory durability is best effort where directory fsync is unsupported.

The result includes a `nextAction` asking an agent to read the installed skill and optionally enrich the baseline semantically.

Refresh derived facts after meaningful tooling or layout changes:

```bash
npx --no-install encephalon init --refresh-baseline
```

Remove only the managed instruction blocks:

```bash
npx --no-install encephalon init --remove
```

Removal does not delete records, artifacts, the cache, or the package.

## Query knowledge

Compact search is the quickest exploration path:

```bash
npx --no-install encephalon search --compact "authentication deployment"
npx --no-install encephalon show --id "<record-id>" --active-only
```

Batch searches and record reads while preserving caller order:

```bash
npx --no-install encephalon gather \
  --search "authentication architecture" \
  --search "deployment workflow" \
  --show "<record-id>"
```

Every `list`, `show`, `search`, and `gather` call prepares the cache automatically. `prepare` reuses a valid fresh cache and rebuilds after canonical inputs change or a recoverable cache failure; `hydrate` forces a transactional rebuild.

```bash
npx --no-install encephalon list --kind decision
npx --no-install encephalon prepare
npx --no-install encephalon validate
```

Active records are returned by default. Add `--include-superseded` to `list`, `search`, or `gather` when historical records are needed. Missing `show` results are `null`, and empty searches are `[]`.

### Operation budgets

List and full search accept 1–50 results. Compact search and each gather search accept 1–100 results. A gather request accepts at most 16 searches and 64 shows, while an add request accepts at most 1,000 supersession targets. Search queries are limited to 1,024 UTF-8 bytes and 32 literal terms. Full-record responses from list, show, full search, and gather contain at most 4 MiB of aggregate record JSON.

An oversized result limit, gather input count, or supersedes input count fails with `INVALID_ARGUMENT` before item validation, repository discovery, or cache I/O. Budget errors expose only the fixed details `{ field, budget, maximum }`; they do not include input arrays, individual values, queries, paths, or other input content. Cache checks retain the same limits as defence-in-depth for internal callers. Narrow the kind/query or request compact results when a full-record response exceeds these budgets.

## Add durable knowledge

Search the stable subject first. If the new record replaces active knowledge, repeat `--supersedes` for every active head:

```bash
npx --no-install encephalon add \
  --kind decision \
  --subject api.authentication \
  --source agent \
  --supersedes "<active-record-id>" \
  --data '{"summary":"Use signed bearer tokens","rationale":["Supports non-browser clients"]}' \
  --text "authentication bearer tokens"
```

Recommended kinds are `decision`, `architecture`, `convention`, `workflow`, `incident`, and `context`. Other kinds may use lowercase letters, digits, underscores, and hyphens. Leading underscores are reserved.

Encephalon is append-only: changes are represented by a replacement record, not by editing or deleting an earlier record. A replacement must supersede every active head with the same kind and subject.

## Storage

The consuming repository's durable data has one top-level directory:

```text
encephalon/
  <kind>/<id>.json
  _artifacts/<kind>/<id>/...
```

The runtime-only `path` field is not written to record files. Optional fields are omitted rather than written as `null`.

```ts
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

Callers do not supply `createdAt`. Encephalon validates the input first, then assigns the timestamp while holding the repository operation lock so each committed record is strictly later than canonical history; initial baseline records advance in the same locked order.

The v0.x canonical corpus may contain at most 1,000 records, 8 MiB of aggregate record JSON, 1,000 supersession edges, and 1,000 artifact references. Validation returns at most 100 issues; when more issues exist, the result sets `truncated: true` and ends with a `VALIDATION_ISSUES_TRUNCATED` sentinel.

Canonical directory enumeration is also bounded before record contents are read. The `encephalon` root may contain at most 1,002 entries and 1,000 kind directories, while each kind directory may contain at most 1,000 entries. `_artifacts` and `_staging` count towards the 1,002 root-entry limit but not the kind-directory limit; their reserved directory trees are excluded from the record-manifest portion of cache freshness, while referenced artifact files are included separately. An overflow produces one deterministic `CORPUS_DIRECTORY_ENTRY_LIMIT` issue for the containing repository-relative directory without reporting excess filenames. Validation and cache freshness checks reject directory-generation changes rather than accepting records or metadata from mixed or replaced directories. Record additions and initialisation carry those validated generations through preflight, publication, and post-link verification, account for every planned entry grouped by kind as well as every new kind and the staging directory, and reject unrelated successor generations. Before publishing, mutations inspect at most 1,001 direct `_staging` entries and remove up to 1,000 stale files or symlinks only when their names exactly match Encephalon's owned staging or recovery-quarantine formats. Cleanup uses one bounded initial enumeration plus bounded one-entry emptiness probes; it never recursively scans or follows symlinks. Each accepted entry is moved to a random sibling quarantine, identity-verified without following links, and only then unlinked; regular files remain bound to open descriptors. The current operation keeps its staging descriptor through canonical linking, cleanup, directory flushes, authority acceptance, and final canonical and empty-staging verification. Overflow, malformed names or types, late entries, and detected replacements preserve affected entries and return repository-relative inspect-and-retry guidance without disclosing their names. Node has no portable descriptor-relative conditional unlink, leaving a narrow final pathname-syscall window after the adjacent identity checks.

Payload values are validated without invoking accessors. They may contain at most 64 nested levels and 10,000 JSON nodes, counting the root value, arrays, objects, and primitive values.

The disposable cache lives at `node_modules/.cache/encephalon/brain.sqlite` and should not be committed. Encephalon verifies that its cache ancestors, SQLite files, sidecars, and operation-lock entries are real contained entries before use and identity-specific cleanup. It uses SQLite WAL mode, FTS5, a repository-scoped operation lock, manifest-based freshness, and transactional table rebuilds. Canonical records remain the source of truth.

Disposable-cache validation treats every SQLite value as untrusted. Numeric-only probes run before text transfer and observe at most seven metadata rows or 1,001 record/FTS rows. The canonical authorities remain 1 MiB per record and 8 MiB for the 1,000-record corpus; cached `record_json` receives only a fixed 4 KiB-per-record runtime-path allowance, for a derived aggregate ceiling of 12,484,608 bytes (8 MiB + 1,000 × 4 KiB). Schema, metadata, record, and FTS validation, freshness checks, and the requested public read share one verified SQLite transaction, so results cannot mix database generations.

On the first recoverable cache failure, Encephalon uses the operation lock already held by the caller or acquires it, quarantines only an exact captured database and its sidecars, and rebuilds once from canonical JSON. If a previously observed primary disappeared before its verified open, recovery rechecks the path under that lock and claims an absent primary through exclusive creation. A successor that wins that creation race is preserved and retried without quarantine or writer initialisation. Prepare and forced hydration return a completed recovery rebuild directly; reads retry once. A second failure is terminal. This policy also covers post-commit add hydration and init cache preparation under their existing lock. A valid foreign cache remains `CACHE_SCOPE_MISMATCH` and is never quarantined; repository changes, busy/locked contention, operational I/O, and unknown SQLite failures retain their fail-closed policies. Semantic SQLite schema validation remains assigned to MAR-2553, and equality between FTS text and canonical cached records remains assigned to MAR-2550.

Artifacts must be regular, non-symlink files beneath `_artifacts/<kind>/<id>/`. Record IDs and artifact paths are checked for traversal, platform portability, Windows-reserved names, case collisions, size limits, and containment. Validation binds every ancestor to the verified brain-root generation and derives cache metadata from one stable, read-only, nonblocking artifact descriptor; cache freshness enumerates records before reusing the same no-follow artifact inspection.

## Synchronous API

Importing the package does not discover a repository, touch the filesystem, or open SQLite.

```ts
import {
  addRecord,
  gatherRecords,
  initEncephalon,
  listRecords,
  prepare,
  searchCompactRecords,
  showRecord,
  validateRecords,
} from "encephalon";

const decisions = searchCompactRecords({
  root: process.cwd(),
  kind: "decision",
  query: "authentication",
});
```

The package exports `initEncephalon`, `addRecord`, `prepare`, `hydrate`, `validateRecords`, `listRecords`, `showRecord`, `searchRecords`, `searchCompactRecords`, `gatherRecords`, their input/result types, record types, and `EncephalonError`.

API calls return values and never print or exit. Expected failures throw `EncephalonError` with one of these stable codes:

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

Without `root`, Encephalon walks upward to the nearest valid Git repository marker. With `root`, that canonical path is exact and no upward search occurs. Commands also verify that the executing package is the installation exposed at the repository root, rejecting ephemeral execution and workspace-local installations.

## Development

```bash
bun install --frozen-lockfile
bun run typecheck
bun run test
bun run build
bun run check:package
bun run check:publish
```

Performance benchmarks are separate from correctness tests:

```bash
bun run benchmark -- --output docs/performance-baseline.json
bun run benchmark:check
```

See [docs/performance.md](./docs/performance.md) for benchmark profiles, budgets, baseline results, and scale guidance.

`check:package` inspects the npm tarball, installs it with lifecycle scripts disabled, imports the public API, and runs the bundled CLI using Node. `check:publish` exercises npm's publish-time manifest normalisation without uploading anything. CI runs four verification lanes: Node 24.15.0 on Ubuntu, macOS, and Windows, plus Node 26 on Ubuntu. Only trusted pushes to `main` run the separate release-equivalent package gate, which validates the publish dry run before uploading the generated `npm pack` tarball for inspection.

## Licence

MIT
