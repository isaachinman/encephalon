# Encephalon 0.3.0 Release Design

## Status

Approved in MAR-2679 on 2026-08-26. This design is release-blocking: Encephalon 0.3.0 must not publish unless every compatibility and exact-artifact gate below passes.

## Goal

Publish one reviewed Encephalon 0.3.0 npm tarball that preserves the published 0.2.0 public API, CLI, valid result-count range, canonical storage, referenced artifacts, and managed instruction files. Disposable SQLite caches may rebuild safely in either version direction.

## Binding compatibility oracle

The oracle is the package actually published to npm, not repository source that still declares version 0.2.0:

- package: `encephalon@0.2.0`
- tarball: `https://registry.npmjs.org/encephalon/-/encephalon-0.2.0.tgz`
- npm integrity: `sha512-dgGi7fL43v9KQJ7Rb42fRAT+Z+h6WIOKhbPz9JzNBtnpqSyf4HyN6zBmIy6ftkTazZO6SyGU4MUi1FTVJyBvEw==`
- npm shasum: `1db80715ac2028cb8f12ae029577aed3428d52ef`
- npm `gitHead`: `54050ff63d07cd2ad051ea4375e31d07b4dd337c`
- published: `2026-08-09T08:55:06.094Z`

The compatibility check downloads the exact version, verifies SHA-512 and SHA-1 before executing it, and installs with lifecycle scripts disabled. A registry failure or byte mismatch blocks the release; it is never converted into a skip.

## Public result-count contract

Erratum (2026-08-27): the documented and intended 0.2.0 contract accepts `limit` values from 1 through 1,000 for list, full search, compact search, and gather searches, with a default of 20. Direct execution of the immutable dual-hash published 0.2.0 oracle instead observes runtime maxima of 50 for list/full search and 100 for compact search/gather. The earlier design text incorrectly described that published runtime as already accepting the documented range.

Encephalon 0.3.0 restores both maintained result-limit authorities to the intended 1–1,000 contract. This is a strict widening of the observed immutable runtime, so no input accepted by published 0.2.0 is rejected:

```ts
{ default: 20, field: 'limit', maximum: 1000, minimum: 1 }
```

The two internal names remain `fullResultLimit` and `compactResultLimit` because their response accounting remains distinct. Compatibility does not merge those authorities or export them.

The following protections remain independent and unchanged:

- full, compact, and gather response budgets: 4 MiB each;
- query maximum: 1,024 UTF-8 bytes and 32 literal terms;
- gather arrays: at most 16 searches and 64 shows;
- supersession targets: at most 1,000;
- canonical corpus: at most 1,000 records and the existing byte ceilings;
- payload, allocation, filesystem, locking, snapshot, and retry bounds.

`limit: 1000` is a valid request. A response may still fail under its response-byte budget when the actual result material exceeds that separate ceiling. Tests use small records to prove result-count acceptance without weakening byte accounting.

Both API and CLI checks cover 50, 100, 101, 999, 1,000, and 1,001 for every applicable operation. Values through 1,000 succeed; 1,001 receives the established bounded `INVALID_ARGUMENT` result-limit failure.

## Compatibility fixture

One release-only integration authority owns the cross-version fixture. It uses isolated temporary Git repositories and a fresh Node process after every package replacement so module caches and root-installation identity cannot hide a transition.

### Upgrade sequence

1. Verify and install the published oracle with scripts disabled.
2. Create controlled `AGENTS.md` and `CLAUDE.md` predecessor bytes.
3. Run 0.2.0 `init`, add representative canonical records with supersession and a referenced artifact, and prepare its schema-1 cache.
4. Capture the complete durable file set, modes, and bytes for `encephalon/**`, `AGENTS.md`, and `CLAUDE.md`.
5. Replace the root package with the one exact 0.3.0 candidate tarball, again with scripts disabled.
6. Exercise every public API export and CLI command, declarations, validation, reads, searches, gather, and explicit preparation.
7. Prove all pre-existing durable bytes remain identical. Only disposable cache files may change.
8. Prove the schema-1 cache produces canonical results and explicit preparation safely rebuilds it as schema 2.

### Downgrade sequence

1. Leave candidate schema-2 disposable cache state in the same repository.
2. Reinstall the verified 0.2.0 oracle in a fresh process.
3. Run representative validation, list, show, search, gather, and prepare operations.
4. Prove published 0.2.0 safely rebuilds the disposable cache as schema 1.
5. Prove every durable file and byte remains identical to the pre-upgrade snapshot.

