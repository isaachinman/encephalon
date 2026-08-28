# Encephalon 0.3.0 Release Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore the published 0.2.0 public contract, prove upgrade and downgrade compatibility, and publish one exact reviewed Encephalon 0.3.0 tarball.

**Architecture:** Keep operation budgets, package validation, publish validation, and cross-version compatibility as separate single-purpose authorities. Build one candidate tarball, pass its repository-relative path through package, compatibility, runtime, and publish-dry-run gates, and reject any digest drift before manual publication.

**Tech Stack:** TypeScript 7, Node.js 24.15.0 and 26, Bun 1.3.1, Node test runner, npm tarballs, GitHub Actions.

**Spec:** `encephalon/_artifacts/context/8afddab6-4b74-4f16-8144-0b409ef880c7/specs/2026-08-26-encephalon-0.3.0-release-design.md`

## Global Constraints

- Published `encephalon@0.2.0` is the compatibility oracle; verify integrity `sha512-dgGi7fL43v9KQJ7Rb42fRAT+Z+h6WIOKhbPz9JzNBtnpqSyf4HyN6zBmIy6ftkTazZO6SyGU4MUi1FTVJyBvEw==` and shasum `1db80715ac2028cb8f12ae029577aed3428d52ef` before execution.
- Public list, full-search, compact-search, and gather result-count limits accept integers 1 through 1,000 and default to 20.
- Values 50, 100, 101, 999, and 1,000 succeed with bounded fixture data; 1,001 fails with the established result-limit budget error.
- Full, compact, and gather response budgets remain 4 MiB. Query limits remain 1,024 UTF-8 bytes and 32 terms. Gather limits remain 16 searches and 64 shows. Supersession and canonical corpus limits remain 1,000.
- Preserve every published public export, valid input, stable error code, CLI command, success shape, canonical JSON byte, artifact byte, and managed instruction byte.
- Cache schemas are disposable: 0.2 schema 1 must upgrade safely to candidate schema 2; candidate schema 2 must downgrade safely to oracle schema 1 without durable mutation.
- The package remains dependency-free at runtime and installable with lifecycle scripts disabled.
- `scripts/check-generated-version.ts` remains the single direct pre-install generated-version authority in CI.
- One exact tarball must flow through package, compatibility, Node 24.15.0, Node 26, publish-dry-run, review, main verification, and final manual publication.
- MAR-2574 stays Backlog; PR #66 stays closed and its branch is never reused.
- Use British English in Git, GitHub, plans, and release prose while preserving established American code/API identifiers.
- Do not use a worktree. Work only on `mar-2679-release-prepare-and-verify-encephalon-030`, created without an upstream from `origin/main` at `1ef7541b89db455d21138326f88893e89506c150`.

---

### Task 1: Restore the published result-count contract

**Files:**
- Modify: `test/api-input.test.ts`
- Modify: `test/cli.test.ts`
- Modify: `test/cache.test.ts`
- Modify: `test/package.test.ts`
- Modify: `scripts/check-package.ts`
- Modify: `src/operation-budgets.ts`
- Modify: `README.md`
- Modify: `docs/contract.md`

**Interfaces:**
- Consumes: existing `OPERATION_BUDGETS`, API input parsers, cache defence-in-depth validation, CLI parsing/help, and packed CLI smoke helpers.
- Produces: unchanged budget keys `fullResultLimit` and `compactResultLimit`, each with `{ default: 20, field: 'limit', maximum: 1000, minimum: 1 }`.

- [x] **Step 1: Replace the focused API expectations with the published boundary matrix**

Use literal cases in `test/api-input.test.ts` for `parseListRecordsInput`, `parseFullSearchRecordsInput`, `parseCompactSearchRecordsInput`, and `parseGatherInput`:

```ts
const compatibleLimits = [50, 100, 101, 999, 1000] as const
for (const limit of compatibleLimits) {
  assert.equal(parse(limit).limit, limit)
}
assertEncephalonError(() => parse(1001), 'INVALID_ARGUMENT', {
  budget,
  field: 'limit',
  maximum: 1000,
})
```

