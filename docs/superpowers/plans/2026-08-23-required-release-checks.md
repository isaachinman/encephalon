# Required Release Checks Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the current-Node and release-equivalent package contracts successful, stable, required pull-request checks while rejecting stale committed generated-version source before any build can repair it.

**Architecture:** Add one dependency-free pure renderer/checker for `src/generated/version.ts`; the build, a new non-mutating check command, and package validation consume that authority. Run the existing release-equivalent job on both supported workflow events, gate every workflow build with the non-mutating check, and condition only artifact upload on a trusted `main` push. Document the exact branch-protection context set and defer the settings mutation until MAR-2574 has merged and the retargeted MAR-2640 pull request has emitted every successful context.

**Tech Stack:** TypeScript 7, Bun 1.3.1, Node.js 24.15+/26, Node test runner, GitHub Actions YAML, GitHub branch-protection API.

**Spec:** `docs/superpowers/specs/2026-08-23-release-backlog-hardening-design.md`

## Global Constraints

- Preserve all documented valid public inputs, public TypeScript signatures, synchronous behaviour, result shapes, ordering, and CLI framing.
- Preserve existing subsystem error codes, messages, causes, and safe detail fields; this ticket changes development and CI failure reporting only.
- Preserve canonical JSON, manifests, instruction-file formats, repository layout, existing repositories, records, clients, and valid cache generations without migration or data loss.
- Keep the npm runtime dependency set empty and keep Bun types limited to the scripts TypeScript project.
- Keep workflow permissions at exact top-level `contents: read`; expose no repository, provider, or npm secrets to pull requests.
- Keep the three Node 24.15 OS lanes and the single Ubuntu Node 26 lane; do not duplicate the cross-platform matrix on Node 26.
- Keep the stable check names `verify (ubuntu-latest)`, `verify (macos-latest)`, `verify (windows-latest)`, `verify (ubuntu-current)`, and `Release-equivalent package gate`.
- Keep release-equivalent tarball upload limited to trusted pushes to exact `main`; pull requests may build and inspect only runner-local artifacts.
- Use the local clone and branch switching only; do not create a worktree.
- Commit titles use `[MAR-2640] Plain English title` with British English prose.
- Do not merge this or any other release-hardening pull request until all 13 tickets are implemented, verified, and reviewed.

---

### Task 1: Establish one generated-version source authority

**Files:**
- Create: `scripts/package-version.ts`
- Create: `scripts/check-generated-version.ts`
- Create: `test/package-version.test.ts`
- Modify: `scripts/build.ts`
- Modify: `scripts/check-package.ts`
- Modify: `package.json`

**Interfaces:**
- Produces: `renderPackageVersionSource(version: string): string` and `assertPackageVersionSource(version: string, source: string): void` from `scripts/package-version.ts`.
- Consumed by: `scripts/build.ts`, `scripts/check-generated-version.ts`, and `scripts/check-package.ts`.
- Produces: package script `check:generated` with command `bun run scripts/check-generated-version.ts`.

- [x] **Step 1: Write focused failing unit tests for the pure authority**

Create `test/package-version.test.ts`:

```ts
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { assertPackageVersionSource, renderPackageVersionSource } from '../scripts/package-version.ts'

test('renders the complete generated package-version source deterministically', () => {
  assert.equal(
    renderPackageVersionSource('1.2.3-beta.1'),
    '// Generated from package.json by scripts/build.ts.\nexport const PACKAGE_VERSION = "1.2.3-beta.1"\n',
  )
})

test('rejects generated package-version source that is not an exact match', () => {
  assert.doesNotThrow(() =>
    assertPackageVersionSource('0.2.0', renderPackageVersionSource('0.2.0')),
  )
  assert.throws(
    () => assertPackageVersionSource('0.2.0', renderPackageVersionSource('0.2.1')),
    new Error('Generated runtime package version is stale. Run `bun run build` and commit src/generated/version.ts.'),
  )
})
```

- [x] **Step 2: Run the focused test and prove the missing authority fails**

Run: `node --test test/package-version.test.ts`

Expected: FAIL because `scripts/package-version.ts` does not exist.

- [x] **Step 3: Implement the pure renderer and exact checker**

Create `scripts/package-version.ts`:

```ts
const staleGeneratedVersionMessage =
  'Generated runtime package version is stale. Run `bun run build` and commit src/generated/version.ts.'

export const createStaleGeneratedVersionError = (): Error => new Error(staleGeneratedVersionMessage)

export const renderPackageVersionSource = (version: string): string =>
  `// Generated from package.json by scripts/build.ts.\nexport const PACKAGE_VERSION = ${JSON.stringify(version)}\n`