The supported downgrade statement is therefore precise: canonical records, artifacts, and managed files remain compatible; schema-2 cache bytes are not forward-compatible storage and are rebuilt as disposable schema 1 by 0.2.0.

## API and CLI compatibility

`src/index.ts`, `src/types.ts`, and `docs/contract.md` remain the maintained candidate contract. The published oracle additionally proves what 0.2.0 consumers received.

The fixture must prove:

- every published public export remains available;
- consumer declarations compile against both packages;
- imports have no repository or SQLite side effects;
- successful API values remain compatible;
- stable `EncephalonError` codes remain compatible;
- CLI help, commands, stdout/stderr JSON framing, and exit codes remain compatible;
- `--version` is the only expected literal version change;
- root-installation checks run against the package actually installed at the repository root.

No fixture expectation may be computed with candidate implementation helpers. Expected values are literals or snapshots derived from the verified oracle.

## Exact candidate artifact

One deterministic tarball is created once for each exact source tree. It receives a repository-relative path plus recorded size, SHA-256, SHA-512, npm integrity, package version, and source commit.

Exact retention is one absent-directory transaction. `package-artifacts` must not exist before generation; a previous disposable directory must be moved aside before rerunning the gate. The complete tarball and sidecar are staged in one random private sibling under the stable reviewed repository root, installed by one directory rename, and revalidated as a pair. Callers never replace or merge a prior artifact directory.

The existing package checker remains the single authority for manifest, generated-version, API import, declaration, packed CLI, and install-with-scripts-disabled validation. It gains a supplied-tarball mode rather than duplicating that logic elsewhere.

The publish checker accepts exactly one candidate tarball and runs `npm publish --dry-run` against that file. It must not publish or dry-run the repository directory, and the tarball path must not invoke `prepack` or rebuild.

CI passes the same candidate bytes through:

1. package creation and package validation;
2. cross-version compatibility;
3. packed API and CLI tests on Node 24.15.0 and Node 26;
4. npm publish dry run;
5. artifact retention and digest reporting.

Source verification continues on Node 24.15.0 for Ubuntu, macOS, and Windows plus Node 26 on Ubuntu. Pull requests upload the non-secret candidate artifact so the reviewed bytes and digest are auditable. After exact-head CI and Pullfrog pass and the PR is squash-merged, trusted `main` builds again. Its tarball must be byte-identical to the reviewed candidate. Any mismatch blocks publication.

Final publication is a manual maintainer action against the exact verified `.tgz` path. It never targets `.` and never rebuilds. Registry verification then checks version, integrity, exports, declarations, API import, CLI version, and representative commands on Node 24.15.0 and Node 26.

## Version and changelog

`package.json` becomes 0.3.0. `scripts/build.ts` remains the only generator for `src/generated/version.ts`, and the direct generated-version checker remains the pre-install CI authority.

The complete 0.2.0 section in `CHANGELOG.md` is restored exactly from npm's source git head `54050ff63d07cd2ad051ea4375e31d07b4dd337c`. Post-publication changes move into a dated 0.3.0 section. Historical 0.2.0 text is never rewritten to describe work its published tarball did not contain.

## GitHub and Linear state

- Work begins on `mar-2679-release-prepare-and-verify-encephalon-030` from current `main`.
- MAR-2574 stays Backlog.
- PR #66 stays closed unmerged and its historical branch is never reused.
- MAR-2679 remains In Progress until a ticket-pure non-draft PR is ready.
- Exact-head CI and Pullfrog must both pass; any head change invalidates both gates.
- The PR merges only after all valid findings are fixed.
- Green `main`, candidate byte identity, manual publication, and registry verification precede MAR-2679 Done.

## Failure handling

Every gate fails closed on oracle mismatch, registry unavailability, result-limit regression, durable-byte mutation, cache recovery failure, dirty build output, tarball drift, source/tarball version disagreement, CI failure, review failure, or an existing npm 0.3.0 version.

Before publication, rollback means closing the PR or discarding the candidate. After npm publication, 0.3.0 is immutable: deprecate it if necessary and prepare a separately reviewed patch release. Never overwrite, rebuild, or republish the version.

## Open questions

None.
