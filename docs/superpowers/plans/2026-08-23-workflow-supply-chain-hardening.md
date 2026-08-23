# Workflow Supply-Chain Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every Encephalon `uses` target identify reviewed immutable action code, remove provider-secret fan-out, and put Pullfrog's required hosted-OIDC authority behind an explicit environment boundary while proving or recording any authority that v0.1.60 cannot narrow from repository configuration.

**Architecture:** A dependency-free structural policy parses workflow and local action YAML with `Bun.YAML`, follows repository-contained local references cycle-safely, and returns deterministic rule findings. The existing CI and Pullfrog workflows then use exact reviewed SHAs, minimal YAML permissions, no provider-secret fan-out, a protected Pullfrog environment, disabled credential persistence/push, and the SHA-pinned local Pullfrog core path; Dependabot proposes reviewed SHA updates without merging them automatically. Upstream authority that cannot be narrowed in v0.1.60 remains an explicit acceptance blocker rather than being hidden by workflow prose.

**Tech Stack:** TypeScript 7, Bun 1.3.1 YAML parser and test runner, GitHub Actions YAML, Dependabot.

**Spec:** `docs/superpowers/specs/2026-08-23-release-backlog-hardening-design.md`

## Global Constraints

- Preserve all documented valid public inputs, public TypeScript signatures, synchronous behaviour, result shapes, ordering, CLI framing, existing subsystem error codes, canonical data, and repository formats.
- Add no runtime dependency. Use exact `@types/bun@1.3.1` only as a development dependency for the scripts TypeScript project; remove the historical handwritten Bun runtime declarations.
- The workflow policy must parse YAML structurally; source regexes are not an acceptable substitute.
- External `uses` references must have an owner/repository[/path] shape and end in one lowercase 40-character commit SHA; a trailing comment records the human-readable release.
- Repository-local reusable workflows and composite actions must be resolved through `lstat` and native real paths beneath the repository root, reject symlinks/non-regular/ambiguous targets, and be scanned recursively with cycle detection.
- Credential-bearing jobs include workflow- or job-level secret-context expressions across dotted, bracket, and whitespace forms, `secrets: inherit`, or `id-token: write`; each requires the exact `pullfrog-review` environment.
- Every workflow must declare exactly the top-level permission map `{ contents: read }`; job permissions remain read-only except for the single protected Pullfrog OIDC exception.
- Only `.github/workflows/pullfrog.yml` job `pullfrog`, attached to `pullfrog-review`, may request `id-token: write`; repository permissions otherwise remain read-only.
- Pullfrog uses hosted OIDC. Remove provider-secret mappings, retain only its narrowly scoped OIDC permission, set `push: disabled`, force the pinned local CLI path, and preserve manual inputs and run naming.
- Do not claim complete Pullfrog execution immutability: v0.1.60 installs exact-version agent runtimes whose production dependency resolution is outside the action lock.
- Do not claim `push: disabled` removes every write token: v0.1.60 still hardcodes an internal contents-write MCP installation token. Repository acceptance remains blocked until an upstream release scopes MCP contents to `read` while retaining Pullfrog review identity.
- Use the local repository clone and branch switching only; do not create a worktree.
- Commit titles use `[MAR-2574] Plain English title` with British English prose.
- Do not merge this or any other batch pull request until all 13 release-hardening tickets are ready.

---

### Task 1: Structural workflow policy

**Files:**

- Create: `scripts/workflow-policy.ts`
- Create: `scripts/workflow-policy.test.ts`
- Modify: `package.json`
- Modify: `bun.lock`
- Modify: `tsconfig.scripts.json`
- Delete: `scripts/bun-runtime.d.ts`

**Interfaces:**

- Produces:

```ts
export type WorkflowPolicyRule =
  | 'credential-environment'
  | 'external-action-sha'
  | 'local-reference'
  | 'permission'

export type WorkflowPolicyFinding = Readonly<{
  file: string
  location: string
  rule: WorkflowPolicyRule
}>

export const inspectWorkflowPolicy = (root: string): readonly WorkflowPolicyFinding[]
export const formatWorkflowPolicyFindings = (findings: readonly WorkflowPolicyFinding[]): string
```