Keep existing minimum, integer, accessor, sparse-input, gather-array, and allocation-order cases.

- [x] **Step 2: Run the API test and verify RED**

Run: `node --test --test-name-pattern='operation-specific result limits' test/api-input.test.ts`

Expected: FAIL because 101 or 999 is rejected with maximum 50/100.

- [x] **Step 3: Add matching CLI, public cache, and packed-package RED cases**

In `test/cli.test.ts`, run list, full search, compact search, and gather with 50/100/101/999/1,000 against a bounded repository and assert exit 0. Run 1,001 and assert exit 2, empty stdout, `INVALID_ARGUMENT`, and literal `{ field: 'limit', budget, maximum: 1000 }`.

In `test/cache.test.ts`, replace the 51/101 rejection table with acceptance through 1,000 and rejection at 1,001 while retaining all response-byte tests unchanged.

In `scripts/check-package.ts`, change packed help fragments to `<1..1000>` and exercise 1,000 success plus 1,001 failure for each mode. Update `test/package.test.ts` only where it asserts those observable packed behaviours.

- [x] **Step 4: Run the focused CLI/cache/package tests and verify RED**

Run: `node --test --test-name-pattern='operation-specific result limits|rejects oversized operation inputs|packed' test/cli.test.ts test/cache.test.ts test/package.test.ts`

Expected: FAIL on the current 50/100 authorities; gather-array and response-byte tests remain green.

- [x] **Step 5: Restore both result-count maxima with the smallest implementation**

Change only the two result authorities:

```ts
compactResultLimit: Object.freeze({ default: 20, field: 'limit', maximum: 1000, minimum: 1 }),
fullResultLimit: Object.freeze({ default: 20, field: 'limit', maximum: 1000, minimum: 1 }),
```

Do not change `compactResponseBytes`, `fullResponseBytes`, `gatherResponseBytes`, `gatherSearches`, `gatherShows`, `queryBytes`, `queryTerms`, `supersessionEdges`, or canonical budgets.

- [x] **Step 6: Update maintained public documentation**

State in `README.md` and `docs/contract.md` that every applicable result limit accepts 1–1,000 and defaults to 20, independently of response-byte and request-array budgets. Do not rewrite the historical 2026-08-13 design record.

- [x] **Step 7: Verify GREEN and commit**

Run:

```bash
node --test test/api-input.test.ts test/cli.test.ts test/cache.test.ts test/package.test.ts
bun run typecheck
bun run lint
git diff --check
```

Commit: `[MAR-2679] Restore published result limits`

---

### Task 2: Make package and publish checks accept one exact tarball

**Files:**
- Create: `scripts/package-tarball.ts`
- Create: `scripts/package-tarball.test.ts`
- Modify: `scripts/check-package.ts`
- Modify: `scripts/check-publish.ts`
- Modify: `test/package.test.ts`
- Modify: `package.json`
- Modify: `docs/contract.md`

**Interfaces:**
- Consumes: current reviewed-manifest, installed API/declaration, packed CLI, retained-copy, npm command, and publish-conflict authorities.
- Produces: `parsePackageCheckArguments(args: readonly string[])`, `readPackageTarEntries(path: string)`, and `packageTarballDigests(path: string)` in `scripts/package-tarball.ts`; `check-package.ts --tarball <repository-relative-path>`; `check-publish.ts <repository-relative-tarball>`.

- [x] **Step 1: Write parser, containment, tar-entry, and digest RED tests**

In `scripts/package-tarball.test.ts`, cover:

- no arguments and `--retain-tarball package-artifacts`;
- `--tarball package-artifacts/encephalon-0.3.0.tgz`;
- mutual exclusion, missing values, absolute paths, `..`, symlink ancestors, non-regular files, and multiple hard links;
- tar entries exposing normalised `package/...` path, mode, and size;
- SHA-256, SHA-512, npm integrity, SHA-1, and byte size derived from literal fixture bytes.

