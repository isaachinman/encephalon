# Encephalon Maintained Contract

Status: maintained for the current v0.x implementation.
Last reviewed: 2026-08-12 for audited snapshot `c4e84f771ced86a669cb0cc0fcc0af19d5646461`.

This document is the concise contract maintainers should update when public behaviour or safety invariants intentionally change. The historical implementation plan remains design input and provenance context, not the normative source of truth.

## Public API and CLI

- The package exposes the synchronous API listed in `src/index.ts` and documented in the README: `initEncephalon`, `addRecord`, `prepare`, `hydrate`, `validateRecords`, `listRecords`, `showRecord`, `searchRecords`, `searchCompactRecords`, `gatherRecords`, exported input/result types, record types, and `EncephalonError`.
- Importing the package must not discover a repository, open SQLite, or mutate the filesystem.
- API failures that users can reasonably handle throw `EncephalonError` with a stable code from `src/types.ts`.
- CLI success writes one JSON value to stdout for JSON commands and exits `0`. Expected user errors write one structured JSON error to stderr and exit `2`. Validation failures print the validation result to stdout and exit `2`.
- User and agent command examples use the installed package manager binary form, `npx --no-install encephalon ...`, after the package has been installed at the repository root. Runtime execution still verifies that the executing package is the root `node_modules/encephalon` installation.
- Git marker files and package manifests used for repository or executing-package identity are read through bounded, no-follow regular-file descriptors with stable identity and fatal UTF-8 decoding. Worktree targets must be non-empty and NUL-free, and are accepted only when their real-directory identity remains stable across native realpath resolution. Repository and executing-package ascent also revalidate each child generation after capturing its parent.
- Executing package identity is cached only after its manifest and exact canonical directory generation have been verified successfully. Each repository root still reverifies its installed Encephalon manifest and directory generation on every resolution, and the installed generation must match the cached executing generation. The discovered repository generation remains verified through root-installation acceptance. Unsafe or malformed installed manifests use the generic root-install-required failure; path-generation changes use the stable repository classification while operational filesystem failures retain the stable I/O error classification.

## Canonical Storage

- Canonical knowledge is append-only JSON under `encephalon/<kind>/<id>.json`.
- Artifact files are immutable supporting files under `encephalon/_artifacts/<kind>/<id>/...` and must stay beneath the matching record artifact directory.
- The runtime-only `path` field is never written to canonical record files.
- Supersession records must use the same kind and subject as their targets. Active records are records not listed in any other record’s `supersedes`.
- Existing records are not rewritten or deleted by normal mutations; changed knowledge is represented by a new record that supersedes the active head.
- Canonical layout validation reads at most 1,003 entries from `encephalon` and 1,001 entries from any kind directory to distinguish the inclusive limits from overflow. The root permits 1,002 total entries and 1,000 kind directories; `_artifacts` and `_staging` consume root-entry capacity but not kind-directory capacity. Each kind directory permits 1,000 entries. Overflow returns one deterministic `CORPUS_DIRECTORY_ENTRY_LIMIT` issue naming only the repository-relative containing directory and its maximum.
- Canonical root and kind enumeration is bound to captured real-directory generations and revalidated before acceptance. A replacement, symlink substitution, or ancestor-generation change cannot produce a valid mixed-generation corpus.
- Record addition and initialisation carry the validated root and kind generations through graph validation, layout preflight, directory preparation, and canonical publication. They account for all candidate new kind directories and a newly introduced `_staging` root entry before any staging or canonical publication; replacements fail with `REPOSITORY_CHANGED`, while a candidate that would cross either root bound fails validation with the same deterministic directory-entry-limit issue.

## Initialisation and Privacy

- `init` creates a bounded, deterministic, non-semantic baseline from package metadata, safe filesystem enumeration, language-count extensions, and workflow filenames.
- `init` may read root `AGENTS.md` and `CLAUDE.md` byte-for-byte only to manage the Encephalon block while preserving unrelated bytes.
- Unrelated instruction text, source bodies, README content, environment files, registry configuration, Git history, Git remotes, and CI workflow contents must not enter generated records, cache search text, stdout, or structured error details.
- The managed instruction block points agents to `./node_modules/encephalon/skills/encephalon/SKILL.md` and remains exactly reversible where Encephalon created or updated it.

## Cache Compatibility