- `inspectWorkflowPolicy` starts from sorted `.github/workflows/*.yml` and `*.yaml` files, parses each with `Bun.YAML.parse`, and follows each local `uses: ./...` reference to either the named YAML file or `action.yml`/`action.yaml` in the named directory.
- Returned `file` values are slash-separated repository-relative paths. `location` values use deterministic object/array paths such as `jobs.verify.steps[0].uses`.
- The CLI path prints the formatted findings to stderr and exits non-zero when findings exist; it prints nothing and exits zero when the repository passes.

- [x] **Step 1: Write failing behavioural tests**

Create temporary fixture repositories and test the real parser and traversal. Before writing each body, name the production mutation it catches:

1. Removing recursive local-reference traversal would allow a local composite action to hide `owner/action@v1`.
2. Removing credential detection would allow `${{ secrets.TOKEN }}`, `secrets: inherit`, or `id-token: write` without an environment.
3. Broadening permissions would allow `contents: write` or OIDC outside the protected Pullfrog job.
4. Removing containment or cycle handling would allow `./../outside/action` or a self-referencing local action to escape or loop.
5. Removing deterministic sorting would make diagnostics depend on directory or object insertion order.

Use hand-written YAML fixtures. Assert literal findings rather than computing expected values with the production formatter. A valid fixture must include a pinned external reference such as:

```yaml
name: Fixture
on: workflow_dispatch
permissions:
  contents: read
jobs:
  verify:
    runs-on: ubuntu-latest
    steps:
      - uses: ./.github/actions/checked
```

and a local composite action whose external step is pinned to:

```yaml
runs:
  using: composite
  steps:
    - uses: owner/action@0123456789abcdef0123456789abcdef01234567
```

- [x] **Step 2: Run the focused test and verify RED**

Run:

```bash
bun test scripts/workflow-policy.test.ts
```

Expected: FAIL because `scripts/workflow-policy.ts` does not exist. Confirm the failure is the missing policy module, not malformed fixture YAML.

- [x] **Step 3: Implement the minimum structural inspector**

Implement a pure traversal with these rules:

```ts
const fullCommitReference = /^[^\s@]+@[0-9a-f]{40}$/u
const localReference = /^\.\//u
```

- Guard YAML parsing and emit a `local-reference` finding for invalid root/local YAML rather than throwing raw parser diagnostics.
- Traverse arrays and plain parsed objects without evaluating template expressions.
- Track parsed absolute paths in a `Set<string>` before following local references.
- Resolve local references against the repository root, reject any resolved path outside it, and load only `.yml`, `.yaml`, `action.yml`, or `action.yaml` targets.
- Scan every string-valued `uses` field. Local references recurse; all other action/reusable-workflow references require the full commit pattern.
- Treat every job as credential-bearing when workflow-level `env` or its own subtree contains a secret-context expression with optional expression/accessor whitespace and dotted or bracket access; when its `secrets` property is `inherit`; or when effective job permissions contain `id-token: write`.
- Require the exact string environment `pullfrog-review` or an object whose exact non-empty `name` is `pullfrog-review` for every credential-bearing job.
- Require the top-level permission map to be exactly `{ contents: read }`. Require job permissions to remain read-only and reject every other `write` permission except `id-token: write` for `.github/workflows/pullfrog.yml`, job `pullfrog`, environment `pullfrog-review`.
- Sort findings by `file`, `location`, then `rule` with ordinal string ordering.
- Keep CLI execution behind `if (import.meta.main)` so tests import without exiting.

Avoid early negative returns, mutation outside contained traversal state, and `.then()`/`.catch()` control flow.

- [x] **Step 4: Run focused tests and verify GREEN**

Run:

```bash
bun test scripts/workflow-policy.test.ts
bun run typecheck
bun run lint
```

Expected: all fixture tests pass, all four TypeScript projects pass, and lint reports no fixes.

- [x] **Step 5: Commit the policy and its tests**

Run:

```bash
git add scripts/workflow-policy.ts scripts/workflow-policy.test.ts
git commit -m "[MAR-2574] Add structural workflow policy"
```

Before committing, rerun `bun run test`, `bun run typecheck`, and `bun run lint` as required by repository policy.