The expected digests are hard-coded values calculated outside the production helper.

- [x] **Step 2: Run the helper tests and verify RED**

Run: `node --test scripts/package-tarball.test.ts`

Expected: FAIL because `scripts/package-tarball.ts` does not exist.

- [x] **Step 3: Implement the dependency-free tarball authority**

Use only Node standard library. Return immutable values with these shapes:

```ts
type PackageCheckArguments = Readonly<{
  retainedDirectory?: string
  suppliedTarball?: string
}>

type PackageTarEntry = Readonly<{
  mode: number
  path: string
  size: number
}>

type PackageTarballDigests = Readonly<{
  bytes: number
  integrity: string
  sha1: string
  sha256: string
  sha512: string
}>
```

Keep descriptor/path validation bounded to the one named file and its repository-relative ancestors. Parse the existing gzip/tar format once; replace `packedMode()` with the shared entry reader.

- [x] **Step 4: Write process-level RED tests for supplied package and publish paths**

Extend `test/package.test.ts` to prove:

- the retained tarball passes a second `check-package.ts --tarball <same-path>` invocation;
- a byte-modified or wrong-version tarball fails before retention;
- supplied mode does not invoke `npm pack`;
- `check-publish.ts <tarball>` sends the tarball path to `npm publish --dry-run --ignore-scripts --access public --json`;
- no argument, source directory, extra argument, traversal, symlink, or missing tarball is rejected;
- an already-published-version response is accepted only by the existing conflict authority.

- [x] **Step 5: Run process-level tests and verify RED**

Run: `node --test test/package.test.ts`

Expected: FAIL because neither script accepts a supplied tarball.

- [x] **Step 6: Refactor `check-package.ts` around one validated tarball path**

Preserve all current source, manifest, API, declaration, CLI, lifecycle, and retained-copy checks. The only branch is tarball acquisition:

```ts
const tarball = options.suppliedTarball ?? createNpmTarball(temporaryDirectory)
const entries = readPackageTarEntries(tarball)
validateReviewedManifest(entries)
validateInstalledPackage(tarball)
```

Supplied mode must not call `npm pack`. Retained mode must copy only after every check passes. Print the retained path exactly as today; additionally print digest JSON to stderr or a named metadata file without contaminating the stdout path contract.

- [x] **Step 7: Make the publish checker tarball-only**

Require exactly one validated repository-relative `.tgz` path and pass it as the first publish target:

```ts
const npmArguments = ['publish', tarball, '--dry-run', '--ignore-scripts', '--access', 'public', '--json']
```

Never use `root` as the publish target. Preserve signal handling and published-version-conflict classification.

- [x] **Step 8: Update scripts, contract, verify GREEN, and commit**

Keep `check:package` as contributor tarball creation/validation. Change `check:publish` documentation to require a tarball argument; CI supplies it. Run:

```bash
node --test scripts/package-tarball.test.ts test/package.test.ts test/npm-command.test.ts test/npm-publish-conflict.test.ts
bun run typecheck
bun run lint
git diff --check
```

Commit: `[MAR-2679] Validate one exact package tarball`

---

### Task 3: Add the published-oracle upgrade and downgrade fixture

**Files:**
- Create: `scripts/release-compatibility.ts`
- Create: `scripts/check-release-compatibility.ts`
- Create: `scripts/release-compatibility.test.ts`
- Modify: `package.json`
- Modify: `docs/contract.md`

**Interfaces:**
- Consumes: supplied candidate tarball validation/digests from Task 2, npm command resolution, the pinned 0.2.0 oracle, public API/CLI, canonical storage, managed instructions, and cache schemas.
- Produces: `check-release-compatibility.ts <repository-relative-candidate.tgz>` and a deterministic JSON success report containing oracle/candidate digests plus upgrade/downgrade results.

