# Encephalon Maintained Contract

Status: maintained for the current v0.x implementation.
Last reviewed: 2026-08-08 for audited snapshot `514f444fdaf428c2e41124020b40b7568af66b6b`.

This document is the concise contract maintainers should update when public behaviour or safety invariants intentionally change. The historical implementation plan remains design input and provenance context, not the normative source of truth.

## Public API and CLI

- The package exposes the synchronous API listed in `src/index.ts` and documented in the README: `initEncephalon`, `addRecord`, `prepare`, `hydrate`, `validateRecords`, `listRecords`, `showRecord`, `searchRecords`, `searchCompactRecords`, `gatherRecords`, exported input/result types, record types, and `EncephalonError`.
- Importing the package must not discover a repository, open SQLite, or mutate the filesystem.
- API failures that users can reasonably handle throw `EncephalonError` with a stable code from `src/types.ts`.
- CLI success writes one JSON value to stdout for JSON commands and exits `0`. Expected user errors write one structured JSON error to stderr and exit `2`. Validation failures print the validation result to stdout and exit `2`.
- User and agent command examples use the installed package manager binary form, `npx --no-install encephalon ...`, after the package has been installed at the repository root. Runtime execution still verifies that the executing package is the root `node_modules/encephalon` installation.

## Canonical Storage

- Canonical knowledge is append-only JSON under `encephalon/<kind>/<id>.json`.
- Artifact files are immutable supporting files under `encephalon/_artifacts/<kind>/<id>/...` and must stay beneath the matching record artifact directory.
- The runtime-only `path` field is never written to canonical record files.
- Supersession records must use the same kind and subject as their targets. Active records are records not listed in any other record’s `supersedes`.
- Existing records are not rewritten or deleted by normal mutations; changed knowledge is represented by a new record that supersedes the active head.

## Initialisation and Privacy

- `init` creates a bounded, deterministic, non-semantic baseline from package metadata, safe filesystem enumeration, language-count extensions, and workflow filenames.
- `init` may read root `AGENTS.md` and `CLAUDE.md` byte-for-byte only to manage the Encephalon block while preserving unrelated bytes.
- Unrelated instruction text, source bodies, README content, environment files, registry configuration, Git history, Git remotes, and CI workflow contents must not enter generated records, cache search text, stdout, or structured error details.
- The managed instruction block points agents to `./node_modules/encephalon/skills/encephalon/SKILL.md` and remains exactly reversible where Encephalon created or updated it.

## Cache Compatibility

- SQLite is disposable derived state under `node_modules/.cache/encephalon`.
- Every `list`, `show`, `search`, and `gather` operation prepares the cache before reading.
- Cache rebuilds are transactional and repository-scoped. Corrupt or incompatible cache state is removed and rebuilt rather than treated as canonical data.
- Freshness is determined from explicit cache metadata and a manifest of canonical records plus referenced artifacts.

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