---

### Task 2: Pin and minimise repository workflows

**Files:**

- Modify: `.github/workflows/ci.yml`
- Modify: `.github/workflows/pullfrog.yml`
- Create: `.github/dependabot.yml`
- Modify: `package.json`
- Modify: `scripts/workflow-policy.test.ts`

**Interfaces:**

- Consumes: `inspectWorkflowPolicy(root)` from Task 1.
- Produces: package script `check:workflows` with command `bun run scripts/workflow-policy.ts`.
- Produces: a repository integration test that requires `inspectWorkflowPolicy(root)` to return `[]` for the checked-in workflows.

- [x] **Step 1: Add the checked-in repository RED**

Add one integration test and exact checked-in workflow-shape assertions:

```ts
test('repository workflows obey immutable action and credential boundaries', () => {
  assert.deepEqual(inspectWorkflowPolicy(root), [])
})
```

The production mutation it catches is any checked-in mutable action, hidden local wrapper, unprotected credential authority, or write permission.

Parse the checked-in workflows with `Bun.YAML.parse`. Require exactly one Pullfrog action step and one Pullfrog checkout; require exact read-only/OIDC job permissions, exact protected environment, exact action-step environment, and literal `push: disabled`. Require every checkout in both workflows to set `persist-credentials: false`. These assertions catch duplicate unsafe steps and provider-secret reintroduction that the general permission policy cannot observe.

- [x] **Step 2: Run the focused test and verify RED**

Run:

```bash
bun test --test-name-pattern='repository workflows' scripts/workflow-policy.test.ts
```

Expected: FAIL with findings for the mutable CI/Pullfrog tags, Pullfrog's unprotected credential mappings, and Pullfrog OIDC without an environment.

- [x] **Step 3: Pin every current external action**

Replace tags with these reviewed immutable references and retain the version in comments:

```yaml
actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
actions/setup-node@820762786026740c76f36085b0efc47a31fe5020 # v7.0.0
oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6 # v2.2.0
actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02 # v4.6.2
```

For Pullfrog use:

```yaml
actions/checkout@d23441a48e516b6c34aea4fa41551a30e30af803 # v6.1.0
pullfrog/pullfrog@c4d0ca6f15d12382ddd20d2010bc596b405f42f0 # v0.1.60
```

Do not upgrade action majors or change CI triggers, runners, Node versions, Bun version, step ordering, job names, package artefact layout, or retention.

- [x] **Step 4: Minimise Pullfrog authority**

Keep workflow-level `contents: read`. Keep job-level `contents: read` and the documented hosted-router requirement `id-token: write`. Add:

```yaml
environment: pullfrog-review
```

Add `persist-credentials: false` to every checkout step. Delete the entire provider `env` mapping, including commented BYOK templates; the repository has no provider secrets and successful current runs use hosted OIDC. Preserve `prompt`, `name`, `run-name`, manual dispatch, and `fetch-depth: 1`.

Set the Pullfrog step's entire environment to:

```yaml
env:
  PULLFROG_FORCE_LOCAL_CLI: '1'
```

This prevents the SHA-pinned action from bootstrapping mutable `pullfrog@^0.1.60`; it does not bind the later agent-runtime dependency installations to the action lock.

Set Pullfrog's action input explicitly:

```yaml
push: disabled
```

The review job must not push repository content or workflows. Record that v0.1.60 nevertheless mints a separate internal MCP token with contents-write authority; no workflow-only configuration can remove it without breaking the read-only acceptance criteria or Pullfrog review identity.

- [x] **Step 5: Add reviewed action updates and the CI gate**

Create `.github/dependabot.yml`:

```yaml
version: 2
updates:
  - package-ecosystem: github-actions
    directory: /
    schedule:
      interval: weekly
```

Add `"check:workflows": "bun test scripts/workflow-policy.test.ts && bun run scripts/workflow-policy.ts"` to `package.json`. In each CI job, run `bun run check:workflows` immediately after frozen installation and before TypeScript/build work. Do not add a new job or status-check name.

- [x] **Step 6: Run focused tests and policy GREEN**

Run:

```bash
bun test scripts/workflow-policy.test.ts
bun run check:workflows
bun run typecheck
bun run lint
```

