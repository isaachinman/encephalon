# Workflow Supply-Chain Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every Encephalon external executable reference identify reviewed immutable action code, remove provider-secret fan-out, and put Pullfrog's required hosted-OIDC authority behind an explicit environment boundary while proving or recording any authority that v0.1.60 cannot narrow from repository configuration.

**Architecture:** A structural policy parses workflow and local action YAML with exact development-only `yaml@2.9.0`, follows repository-contained local references cycle-safely, traverses workflow runner `parallel` groups iteratively, and returns deterministic rule findings. Owner/repository references use exact reviewed commit SHAs, while executable Docker action references use exact SHA-256 image digests. The existing CI and Pullfrog workflows then use minimal YAML permissions, no provider-secret fan-out, a protected Pullfrog environment, disabled credential persistence/push, and the SHA-pinned local Pullfrog core path; Dependabot proposes reviewed SHA updates without merging them automatically. Upstream authority that cannot be narrowed in v0.1.60 remains an explicit acceptance blocker rather than being hidden by workflow prose.

**Tech Stack:** TypeScript 7, Bun 1.3.1 test runner, exact `yaml@2.9.0` development parser, GitHub Actions YAML, Dependabot.

**Spec:** `docs/superpowers/specs/2026-08-23-release-backlog-hardening-design.md`

## Global Constraints

- Preserve all documented valid public inputs, public TypeScript signatures, synchronous behaviour, result shapes, ordering, CLI framing, existing subsystem error codes, canonical data, and repository formats.
- Add no runtime dependency. Use exact development-only `@types/bun@1.3.1` for the scripts TypeScript project and exact development-only `yaml@2.9.0` for policy parsing; YAML is already transitively locked, so making it direct adds no resolved package. Remove the historical handwritten Bun runtime declarations.
- The workflow policy must parse YAML structurally; source regexes are not an acceptable substitute.
- External owner/repository[/path] references must end in one lowercase 40-character commit SHA; a trailing comment records the human-readable release. Executable `docker://` action references must end in `@sha256:` plus 64 lowercase hex characters, including reachable local Docker actions' `runs.image`. Repository-local `Dockerfile` and `./Dockerfile` images remain accepted, but their `FROM` chains are outside policy proof.
- Repository-local reusable workflows and composite actions must be resolved through `lstat` and native real paths beneath the repository root, reject symlinks/non-regular/ambiguous targets, and be scanned recursively with cycle detection.
- Source visits use a deterministic iterative queue keyed by comparable path and workflow/action role. Each file or directory observation is bound across `lstat`/native-realpath/final-`lstat`; action-manifest observations are bracketed by matching initial and final directory generations. Final acceptance performs two bounded sequential revalidation sweeps over repository/workflow discovery, every successfully read file witness, and every resolved action directory's exact `action.yml`/`action.yaml` candidate set. The first sweep may run internal fault-injection callbacks; after it succeeds, the second repeats the same witness checks without callbacks. Any mismatch observed by either sweep discards provisional findings and returns one deterministic `source-integrity` finding without rereading or reparsing sources or retraversing references. The sweeps are not a filesystem lock or simultaneous snapshot and do not claim to detect mutations made after an entry's final observation or changes indistinguishable through retained filesystem metadata.
- Bound repository-controlled input to 256 raw workflow-directory entries, 256 KiB per source through a bounded descriptor read, 4 MiB aggregate source bytes, 512 unique source-path/role visits, and a shared 16,384 parsed-tree ceiling for secret scanning and executable-step structural objects. A secret-tree or executable-structure cycle, or any exceeded bound, discards provisional findings and fails closed to the single global `source-integrity` finding.
- Credential-bearing runner jobs include workflow- or job-level secret-context expressions across dotted, bracket, and whitespace forms, or effective `id-token: write`; each requires the exact `pullfrog-review` environment. Workflow-level env applies only to runner jobs because it is not propagated to called workflows.
- Repository-local reusable-workflow callers may forward named secrets or use `secrets: inherit` because the called workflow is recursively inspected and its credential-consuming runner jobs independently require `pullfrog-review`. External reusable workflows remain subject to immutable pinning, require exact `jobs.<id>.permissions: {}`, and may not receive forwarded secrets. Empty permissions leave no configurable repository permission scopes without asserting that no token object exists; named or inherited `secrets` is rejected at the caller under `credential-forwarding`.
- Every workflow must explicitly declare exact `{}` or `{ contents: read }`. Ordinary runner and repository-local caller jobs may omit permissions to inherit or use either map; exact `{}` overrides inherited authority but does not bypass credential-environment policy. External reusable callers still require explicit exact `{}`. The protected Pullfrog job alone may additionally use exact `{ contents: read, id-token: write }`. This lower-authority acceptance broadening is monotonic: write/additional scopes and top-level omission remain rejected.
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
  | 'credential-forwarding'
  | 'external-image-digest'
  | 'external-reference-sha'
  | 'local-reference'
  | 'permission'
  | 'source-integrity'