- [x] **Step 1: Write pure oracle, snapshot, and subprocess RED tests**

In `scripts/release-compatibility.test.ts`, first name the production breaks:

- wrong oracle bytes must fail before install or execution;
- package replacement must start a fresh Node process;
- durable snapshot comparison must detect added, removed, mode-changed, or byte-changed canonical/artifact/managed files while ignoring only `node_modules/.cache/encephalon/**`;
- command failure must preserve bounded stdout/stderr diagnostics without exposing canonical or instruction contents;
- the 50/100/101/999/1,000/1,001 table must run for list, full search, compact search, and gather in both package phases.

Use local literal tarball and repository fixtures for unit tests; do not contact npm from the ordinary Node test suite.

- [x] **Step 2: Run unit tests and verify RED**

Run: `node --test scripts/release-compatibility.test.ts`

Expected: FAIL because the release compatibility module does not exist.

- [x] **Step 3: Implement the compatibility orchestration authority**

Use Node standard library and `spawnNpmCommand`. Pin these exact oracle values in one immutable object:

```ts
const ORACLE = Object.freeze({
  integrity: 'sha512-dgGi7fL43v9KQJ7Rb42fRAT+Z+h6WIOKhbPz9JzNBtnpqSyf4HyN6zBmIy6ftkTazZO6SyGU4MUi1FTVJyBvEw==',
  shasum: '1db80715ac2028cb8f12ae029577aed3428d52ef',
  specifier: 'encephalon@0.2.0',
})
```

Download with `npm pack --ignore-scripts --json --pack-destination <private-temp>`, verify both hashes, and then install the exact downloaded path with `--ignore-scripts --no-audit --no-fund`. Candidate installation uses the supplied exact path.

Create one temporary Git repository. Under oracle 0.2.0, write controlled predecessor instruction bytes, initialise, add records with supersession and one artifact, prepare schema 1, and capture durable bytes. Run all later API/CLI probes as child Node processes using the currently installed root package.

After candidate installation, run declarations, every API export, every CLI command, the result-limit table, validation, reads, and preparation. Assert schema 2 and unchanged durable bytes. After oracle reinstall, run representative reads/validation/preparation, assert schema 1, and compare the same durable snapshot.

- [x] **Step 4: Add a process-level integration test using a local oracle stand-in**

Build two small local package tarballs with the published public surface and cache transition witnesses. Prove the complete orchestrator sequence uses the supplied tarball bytes, swaps packages, starts fresh processes, checks limits, and reports both transitions. Keep the real npm oracle run in the release check, not the default unit suite.

- [x] **Step 5: Run GREEN, add the script, and commit**

Add `check:compatibility` as `node ./scripts/check-release-compatibility.ts`. Run:

```bash
node --test scripts/release-compatibility.test.ts
bun run typecheck
bun run lint
git diff --check
```

Then build a candidate tarball and run the real oracle check once locally with an isolated npm cache.

Commit: `[MAR-2679] Prove package upgrade and downgrade compatibility`

---

### Task 4: Pass the exact candidate through CI runtime and publish gates

**Files:**
- Modify: `test/ci-workflow.test.ts`
- Modify: `.github/workflows/ci.yml`
- Modify: `README.md`
- Modify: `docs/contract.md`

**Interfaces:**
- Consumes: exact package and compatibility CLIs from Tasks 2–3 plus the existing four source-verification lanes.
- Produces: one uploaded `encephalon-npm-package` candidate artifact, candidate runtime lanes for Node 24.15.0 and Node 26, and a tarball-only release-equivalent publish dry run.

- [x] **Step 1: Rewrite the workflow contract test first**

Require this dependency graph:

```text
verify (Ubuntu/macOS/Windows Node 24.15.0 + Ubuntu Node 26)
  -> package (build once, check once, retain and upload exact tarball)
    -> candidate (download same artifact; Node 24.15.0 and Node 26)
      -> release (download same artifact; package recheck + compatibility + publish dry run)
```

Assert that:

