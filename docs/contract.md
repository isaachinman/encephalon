# Encephalon Maintained Contract

Status: maintained for the current v0.x implementation.
Last reviewed: 2026-08-12 for audited snapshot `e2c98fc6a62e18e1e91e86b5a440e03167406ee1`.

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
- Canonical root and kind enumeration is bound to captured real-directory generations and revalidated before acceptance. A replacement, symlink substitution, dangling root link, or ancestor-generation change cannot produce a valid mixed-generation corpus.
- Record addition and initialisation carry the validated root and kind generations through graph validation, layout preflight, directory preparation, canonical publication, and post-link verification. They account for every planned raw entry grouped by kind, all candidate new kind directories, and a newly introduced `_staging` root entry before any staging or canonical publication; replacements fail with `REPOSITORY_CHANGED`, while a candidate that would cross a directory bound fails validation with the same deterministic directory-entry-limit issue. Post-link generation loss is reported as a committed `REPOSITORY_CHANGED` result and stops batch initialisation.
- Before canonical publication, record addition and initialisation stream at most 1,001 direct `_staging` entries and clean at most 1,000. The all-or-nothing preflight accepts only regular files, hard-link aliases, and symlinks whose names exactly match Encephalon's `record-<pid>-<UUID>.tmp` format, plus recovery quarantines in the exact `.<owned-name>.<UUID>.quarantine` format. A recovery quarantine retains its base writer name, so cleanup never nests quarantine names. Cleanup performs no recursive scan or removal and never follows symlinks. It atomically moves each accepted entry to a random sibling quarantine, binds regular entries to no-follow descriptors, verifies the quarantined identity immediately before unlink, and flushes the verified staging directory before canonical publication even when no stale entries were found, where directory flushing is supported.
- Cleanup performs one bounded initial enumeration and, after all planned removals, a final probe that reads at most one entry. It does not rescan the remaining set after every unlink. Regular hard-link aliases share an expected filesystem incarnation that advances from the held descriptor or, when its change time is delayed, the next fully verified surviving alias after the controlled unlink. Overflow, malformed or unrecognised names, unsupported types, late entries, and detected generation or entry replacements preserve the affected entries and fail with repository-relative inspect-and-retry guidance; errors never disclose arbitrary entry names. Partial stale-file cleanup may remain visible after a concurrent change, and a later retry safely reclassifies the remaining bounded set.
- Publication keeps the unique current-operation staging descriptor open through bounded staging inspection, canonical linking, staging cleanup, directory flushes, publication-authority acceptance, and final verification. The canonical pathname and verified empty staging generation are each checked immediately before authority acceptance and again after the acceptance hook; every emptiness check is a bounded probe that reads at most one entry. A late staging child or lost pathname generation after linking is reported as a structured committed repository change rather than success; genuine operational I/O failures retain the committed I/O classification. Post-publication cleanup is restricted to the exact current owned name and captured identity and never broad-cleans late arrivals.
- Node does not provide a portable descriptor-relative conditional unlink or a no-replace rename. Cleanup therefore uses a random canonical-v4 quarantine name and immediately adjacent parent-witness and entry-identity checks before pathname unlink, but arbitrary same-user replacement in that final syscall window and a forced random-name collision are not supported security boundaries. Any detected identity uncertainty leaves the quarantine for inspection rather than restoring or deleting it.

## Initialisation and Privacy

- `init` creates a bounded, deterministic, non-semantic baseline from package metadata, safe filesystem enumeration, language-count extensions, and workflow filenames.
- Every baseline directory source reads at most 513 raw entries before filtering and is bound to a stable real-directory generation. Recursive traversal schedules at most 10,000 directories, binds each child capture to its enumerated parent, and accepts all baseline source passes only while the repository-root generation remains stable. The package pass always opens the literal root `package.json`; exact casing wins when case-distinct aliases coexist, while an enumerated alias supplies attribution only when that literal open succeeds on a case-insensitive filesystem. Validated top-level presence distinguishes a package or `.github` source that disappears before its preliminary metadata check from ordinary absence. Overflow, unreadable directories, workflow enumeration failures, and invalid, oversized, unreadable, or replaced package metadata omit the affected facts and set `scanTruncated` with bounded, ordinal-sorted reason codes in the repository overview.
- The complete baseline reason vocabulary is `directory-entry-limit`, `directory-limit`, `max-depth`, `package-metadata-error`, `regular-file-limit`, `top-level-entry-limit`, `unreadable-directory`, `workflow-entry-limit`, and `workflow-enumeration-error`.
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
- Artifact syntax remains a schema concern. Filesystem inspection captures the real `encephalon` root once per batch, binds each real non-link ancestor to its verified parent generation, and opens each final path read-only, nonblocking, without acquiring a controlling terminal, and with no-follow semantics wherever the runtime provides those flags. Initial `lstat`, descriptor `fstat`, final descriptor `fstat`, final path `lstat`, and ancestor revalidation must agree on complete stable metadata before an immutable path-and-metadata observation is accepted.
- Record validation performs that artifact inspection once and hands the verified observations directly to cache-manifest construction; cache rebuild does not restat detached artifact paths. Freshness enumerates the bounded record manifest before re-inspecting the cached artifact path set through the same primitive, so an artifact mutation during record enumeration cannot be accepted as fresh. A statically missing, linked, or non-regular artifact is an invalid record artifact; replacement or mutation during inspection is a repository change subject to the bounded rebuild retry policy; genuine operational filesystem failures retain their I/O classification. Public messages, details, validation issues, and CLI output do not expose absolute artifact paths; retained internal diagnostic causes are outside that guarantee.
- Manifest entry metadata comes from one stable filesystem inspection within captured real-parent generations. Root and kind witnesses surround enumerated record-entry inspection. Enumerated disappearance, link substitution, or parent-generation change is retried as a repository change, while genuine operational filesystem failures retain their I/O classification.
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

- MAR-2556 bounded, generation-stable canonical layout handling and behavioural coverage: `de05ccf06119a2ad2507accf18163be8243eafec`.
- MAR-2569 bounded, ownership-aware staging recovery and final publication-identity coverage: `a862d8ca229b07463ac45a4b442b29b7f92eb6a8`.