Expected: fixture and checked-in workflow tests pass, the policy CLI exits zero with no output, all TypeScript projects pass, and lint reports no fixes.

- [x] **Step 7: Commit the workflow changes**

Run:

```bash
git add .github/workflows/ci.yml .github/workflows/pullfrog.yml .github/dependabot.yml package.json scripts/workflow-policy.test.ts
git commit -m "[MAR-2574] Pin workflow actions and minimise credentials"
```

Before committing, rerun `bun run test`, `bun run typecheck`, and `bun run lint`.

---

### Task 3: Document and verify the workflow trust boundary

**Files:**

- Modify: `README.md`
- Modify: `docs/contract.md`
- Modify: `docs/superpowers/specs/2026-08-23-release-backlog-hardening-design.md`
- Modify: `docs/superpowers/plans/2026-08-23-workflow-supply-chain-hardening.md`

**Interfaces:**

- Consumes: the exact Task 2 code/test commit SHA.
- Produces: maintained documentation for immutable action pins, structural policy, hosted Pullfrog OIDC, environment approval, Dependabot review, credential rotation, and emergency disablement.

- [x] **Step 1: Update maintained documentation**

In `README.md`, add `bun run check:workflows` to Development and explain that CI/Pullfrog action references are immutable, workflow policy follows local wrappers, and Pullfrog uses a branch-restricted protected environment with hosted OIDC rather than repository provider secrets. Document that `push: disabled` prevents git pushes and that the local CLI switch prevents the mutable Pullfrog-core bootstrap.

In `docs/contract.md`, add a `## Workflow Trust Boundary` section specifying:

- exact-SHA external actions with reviewed version comments;
- recursive structural validation of local reusable workflows/composite actions;
- read-only repository permissions;
- the sole `pullfrog-review` OIDC exception;
- exact environment branch policies for `main` and the ticket branch currently being reviewed;
- no provider-secret fan-out;
- explicit `push: disabled` plus forced local CLI execution;
- the v0.1.60 residuals: internal MCP contents-write authority and agent-runtime production dependencies outside the action lock;
- the upstream least-authority release required before MAR-2574 can satisfy acceptance;
- weekly reviewed Dependabot updates;
- credential rotation by revoking hosted/OIDC trust and emergency disablement by disabling the Pullfrog workflow;
- the exact Task 2 code/test commit SHA as implementation provenance.

In the approved design, append the same exact implementation provenance under Stack A. In this plan, mark completed checkboxes and add an Implementation Evidence section with focused/full gate results and that same SHA. Do not edit historical completed plans or claim that GitHub settings are applied before the external rollout succeeds.

- [x] **Step 2: Run the complete local release matrix**

Run:

```bash
bun install --frozen-lockfile
bun run check:workflows
bun run lint
bun run typecheck
bun run test
bun run benchmark:check
bun run build
bun run check:package
bun run check:publish
git diff --check origin/main...HEAD
node dist/cli.mjs validate --root /Users/isaac/Code/open-source/encephalon
```

Expected: every command exits zero; the full suite has zero failures with only the established capability skips; the already-published 0.2.0 refusal remains the accepted publish-contract result; Encephalon reports zero validation errors.

- [x] **Step 3: Audit scope and generated state**

Verify:

```bash
git status --short --branch
git diff --stat origin/main...HEAD
git diff -- package.json bun.lock src/generated/version.ts
git diff -- .github docs README.md scripts test
```

Expected: the only dependency change is exact development-only `@types/bun@1.3.1` plus its lockfile entry; there is no runtime dependency or generated-version change. The branch otherwise contains only the approved programme spec, MAR-2574 plan, policy/tests, workflow/Dependabot/package-script configuration, and maintained documentation.

- [x] **Step 4: Commit documentation**

Run:

```bash
git add README.md docs/contract.md docs/superpowers/specs/2026-08-23-release-backlog-hardening-design.md docs/superpowers/plans/2026-08-23-workflow-supply-chain-hardening.md
git commit -m "[MAR-2574] Document workflow trust boundaries"
```

Before committing, rerun `bun run test`, `bun run typecheck`, and `bun run lint`.