- generated-version validation still precedes Bun setup/install in every source-building job;
- no PR job has npm credentials or `secrets.*` references;
- package creation occurs exactly once;
- later jobs use `--tarball` and the downloaded path;
- publish dry run receives that tarball path;
- both PR and trusted-main runs retain the auditable candidate artifact;
- no job publishes to npm;
- all jobs keep `contents: read` and checkout credential persistence disabled;
- clean-tree checks surround build/package work.

- [x] **Step 2: Run the workflow test and verify RED**

Run: `node --test test/ci-workflow.test.ts`

Expected: FAIL because current CI dry-runs source before it creates a tarball and does not expose candidate runtime lanes.

- [x] **Step 3: Implement the smallest workflow graph**

Keep the existing `verify` matrix. Add a package job that retains the tarball under `package-artifacts`, records its digest, and uploads exactly that `.tgz`. Candidate jobs download the artifact to the same repository-relative directory and run `check-package.ts --tarball` plus packed/API/CLI compatibility on Node 24.15.0 and Node 26. The final release-equivalent job downloads the same artifact, reruns the supplied-tarball package check, runs the real oracle compatibility check once, and invokes `check-publish.ts <tarball>`.

Use GitHub outputs only for a validated relative filename. Never interpolate untrusted package metadata into a shell command. Prefer fixed `package-artifacts/encephalon-0.3.0.tgz` once Task 5 sets the version.

- [x] **Step 4: Update maintained release documentation**

Describe the job graph, oracle network requirement, exact-artifact digest, PR artifact retention, trusted-main byte comparison, and manual tarball-only publish handoff. Remove the claim that PR tarballs remain runner-local.

- [x] **Step 5: Verify GREEN and commit**

Run:

```bash
node --test test/ci-workflow.test.ts test/package.test.ts scripts/release-compatibility.test.ts
bun run typecheck
bun run lint
git diff --check
```

Commit: `[MAR-2679] Gate CI on the exact release candidate`

---

### Task 5: Set version 0.3.0 and freeze release history

**Files:**
- Modify: `test/package.test.ts`
- Modify: `package.json`
- Modify: `src/generated/version.ts` through `scripts/build.ts`
- Modify: `CHANGELOG.md`
- Modify: `README.md`
- Modify: `docs/contract.md`

**Interfaces:**
- Consumes: package-version generator/checker, published git head `54050ff63d07cd2ad051ea4375e31d07b4dd337c`, and completed MAR-2679 implementation.
- Produces: one coherent 0.3.0 version surface and an immutable historical 0.2.0 changelog section.

- [x] **Step 1: Add release metadata RED tests**

In `test/package.test.ts`, assert:

- manifest, generated source, built API/CLI, and packed API/CLI report 0.3.0;
- the complete 0.2.0 changelog section equals the literal release-time section from git head `54050ff63d07cd2ad051ea4375e31d07b4dd337c`;
- a dated 0.3.0 section exists above 0.2.0 and includes compatibility, result-limit, exact-artifact, cache upgrade/downgrade, and material post-0.2 work;
- 0.2.0 text contains none of the post-publication additions currently misplaced there.

- [x] **Step 2: Run package tests and verify RED**

Run: `node --test test/package.test.ts`

Expected: FAIL because version surfaces remain 0.2.0 and the changelog has no 0.3.0 section.

- [x] **Step 3: Bump and regenerate through the existing authority**

Set `package.json` to 0.3.0, then run `bun run build`. Do not hand-edit generated version text beyond accepting the generator output. Run `node ./scripts/check-generated-version.ts` immediately afterwards.

- [x] **Step 4: Restore and extend the changelog**

Copy the complete 0.2.0 section byte-for-byte from `git show 54050ff63d07cd2ad051ea4375e31d07b4dd337c:CHANGELOG.md`. Add a 0.3.0 section dated on the release-preparation day. Move and consolidate every material post-publication change under Added/Changed/Fixed/Documentation without duplicating 0.2.0 claims.

