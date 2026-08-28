# Hard-linked SQLite Cache Implementation Plan

> **Linear:** MAR-2635
>
> **Branch:** `mar-2635-cache-reject-hard-linked-sqlite-cache-and-gate-files`

## Goal

Reject mutable SQLite primaries, operation-gate databases, and their `-wal`, `-shm`, and `-journal` sidecars whenever the observed inode has any other hard-link pathname. Revalidate the invariant at every existing pre-open, post-open, metadata-only, and quarantine boundary without changing public APIs, error codes, canonical formats, cache schema, or successful outputs.

## Compatibility and design constraints

- Backwards compatibility is a release invariant. Existing single-link caches and every documented public input/output remain valid without migration.
- Keep link-count policy in `src/cache-location.ts`. Do not add `nlink` to shared `EntryIdentity` or `EntryMetadata`: canonical record publication legitimately creates temporary hard links and has a different contract.
- Use BigInt `BigIntStats.nlink` directly. Never narrow it to `number`.
- A statically unsafe mutable file returns the existing bounded `VALIDATION_FAILED` cache-layout error with repository-relative `entry` and invariant `single-link-file`.
- A replacement or unstable observation retains existing `REPOSITORY_CHANGED` behaviour. Never expose inode values, link counts, or outside paths.
- Link observations are tri-state: `0n` means an opened generation is no longer named and follows generation-change or exclusive-creation-conflict handling; `1n` is accepted; only a stable named generation above `1n` reaches the hard-link policy.
- Do not repair, rename, unlink, quarantine, open with SQLite, or otherwise mutate a file after an observation proves it is multiply linked.
- Exclude cache-owned `owner.json`: it is exclusively created, filled once through its owned descriptor, then only read or unlinked rather than reopened for mutation. Cache-owned directories are likewise excluded because directory link counts are not file-alias evidence.
- No native dependencies, cache migrations, schema changes, or public exports.
- Per user direction, execute in the local clone on the exact ticket branch rather than a worktree.

### Task 1: Add focused RED coverage for static aliases

**Files:**

- Modify: `test/cache.test.ts`

**Steps:**

1. Add the platform hard-link import and a small capability probe/skip only if the test filesystem refuses user-created hard links.
2. Add a table-driven primary test covering `brain.sqlite` and `operation-lock.sqlite`. Prove a pre-existing alias returns `VALIDATION_FAILED` with `single-link-file`, does not reach the existing database-open hook, does not enter the operation callback, leaves the outside bytes unchanged, and does not disclose the outside path.
3. Add a representative table-driven sidecar test covering the mutable SQLite suffixes across primary/gate ownership. Prove the operation fails before the aliased sidecar is renamed, unlinked, or modified.
4. Run the focused tests and record RED because the current inspectors accept `nlink > 1`.

Run:

```bash
node --test --test-name-pattern='hard.?link' test/cache.test.ts
```

### Task 2: Enforce one cache-local BigInt link-count invariant

**Files:**

- Modify: `src/cache-location.ts`

**Steps:**

1. Add one cache-local validator for mutable regular-file metadata requiring `metadata.nlink === 1n` and emitting `invalidLayout(relativePath, 'single-link-file')`.
2. Apply it to both pathname/descriptor inspections in `inspectRegularFileOnce()` and both pathname observations in `inspectRegularFileMetadataOnce()`.
3. Validate a newly exclusively created primary through its descriptor before closing it.
4. Apply the same invariant to the moved and final quarantine metadata before any unlink, while preserving stable-identity error precedence for replacements.
5. Run the focused static-alias tests and the existing cache containment/recovery tests.

Run:

```bash
node --test --test-name-pattern='hard.?link|cache directory|primary database symlink|cache sidecar|operation gate|quarantine' test/cache.test.ts
```

### Task 3: Prove observed link-count changes fail closed

**Files:**

- Modify: `test/cache.test.ts`
- Modify: `src/cache-location.ts` only if an exact, test-only observation hook is required

**Steps:**