---

## Implementation Evidence

- Task 1's structural policy and behavioural tests were committed at `16266f47db0c802d818d85db139472616aa930e7`. Task 2's core repository-controlled workflow, policy, configuration, and behavioural-test snapshot remains `a2bb85a7b28aefedbcb13b4c61d16bbce3f76c57`; that full SHA is the reviewed implementation provenance consumed by Task 3. Branch-review remediation and its behavioural tests were committed at `31ba01944a1e4afccf867c7f7607859c437f3e0e`. Cross-platform remediation at `a242d3f614775d24694ca7122c40efbbc6ec1a1a` made path comparison Windows-safe, used junction-aware fixtures, and normalised equivalent parser trigger keys; it is the final reviewed repository-controlled code and test state documented by this plan.
- Fresh Task 3 workflow policy validation passed all 13 tests with zero failures, and the recursive policy CLI returned no findings. At the branch-review remediation head, workflow policy validation passed all 17 tests and the combined workflow/package run passed all 24 tests with zero failures. At the final cross-platform remediation head, workflow policy validation passed all 18 tests and the combined workflow/package run passed all 25 tests with zero failures. Lint checked 117 files with no fixes, all four TypeScript projects passed, and the full suite reported 563 tests: 561 passed, zero failed, and two established capability skips.
- Frozen installation checked 39 installs across 66 packages with no changes. CI benchmark budgets, build, package validation, and the publish contract all exited zero. The publish contract accepted npm's expected refusal to overwrite already-published version `0.2.0`; no publication occurred.
- `git diff --check origin/main...HEAD` returned no findings. Encephalon validation checked 38 records with zero errors. The origin/main scope audit found no `src/generated/version.ts` change or runtime dependency change; exact `@types/bun@1.3.1` is the sole direct dependency addition, is development-only, and contributes only its declaration lockfile closure. Bun types and `skipLibCheck` remain scripts-project-only, the handwritten Bun declaration is removed, and the Node consumer/runtime boundary is unchanged.
- The local repository work does not complete the external rollout. The live `pullfrog-review` environment is absent, repository `sha_pinning_required` remains false, and no push, pull request, workflow dispatch, Linear mutation, or GitHub settings change was performed. v0.1.60's internal MCP token still has `contents: write` despite `push: disabled`, and its later exact-version agent-runtime production dependencies still resolve outside the action lock; both remain upstream MAR-2574 acceptance blockers.

---

## External rollout and pull-request gate

After all implementation tasks and task reviews are clean:

1. Push with explicit refspec `origin mar-2574-ci-pin-secret-bearing-actions-and-minimize-workflow:mar-2574-ci-pin-secret-bearing-actions-and-minimize-workflow`, then set and verify upstream `origin/mar-2574-ci-pin-secret-bearing-actions-and-minimize-workflow`.
2. Open the MAR-2574 pull request against `main` with the repository template and British English prose; attach it to Linear and move the issue to In Review.
3. Create the `pullfrog-review` GitHub environment with required reviewer user ID `10575782` and `prevent_self_review: false`. Use custom deployment branch policies for exact `main` and exact `mar-2574-ci-pin-secret-bearing-actions-and-minimize-workflow`; never leave the environment unrestricted. As the batch advances, add the exact ticket branch under review and remove obsolete ticket policies.
4. Keep repository `sha_pinning_required` disabled while default `main` still contains tag references. Enable and verify it only immediately after MAR-2574 is the first batch pull request merged, then verify an approved Pullfrog dispatch from pinned `main` before proceeding with the remaining merge sequence.
5. Dispatch Pullfrog on the exact branch head, approve the pending environment deployment, and verify the pinned local core succeeds with hosted OIDC. This integration run does not clear the upstream MCP-token acceptance blocker.
6. Wait for the complete GitHub CI matrix.
7. Run six parallel branch-against-main reviews: security, correctness, data consistency/races, test coverage, maintainability, and UX/API regression where relevant.
8. Fix every high- or medium-confidence finding, rerun affected local gates, push only the explicit ticket refspec, and repeat exact-head CI/Pullfrog/review gates.
9. Leave the pull request unmerged until every release-hardening ticket is ready.