export type WorkflowPolicyFinding = Readonly<{
  file: string
  location: string
  rule: WorkflowPolicyRule
}>

export const inspectWorkflowPolicy = (root: string): readonly WorkflowPolicyFinding[]
export const formatWorkflowPolicyFindings = (findings: readonly WorkflowPolicyFinding[]): string
```

- `inspectWorkflowPolicy` starts from sorted `.github/workflows/*.yml` and `*.yaml` files, parses each through the strict YAML 1.2 `parseWorkflowDocument` helper, and follows each allowed local reference to either the named YAML file or `action.yml`/`action.yaml` in the named directory.
- Returned `file` values are slash-separated repository-relative paths. `location` values use deterministic object/array paths such as `jobs.verify.steps[0].uses`.
- The CLI path prints the formatted findings to stderr and exits non-zero when findings exist; it prints nothing and exits zero when the repository passes.

- [x] **Step 1: Write failing behavioural tests**

Create temporary fixture repositories and test the real parser and traversal. Before writing each body, name the production mutation it catches:

1. Removing recursive local-reference traversal would allow a local composite action to hide `owner/action@v1`.
2. Keying recursive visits by path without the workflow/action role would skip independently relevant `jobs` or `runs.steps` in one dual-role source.
3. Removing runner credential detection would allow `${{ secrets.TOKEN }}` or effective `id-token: write` without an environment; treating reusable callers as runners would demand an unsupported caller environment.
4. Allowing external reusable-workflow callers to forward named or inherited secrets would move credentials outside the recursively inspected repository boundary.
5. Treating Docker actions as repository references would reject immutable image digests, while omitting local `runs.image` inspection would hide mutable container tags.
6. Broadening permissions would allow `contents: write` or OIDC outside the protected Pullfrog job, or give an external reusable-workflow call configurable repository permission scopes; rejecting exact `{}` would unnecessarily exclude lower authority.
7. Removing containment or cycle handling would allow `./../outside/action` or a self-referencing local action to escape or loop.
8. Omitting final source and action-directory candidate revalidation would accept a replaced parsed workflow or a late second action manifest.
9. Removing deterministic sorting would make diagnostics depend on directory or object insertion order.
10. YAML 1.1 coercion or permissive duplicate handling would merge valid `on`/`yes`/`no`/`off`/`true`/`false` job IDs or silently overwrite unsafe content.
11. Inspecting only direct workflow steps would let nested `parallel` groups hide mutable actions or local wrappers; recursing into composite/data fields would create false executable positions.

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
const fullDockerImageDigest = /^docker:\/\/[^@\s]+@sha256:[0-9a-f]{64}$/u
const localReference = /^\.\//u
```

- Parse only after the 256 KiB source bound with `parseDocument` under YAML 1.2 core semantics, strict string and unique keys, merges disabled, zero errors or warnings, one plain-object document, and `toJS({ maxAliasCount: 100 })`. Emit `source-integrity` for invalid discovery and unreadable, malformed, ambiguous, or unsafe source YAML rather than raw parser diagnostics. Reserve `local-reference` for disallowed, escaping, or missing local `uses` targets.
- Traverse arrays and plain parsed objects without evaluating template expressions.
- Track each comparable absolute path and workflow/action role in a visit set before following local references through a deterministic iterative queue, allowing one source to be inspected once in each role while same-role cycles terminate. Cap the set at 512 unique path/role visits.
- Resolve local references against the repository root, reject any resolved path outside it, and load only `.yml`, `.yaml`, `action.yml`, or `action.yaml` targets. Treat ambiguous or unsafe action manifests as `source-integrity`, while absent local targets remain `local-reference`.
- Bind file and directory observations across `lstat`/native-realpath/final-`lstat`. Read at most 256 KiB per source through a bounded descriptor and 4 MiB in aggregate. Retain each successful validated file read's final stable metadata/path witness and each unique resolved action directory's stable generation plus exact `action.yml`/`action.yaml` observations bracketed by matching initial and final directory generations. At the final boundary, run one optional-hooked sweep over discovery and every retained witness. If it succeeds, invoke the between-sweep test hook and repeat the same bounded sweep without callbacks. Discard provisional findings and return one deterministic `source-integrity` finding on any mismatch without rereading or reparsing sources or retraversing references. This sequential protocol is not a filesystem lock or snapshot and makes no claim about mutations after an entry's final observation or changes indistinguishable through retained filesystem metadata.
- Inspect at most 256 raw workflow-directory entries and 16,384 parsed-tree nodes. Share the tree ceiling between secret scanning and executable-step structural objects; reject secret-tree and executable-structure cycles. Any exceeded bound discards provisional findings and returns the same single global `source-integrity` finding.
- Traverse nested `jobs.<id>.steps[*].parallel` groups iteratively at exact locations for workflow runner jobs only. Composite actions do not accept `parallel`; ordinary data named `parallel` or `uses` remains non-executable.
- Scan every executable string-valued `uses` field. Local references recurse. Owner/repository action and reusable-workflow references require the full commit pattern. Action-kind `docker://` references require the full Docker digest pattern; a job-level reusable-workflow reference that begins `docker://` remains invalid under `external-reference-sha`.
- For every reachable local action with `runs.using: docker`, inspect a string `runs.image` beginning `docker://` at location `runs.image` under `external-image-digest`. Preserve repository-local `Dockerfile` and `./Dockerfile` forms without claiming that their `FROM` chains are inspected or proven.
- Distinguish reusable-workflow caller jobs whose `uses` value is a string from runner jobs. Treat a runner as credential-bearing when workflow-level `env` or its own subtree contains a secret-context expression with optional expression/accessor whitespace and dotted or bracket access, or when effective job permissions contain `id-token: write`.
- Require the exact string environment `pullfrog-review` or an object whose exact non-empty `name` is `pullfrog-review` for every credential-bearing runner. Do not apply caller workflow env to reusable-workflow caller jobs because GitHub does not propagate it to the called workflow.
- Allow repository-local `$/` and `./` reusable-workflow callers to forward named secrets or use `secrets: inherit`; recursive inspection enforces the environment on actual credential-consuming runners in the called workflow. Require exact `jobs.<id>.permissions: {}` on an external reusable-workflow caller, reject any caller `secrets` property at `jobs.<id>.secrets` under `credential-forwarding`, and preserve external pinning checks under `external-reference-sha`.
- Require an explicit top-level permission map of exact `{}` or `{ contents: read }`. Ordinary runners and repository-local callers may omit permissions to inherit or use either exact map; exact `{}` overrides inherited OIDC but does not bypass protected-environment enforcement for secret-bearing runners. Reject every other `write` or additional permission except exact `{ contents: read, id-token: write }` for `.github/workflows/pullfrog.yml`, job `pullfrog`, environment `pullfrog-review`. External reusable callers remain restricted to explicit exact `{}`.
- Sort findings by `file`, `location`, then `rule` with ordinal string ordering.
- Keep CLI execution behind `if (import.meta.main)` so tests import without exiting.
- Keep the formatted `file:location: rule` prefix. Append exhaustive static guidance for protected environments, external secret forwarding, Docker image digests, repository pins, contained local targets, and stable sources. Use a file/location-aware permission helper that names literal workflow maps, ordinary job inheritance/maps, the ambiguous external-caller root requirement, and the exact Pullfrog OIDC map.

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

Parse the checked-in workflows with `parseWorkflowDocument`. Require the exact `on` key, exactly one Pullfrog action step and one Pullfrog checkout, exact read-only/OIDC job permissions, exact protected environment, exact action-step environment, and literal `push: disabled`. Require every checkout in both workflows to set `persist-credentials: false`. These assertions catch duplicate unsafe steps and provider-secret reintroduction that the general permission policy cannot observe.

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

In `README.md`, add `bun run check:workflows` to Development and explain that owner/repository references use immutable commit SHAs, executable Docker actions use immutable image digests, workflow policy follows local wrappers and Docker `runs.image`, and repository-local Dockerfile `FROM` chains remain outside proof. Document the explicit lower-authority permission maps, branch-restricted protected environment with hosted OIDC rather than repository provider secrets, `push: disabled`, and the local CLI switch that prevents the mutable Pullfrog-core bootstrap.

In `docs/contract.md`, add a `## Workflow Trust Boundary` section specifying:

- exact-SHA owner/repository actions and exact-digest Docker actions with reviewed version comments where applicable;
- recursive structural validation of local reusable workflows/composite actions;
- the local Dockerfile `FROM`-chain boundary;
- explicit empty/read-only workflow permissions and ordinary job inheritance/empty/read-only compatibility;
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
node dist/cli.mjs validate --root .
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

Expected: direct development tooling additions are exact `@types/bun@1.3.1` and exact `yaml@2.9.0`; YAML was already resolved transitively, so its direct pin changes only the root lock manifest. There is no runtime dependency, new resolved package, or generated-version change. The branch otherwise contains only the approved programme spec, MAR-2574 plan, policy/tests, workflow/Dependabot/package-script configuration, and maintained documentation.

- [x] **Step 4: Commit documentation**

Run:

```bash
git add README.md docs/contract.md docs/superpowers/specs/2026-08-23-release-backlog-hardening-design.md docs/superpowers/plans/2026-08-23-workflow-supply-chain-hardening.md
git commit -m "[MAR-2574] Document workflow trust boundaries"
```

Before committing, rerun `bun run test`, `bun run typecheck`, and `bun run lint`.

---

## Implementation Evidence

- Earlier implementation lineage includes the structural-policy commit `16266f47db0c802d818d85db139472616aa930e7`, core workflow snapshot `a2bb85a7b28aefedbcb13b4c61d16bbce3f76c57`, and successive branch, cross-platform, input-integrity, and executable-schema remediations through `a8367f56ccab83755ef27e7636de2efc94f70538`. The final remediation sequence is `f0f625bfdf43ba69925087b53b93d913c67403bf` for reusable-caller credential semantics, `8dd6d14fe43731276f8f34293adbcec19bc3f7da` for role-keyed traversal and final source-witness revalidation, `006c3101a00b6c27d2191cd7acdcefca69d23270` for exact empty external caller permissions, the accurate external-reference taxonomy, and actionable diagnostics, `355ef8980b3d80c5a861da54c018e68019ee2add` for bounded source validation and path-observation race closure, `c664b733b27efc0ba17fea79c2de5a1ab8aa921c` for exact descriptor byte ceilings, `69e649ecec2cb24528bc56bd5ddaaeb185795f6f` for immutable Docker references, least-authority permission compatibility, and location-aware guidance, `62d145a67dd74254e139ee9e4ab38e53719dcd76` for strict YAML 1.2 parsing and nested workflow-step traversal, `3a3d272b695bb9c8784a4e26c26e25ed21ec0159` for the shared parsed-tree budget, `d3610e0d8c00c63f9456c32e18d03c965d58cf04` for the callback-free second witness sweep, and `8e0a0a43fc871397e8c72e3d41e50e5139665853` for exact limits, Bun alignment, and structural release-comment assertions. The exact final reviewed MAR-2574 code and behavioural-test implementation snapshot is `8e0a0a43fc871397e8c72e3d41e50e5139665853`; `a8367f56ccab83755ef27e7636de2efc94f70538` and `006c3101a00b6c27d2191cd7acdcefca69d23270` are earlier remediation milestones rather than the final state.
- At `8e0a0a43fc871397e8c72e3d41e50e5139665853`, 56 focused workflow-policy tests passed with one host-inapplicable Windows-only skip and zero failures, and the repository policy CLI returned no findings. Lint checked 117 files with no fixes, all four TypeScript projects passed, the full suite reported 564 tests with 562 passed, two established capability skips, and zero failures, the benchmark, build, package, publish-contract, and workflow gates passed, Encephalon validation accepted all 38 records, and diff hygiene returned no findings. Earlier pull-request CI run `32656889751` remains evidence only for the older `f22fafeec2346d1ced699433711dd51985a2f9e8` snapshot, not the final reviewed implementation.
- Frozen installation checked 39 installs across 66 packages with no changes. CI benchmark budgets, build, package validation, and the publish contract all exited zero. The publish contract accepted npm's expected refusal to overwrite already-published version `0.2.0`; no publication occurred.
- `git diff --check origin/main...HEAD` returned no findings. Encephalon validation checked 38 records with zero errors. The origin/main scope audit found no `src/generated/version.ts` change or runtime dependency change. Exact `@types/bun@1.3.1` and exact `yaml@2.9.0` are the direct development additions; YAML was already present transitively, so this direct pin adds no resolved package. Bun types and `skipLibCheck` remain scripts-project-only, the handwritten Bun declaration is removed, scripts remain unpublished, and the Node consumer/runtime boundary is unchanged.
- The local repository work does not complete the external rollout. The ticket branch is pushed and draft pull request #66 exists, but the live `pullfrog-review` environment is absent, repository `sha_pinning_required` remains false, and no Pullfrog dispatch, Linear completion, GitHub settings change, or merge was performed. v0.1.60's internal MCP token still has `contents: write` despite `push: disabled`, and its later exact-version agent-runtime production dependencies still resolve outside the action lock; both remain upstream MAR-2574 acceptance blockers.

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