- SQLite is disposable derived state under `node_modules/.cache/encephalon`.
- The repository, cache ancestors, SQLite databases and sidecars, operation-lock metadata, recovery entries, and quarantine entries must be real contained filesystem entries verified by type, native realpath, and stable identity. Static symlinks, junction redirects, unexpected types, and replacements at validation boundaries fail closed.
- Missing cache ancestors are created individually. New primary databases use exclusive no-follow descriptor creation before SQLite opens the verified pathname, and destructive recovery removes only the exact identity moved to a verified sibling quarantine.
- Corrupt operation-gate recovery is serialised by a bounded owner marker and one total deadline. A well-formed live owner is never reclaimed because of age; oversized, non-record, otherwise malformed, dead, or ownerless markers remain reclaimable only while their observed state remains current at the destructive boundary. Recovery work, successful gate initialisation, and cleanup are conditional on the captured directory identity and random owner token. Cleanup failure prevents entry into the protected operation, and a later call may reclaim only that exact abandoned identity and token.
- Recovery-marker exclusion begins with atomic directory creation. An owner file that is briefly absent is age-reclaimed rather than published by candidate-directory rename because Node has no cross-platform no-replace directory rename, and replacement semantics could displace an empty live marker.
- Every `list`, `show`, `search`, and `gather` operation prepares the cache before reading.
- Cache rebuilds are transactional and repository-scoped. Corrupt or incompatible cache state is removed and rebuilt rather than treated as canonical data.
- SQLite result classification normalises extended numeric codes to their primary result, gives structured numeric and symbolic codes precedence over messages, and uses bounded message fallback only for generic SQLite runtime errors.
- Disposable cache recovery is limited to corrupt, not-a-database, schema, read-only, and cannot-open failures. Busy, locked, general I/O, and unknown failures are terminal for that rebuild attempt; the operation gate separately reports busy or locked contention and recovers only corrupt or not-a-database state.
- Public I/O wrapping recognises busy, locked, corrupt, not-a-database, read-only, cannot-open, and general I/O categories as environmental failures. Schema and unknown SQLite failures remain internal errors after any cache recovery is exhausted.
- Freshness is determined from explicit cache metadata and a manifest of canonical records plus referenced artifacts. The reserved `_staging` and `_artifacts` directory trees are excluded from the record-manifest portion, including their directory metadata and contents; referenced artifact files are included separately.
- Manifest entry metadata comes from one non-following filesystem inspection. Enumerated disappearance or path-generation change is retried as a repository change; symbolic links remain symbolic links and are not followed for manifest metadata, while genuine operational filesystem failures retain their I/O classification.
- Cache manifests use the same bounded, generation-stable canonical directory enumeration as validation. A bound crossed or directory generation changed after canonical validation is treated as a repository change and retried; a persistent change reports `REPOSITORY_CHANGED`, while genuine operational filesystem failures retain their I/O classification.
- Node's pathname-only SQLite API leaves a narrow replacement race inside SQLite's open after the surrounding identity checks. Defending against arbitrary same-user mutation between those boundaries is not a supported security boundary.

## Package and Release Gates

- Runtime consumers require Node.js 24.15.0 or newer and do not require Bun.
- The npm package has no runtime dependencies and no install, preinstall, postinstall, or prepare lifecycle scripts.
- The tarball whitelist is intentionally small and checked by `bun run check:package`.
- `bun run check:package` must build, pack, install the actual tarball into a temporary Git repository with scripts disabled, import the API, typecheck consumer declarations, and execute the packed CLI through Node.
- `bun run check:publish` is a dry-run release gate only. Publishing is manual maintainer work and must not be performed by agents.

## Contract Change Process

When an implementation change intentionally alters this contract:

1. Update this document in the same pull request as the code.
2. Add or update the smallest useful contract test or package check for machine-verifiable requirements.
3. Record unresolved differences in the divergence checklist below rather than editing historical documents to appear current.

## Historical Plan Divergence Checklist

| Divergence | Resolution |
| --- | --- |
| The implementation plan claimed to be the authoritative specification. | Superseded by this maintained contract; the plan is now marked historical. |
| Managed instruction files use atomic byte-preserving replacement rather than the original broad plan wording. | Implemented and tested by the instruction-file atomicity work tracked in MAR-2509, MAR-2511, and MAR-2512. |
| CLI parsing is being moved to `node:util` `parseArgs`. | Owned by MAR-2536. Until that PR lands, current behaviour remains covered by CLI tests. |
| Cache versioning and runtime package-version handling drifted from the original plan. | Owned by MAR-2524 and the cache compatibility tests. The maintained contract treats the cache as disposable derived state gated by explicit metadata. |
| The packaged skill uses `npx --no-install encephalon ...` examples instead of direct `node ./node_modules/encephalon/dist/cli.mjs` examples. | Accepted current contract. Root-install verification prevents ephemeral package execution, and package tests assert the skill guidance. |
| CI and release gates evolved after the original plan. | Owned by MAR-2527 for CI package gates. The maintained release contract remains the checked package scripts plus manual publishing. |
| Initialisation result and managed-file mutation details changed during implementation. | Implemented and tested in the init, instruction-file, package, and CLI suites; the README and this contract describe the maintained behaviour. |
| `canonicalRecordPath` was exported from `src/records.ts` without a public API surface. | Retained as an internal helper used by cache path validation; not exported from `src/index.ts`. |

## Change Provenance

- MAR-2556 bounded, generation-stable canonical layout handling and behavioural coverage: `c4e84f771ced86a669cb0cc0fcc0af19d5646461`.