1. Add complementary tests that introduce a hard link at an existing pre-open or post-open validation seam for both cache database names and assert no operation returns success.
2. Add a quarantine-boundary test that creates an alias immediately before the final verified rename and proves neither pathname is removed.
3. Keep ordinary sidecar appearance/disappearance and single-link database behaviour unchanged.
4. Run focused tests and confirm the bounded error contains only the relative entry and stable invariant.

### Task 4: Document the containment rule and verify the release gate

**Files:**

- Modify: `README.md`
- Modify: `docs/contract.md`

**Steps:**

1. State that mutable SQLite databases and sidecars must have exactly one hard link; canonical record hard links remain governed by their separate publication contract.
2. Run formatting, generated/workflow checks, lint, all TypeScript projects, the complete test suite, benchmarks, build, package checks, publish checks, CLI validation, and `git diff --check`.
3. Review the complete branch against its MAR-2573 base for security, correctness, races/data consistency, tests, maintainability, and API/UX compatibility. Fix every high/medium-confidence issue and rerun the affected checks.

Run:

```bash
bun install --frozen-lockfile
bun run check:generated
bun run check:workflows
bun run lint
bun run typecheck
bun run test
bun run benchmark:check
bun run build
env npm_config_cache=/private/tmp/encephalon-mar2635-npm-cache bun run check:package
env npm_config_cache=/private/tmp/encephalon-mar2635-npm-cache bun run check:publish
node dist/cli.mjs validate --root .
git diff --check
```

## Implementation evidence

- RED reproduced at the original implementation boundary: both hard-linked primary/gate files and hard-linked sidecars were accepted without an exception.
- The initial reviewed snapshot was `e0f783a1ad4d0c9bbe3c2d4ac869789f2e906feb`.
- Six specialist reviews found one shared high-confidence issue: link validation preceded expected-generation comparison, changing hard-linked replacement failures from `REPOSITORY_CHANGED` to `VALIDATION_FAILED`. Test review also identified the unproven post-`BEGIN` gate boundary and incomplete outside-path disclosure assertion.
- The first correction carries bounded tri-state link evidence through descriptor and metadata-only observations, compares captured generations first, preserves replacement and exclusive-creation error precedence, and enforces `single-link-file` only for a stable named generation observed above `1n`.
- The final review correction marks both same-generation and replacement multiply-linked sidecars. Before any post-`BEGIN` SQLite close, it independently metadata-inspects every sidecar pathname so an earlier primary or sidecar error cannot mask close-time journal risk; public error precedence and bounded details remain unchanged.
- Unsafe post-`BEGIN` sidecars keep the displaced SQLite connection alive because SQLite close can unlink the current journal pathname. A cache-local four-entry, path-keyed process-lifetime latch prevents another open for the affected database and blocks all further SQLite opens at capacity before another connection is allocated. This bounds the fail-closed resource cost at the price of requiring unsafe-layout correction and process restart for recovery.
- The final close-proof correction inverts that boundary: SQLite close is allowed only after the captured cache containment and primary remain current and single linked, and the existing bounded metadata-only observer proves every sidecar is stable and single linked or absent. Redirects, containment failures, observation exceptions, changed or unlinked generations, realpath mismatches, and multiply-linked observations consume the same bounded latch while preserving the authoritative public error.
- Focused coverage includes static primaries/gates, all SQLite sidecar suffixes, pre-/post-open aliases, hard-linked primary/sidecar/bootstrap/quarantine replacements, tri-state zero-link descriptor boundaries, same-generation and replacement post-`BEGIN` journals, combined primary/journal aliases, redirected cache parents, injected close-proof inspection failure, both quarantine checks, and bounded repeated triggers.
- The focused cache suite and complete repository suite pass with only established platform skips. Lint, every TypeScript project, build, CLI validation, package validation, benchmark checks, and diff checking pass. Final release-gate and corrected-snapshot reviews are recorded in the PR evidence.
- The exact runtime, documentation, and behavioural-test snapshot that passed the fresh two-round local review cycle is `e51c16eacdb5acc08fc5a0f77c31a605ef790e38`; later provenance-only documentation does not alter runtime behaviour.