export const assertPackageVersionSource = (version: string, source: string): void => {
  const expectedSource = renderPackageVersionSource(version)
  const expectedWindowsSource = expectedSource.replaceAll('\n', '\r\n')
  if (source !== expectedSource && source !== expectedWindowsSource) {
    throw createStaleGeneratedVersionError()
  }
}
```

The checker accepts only the complete native LF rendering or its complete checkout-equivalent CRLF rendering. Mixed line endings, wrappers, extra content, lone carriage returns, stale versions, and every other byte-level content change remain rejected.

Create `scripts/check-generated-version.ts` as the non-mutating adapter:

```ts
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { assertPackageVersionSource } from './package-version.ts'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const packageJson = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as { version?: unknown }
if (typeof packageJson.version !== 'string') {
  throw new Error('package.json must declare a string version.')
}
const generatedVersionSource = readFileSync(resolve(root, 'src', 'generated', 'version.ts'), 'utf8')
assertPackageVersionSource(packageJson.version, generatedVersionSource)
```

Update `scripts/build.ts` to import `renderPackageVersionSource` and write exactly that result instead of owning the template:

```ts
import { renderPackageVersionSource } from './package-version.ts'

writeFileSync(resolve(generatedDirectory, 'version.ts'), renderPackageVersionSource(packageJson.version), 'utf8')
```

Update `scripts/check-package.ts` to import `assertPackageVersionSource` and replace the substring test with:

```ts
const generatedVersionSource = readFileSync(resolve(root, 'src', 'generated', 'version.ts'), 'utf8')
assertPackageVersionSource(packageJson.version, generatedVersionSource)
```

Keep `src/generated/version.ts` byte-for-byte unchanged: `build.ts` still performs generation, so its existing source comment remains accurate. Add the exact package script:

```json
"check:generated": "bun run scripts/check-generated-version.ts"
```

- [x] **Step 4: Run focused and integration checks**

Run:

```bash
node --test test/package-version.test.ts
bun run check:generated
bun run build
bun run check:generated
bun run check:package
```

Expected: all exit zero; the normal build leaves `src/generated/version.ts` byte-for-byte equal to the intended renderer output and creates no additional generated drift.

- [x] **Step 5: Commit the generated-version authority**

```bash
git add package.json scripts/package-version.ts scripts/check-generated-version.ts scripts/build.ts scripts/check-package.ts test/package-version.test.ts
git commit -m "[MAR-2640] Check generated package version before builds"
```

---

### Task 2: Run the release-equivalent contract on pull requests

**Files:**
- Modify: `.github/workflows/ci.yml`
- Modify: `test/package.test.ts`

**Interfaces:**
- Consumes: package script `check:generated` from Task 1.
- Preserves: the existing five stable check-context names and exact immutable action pins established by MAR-2574.
- Produces: one release-equivalent job that succeeds for pull requests and trusted `main` pushes, with upload limited to the latter.

- [x] **Step 1: Update the workflow contract test first**

In `test/package.test.ts`, change the release-job assertions so they require:

```yaml
  release:
    name: Release-equivalent package gate
    needs: verify
    runs-on: ubuntu-latest
```

Require both verification and release jobs to execute `bun run check:generated` before their first `bun run build` (including the build nested inside `bun run test`). Require the release job to retain one `npm pack` and one `bun run check:publish`. Require the upload step to include:

```yaml
        if: github.event_name == 'push' && github.ref == 'refs/heads/main'