- [x] **Step 5: Update versioned user documentation**

Change references that describe the current release as 0.2.0 where they mean the candidate version. Preserve historical references and the 0.2.0 oracle discussion.

- [x] **Step 6: Verify GREEN and commit**

Run:

```bash
node ./scripts/check-generated-version.ts
node --test test/package.test.ts
bun run typecheck
bun run lint
bun run build
git diff --check
```

The build may update tracked generated source before this task is committed. Commit the intended metadata and generated source changes, then run `bun run build` once more and require `git diff --exit-code HEAD` so the committed generated version is reproducible.

Commit: `[MAR-2679] Prepare Encephalon 0.3.0 metadata`

---

### Task 6: Complete release verification, durable workflow knowledge, and review

**Files:**
- Modify: `docs/contract.md` only if verification exposes maintained-contract drift
- Create: one Encephalon `workflow` record for the exact-artifact release procedure if no active record already covers the subject

**Interfaces:**
- Consumes: all prior task commits and their focused test evidence.
- Produces: a ticket-pure, reviewed, exact-head-ready MAR-2679 branch and one exact local candidate tarball/digest.

- [x] **Step 1: Search active Encephalon knowledge before recording**

Run:

```bash
node dist/cli.mjs search --compact "npm release exact tarball compatibility upgrade downgrade"
```

If an active workflow head exists for the same subject, supersede it. Otherwise add one concise `workflow` record with subject `release.npm-exact-artifact`, source `agent`, the oracle identity, required gates, and manual tarball-only publish rule. Do not record transient CI URLs or credentials.

- [x] **Step 2: Run the complete local verification matrix**

Run in this order:

```bash
node ./scripts/check-generated-version.ts
bun install --frozen-lockfile --ignore-scripts
bun run typecheck
bun run test
bun run lint
bun run benchmark:check
bun run build
git diff --exit-code HEAD
# `package-artifacts` must be absent; move any previous disposable directory to a private backup first.
node ./scripts/check-package.ts --retain-tarball package-artifacts
node ./scripts/check-package-metadata.ts
node ./scripts/check-package.ts --tarball package-artifacts/encephalon-0.3.0.tgz
node ./scripts/check-release-compatibility.ts package-artifacts/encephalon-0.3.0.tgz
node ./scripts/check-publish.ts package-artifacts/encephalon-0.3.0.tgz
node --max-old-space-size=8192 dist/cli.mjs validate
git diff --check origin/main...HEAD
git status --short
```

Use an isolated npm cache under `/private/tmp` if the user npm cache is not writable. The expected publish dry run must not upload.

- [x] **Step 3: Commit final maintained evidence**

Commit any required contract or Encephalon record change as `[MAR-2679] Record exact release verification`.

- [x] **Step 4: Run two complete Luna local review rounds**

For each round, dispatch parallel Luna reviewers for security, correctness/bugs, data consistency/races, test coverage, maintainability, and UX/API regression. Review the branch against `origin/main`. Fix every valid high- or medium-confidence finding and rerun affected tests. Round 2 must review the amended exact head. Do not start a third local round.

- [ ] **Step 5: Prepare the non-draft PR but do not publish**

Verify branch/upstream and push only with:

```bash
git push --set-upstream origin mar-2679-release-prepare-and-verify-encephalon-030:mar-2679-release-prepare-and-verify-encephalon-030
```

Open a ticket-pure PR to `main`, obtain exact-head CI and Pullfrog, address valid findings, update to latest `main`, and rerun both gates if the SHA changes. Publication is outside the PR and remains a manual maintainer action after merge, green main, and reviewed/main artifact byte identity.

- [ ] **Step 6: Stop at the publication approval boundary**

After squash merge and green main, download the trusted `encephalon-npm-package` artifact, compare its digest byte-for-byte with the exact reviewed candidate, and report the exact path, version, size, digests, CI run, and npm command. Do not run `npm publish` without the user's final explicit approval.