```

Keep the exact action-pin checks in `scripts/workflow-policy.test.ts`; do not duplicate them here.

- [x] **Step 2: Run the focused package contract and prove the old workflow fails**

Run: `node --test --test-name-pattern "runs pull-request and current-Node package checks" test/package.test.ts`

Expected: FAIL because the release job is still main-push-only and neither job runs the non-mutating generated-version check.

- [x] **Step 3: Make the minimal workflow change**

In `.github/workflows/ci.yml`:

- remove the release job's main-push-only `if`; the workflow itself already triggers only pull requests targeting `main` and pushes to `main`;
- insert a `Check committed package version` step running `bun run check:generated` before `bun run typecheck` in `verify`, which places it before `bun run test` performs its build;
- insert the same named non-mutating step before `bun run build` in `release`;
- add the exact main-push condition only to `Upload release-equivalent package artifact`;
- retain top-level `contents: read`, checkout credential disabling, current action pins/comments, the four-lane matrix, job names, cancellation, package construction, and publish dry-run.

- [x] **Step 4: Run workflow and package-policy checks**

Run:

```bash
node --test --test-name-pattern "runs pull-request and current-Node package checks" test/package.test.ts
bun run check:workflows
bun run test
```

Expected: all exit zero; workflow-policy output is empty.

- [x] **Step 5: Commit the pull-request gate**

```bash
git add .github/workflows/ci.yml test/package.test.ts
git commit -m "[MAR-2640] Run release checks before merge"
```

---

### Task 3: Maintain the release contract and prepare safe settings rollout

**Files:**
- Modify: `README.md`
- Modify: `docs/contract.md`
- Modify: `test/package.test.ts`
- Modify: `docs/superpowers/plans/2026-08-23-required-release-checks.md`

**Interfaces:**
- Documents: the exact five required status-check names emitted by Task 2.
- Documents: read-only inspection with `gh api repos/isaachinman/encephalon/branches/main/protection` and the guarded post-MAR-2574 settings mutation.
- Preserves: `enforce_admins: false`, `allow_force_pushes: true`, and every unrelated main-branch protection field.

- [x] **Step 1: Add failing maintained-document assertions**

Extend the existing package contract test to require `README.md` and `docs/contract.md` to state that:

- release-equivalent checks run on pull requests and trusted `main` pushes;
- artifact upload occurs only on trusted `main` pushes;
- stale generated source is checked non-mutatively before builds;
- branch protection requires the three Node 24.15 OS checks, `verify (ubuntu-current)`, and `Release-equivalent package gate` after rollout.

- [x] **Step 2: Run the focused test and prove the current documentation fails**

Run: `node --test --test-name-pattern "runs pull-request and current-Node package checks" test/package.test.ts`

Expected: FAIL because the README still describes the release-equivalent job as main-push-only and the maintained contract omits the new required contexts.

- [x] **Step 3: Update README and maintained contract**

Add `bun run check:generated` before build commands in the README development sequence. Explain that both workflow jobs reject stale generated source before a build, the release-equivalent job runs without secrets on pull requests and trusted `main` pushes, and only trusted `main` pushes upload its bounded tarball.

In `docs/contract.md`, specify the exact five contexts and the safe rollout order:

1. keep MAR-2640 stacked on MAR-2574 and defer the protection mutation while PR #66 can emit only a skipped release context, because that skipped success does not prove the release-equivalent contract;
2. after MAR-2574 merges, rebase MAR-2640 onto current `origin/main`, retarget it to `main`, and wait for all five successful contexts at the exact head;
3. query `gh api repos/isaachinman/encephalon/branches/main/protection` and update only `required_status_checks` to strict mode with the five exact GitHub Actions contexts;
4. query protection again and verify the exact set while preserving administrator-bypass, force-push, deletion, signature, history, and conversation-resolution settings;
5. verify an intentionally failing current-Node or release-equivalent check blocks ordinary merge before removing any obsolete context.

- [x] **Step 4: Run all local release gates and hygiene checks**

Run:

```bash
bun install --frozen-lockfile
bun run check:generated
bun run lint
bun run typecheck
bun run test
bun run benchmark:check
bun run build
bun run check:package
bun run check:publish
bun run check:workflows
node dist/cli.mjs validate --root .
git diff --check
git status --short --branch
```

Expected: every command exits zero, except `check:publish` may exit zero after recognising the expected refusal to overwrite published `0.2.0`; the worktree contains no generated drift, package artifact, or unrelated change.

- [x] **Step 5: Commit maintained documentation and implementation evidence**

After appending an `Implementation Evidence` section to this plan with exact commits and verification results:

```bash
git add README.md docs/contract.md test/package.test.ts docs/superpowers/plans/2026-08-23-required-release-checks.md
git commit -m "[MAR-2640] Document required release checks"
```

---

## External Rollout Gate

Do not update main branch protection from the stacked draft state. PR #66 currently emits `Release-equivalent package gate` as skipped. A job skipped by a job-level `if` reports success and does not block a required check, but that skipped result does not prove the release-equivalent contract and requiring it would give false assurance. The settings mutation becomes safe only after MAR-2574 merges and the rebased/retargeted MAR-2640 pull request emits all five genuinely executed successful contexts. At that point, update only `required_status_checks`, preserve all unrelated protection fields, re-query the API, and use temporary non-main pull-request commits to prove that a current-Node-only failure and a release-equivalent-only failure each block ordinary merge. Revert those temporary commits on the ticket branch, rerun the exact-head matrix, and never merge the deliberately failing revisions.

## Implementation Evidence

- Generated-version authority: `c3fbbbb32c06e104b3a348566afb927e68963e3e` (`[MAR-2640] Check generated package version before builds`).
- Pull-request release gate: `1f3d217411c161ba4e2aefd172d948ecd9961084` (`[MAR-2640] Run release checks before merge`).
- Maintained contract and rollout documentation: `899fc7181904b4edfd6e76a20ded3dec0b47bd54` and `bbae03d8bcd6fd6cf6de6567acd3f6884c455044`.
- Regression hardening: `b8b3476725c80d67788fe3aef3d26b2783d9a9c3` and `d6b0075618da3d90314d0624014f8a896f2c4143`. The final semantic snapshot recognises every top-level workflow step marker, pins both generated-source adapters to the exact checker, accepts checkout-equivalent CRLF, and rejects wrappers or other content drift.
- The exact MAR-2640 code and behavioural-test snapshot is `d6b0075618da3d90314d0624014f8a896f2c4143`. It is rebased on the final repository-controlled MAR-2574 snapshot `54e5ee87464475b2b37af1af537146a0f006b330`.
- The README and maintained contract require the pre-build non-mutating generated-source check, release execution on pull requests and trusted `main` pushes, trusted-`main`-only bounded artifact upload, and the exact five required contexts. They record the guarded post-MAR-2574 rollout, the read-only inspection command, the narrow `required_status_checks` mutation, preservation of `enforce_admins: false`, `allow_force_pushes: true`, and every unrelated setting, without claiming external rollout completion.

### Red-green evidence

- RED: `node --test --test-name-pattern "runs pull-request and current-Node package checks" test/package.test.ts` exited 1 with 0 passing and 1 failing test. It failed on the new README assertion because the old text said only trusted `main` pushes ran the release-equivalent gate.
- GREEN: the same focused command exited 0 with 1 passing and 0 failing tests after the maintained documents were updated.
- RED: the top-level workflow-marker regression returned `[]` for representative `if`, `shell`, and `id` steps while the new test expected all three markers. GREEN: the widened exact-indentation parser returned all markers and the complete package contract passed.
- RED: the CRLF-equivalent generated source raised the stale-source error. GREEN: normalising only CRLF to LF accepted the platform-equivalent source while focused tests still rejected stale versions, wrappers, and misleading embedded versions.

### Local release gates

Run on 2026-08-24 in the required order at semantic snapshot `d6b0075618da3d90314d0624014f8a896f2c4143`:

| Command | Result |
| --- | --- |
| `bun install --frozen-lockfile` | Exit 0; checked 39 installs across 66 packages with no changes. |
| `bun run check:generated` | Exit 0; no stale generated source. |
| `bun run lint` | Exit 0; checked 120 files with no fixes. |
| `bun run typecheck` | Exit 0 across the source, scripts, test, and runtime-guard TypeScript projects. |
| `bun run test` | Exit 0; 567 tests, 565 passed, 2 skipped, 0 failed. |
| `bun run benchmark:check` | Exit 0 for the schema-version 2 CI profile; all timing, memory, and cache-size budgets passed. |
| `bun run build` | Exit 0 with no generated drift. |
| `bun run check:package` | The first invocation stopped before validation because the host's default npm cache contains root-owned entries. Re-running with an isolated temporary npm cache exited 0; the repository and user cache were unchanged. |
| `bun run check:publish` | With the same isolated temporary npm cache, exited 0 after recognising the expected refusal: `You cannot publish over the previously published versions: 0.2.0.` |
| `bun run check:workflows` | Exit 0; 63 passed, 1 platform skip, 0 failed, and the repository policy check was silent. |
| `node dist/cli.mjs validate --root .` | Exit 0; `{"errors":[],"recordsChecked":38,"truncated":false,"valid":true}`. |
| `git diff --check` | Exit 0 with no output. |
| `git status --short --branch` | Exit 0 with a clean semantic worktree. No generated file or package artifact drift was present. |

Read-only `gh api repos/isaachinman/encephalon/branches/main/protection` inspection on 2026-08-24 exited 0 and confirmed that rollout has not occurred: strict protection currently requires only the three Node 24.15 OS contexts, while `enforce_admins.enabled` remains false and `allow_force_pushes.enabled` remains true. No GitHub settings were mutated.

The semantic diff contains no runtime API, CLI, stored-data, cache-schema, published-dependency, secret, or unrelated-file change. The documentation uses British English, gives the exact five context names, keeps artifact upload main-only, and defers protection mutation until MAR-2574 has merged and the retargeted MAR-2640 exact head has emitted all five successful contexts.
