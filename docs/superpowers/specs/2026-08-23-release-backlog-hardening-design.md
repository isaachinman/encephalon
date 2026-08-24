# Release Backlog Hardening Design

## Status

Approved on 2026-08-23 for the 13-ticket release-hardening batch tracked by MAR-2571–MAR-2576 and MAR-2635–MAR-2641.

## Goal

Close the remaining genuine Encephalon project backlog without weakening backwards compatibility, mixing ticket ownership, or merging partially reviewed foundations. Each ticket remains an independently reviewable branch and pull request. No ticket merges until the complete batch is implemented, verified, and reviewed.

## Global compatibility contract

Every ticket must preserve:

- all documented valid public inputs;
- public TypeScript signatures, synchronous behaviour, result shapes, ordering, and CLI framing;
- existing subsystem error codes, messages, causes, and safe detail fields unless a ticket explicitly adds bounded details;
- canonical record JSON, manifests, instruction-file formats, and repository layout;
- existing repositories, records, instruction files, clients, and valid cache generations without user migration or data loss.

Disposable cache schema changes may invalidate and rebuild old caches automatically. Legacy recovery markers without a phase remain readable as active recovery state. Additive post-commit details must preserve the failing subsystem's code. Numeric negative zero may normalise to canonical JSON zero because it has the same JSON and ordinary numeric meaning.

MAR-2572's original exact-key requirement conflicts with TypeScript structural compatibility and current runtime behaviour. Unknown ordinary data properties therefore remain ignored. Accessors, sparse arrays, symbol properties, exotic prototypes, descriptor failures, and other values outside the documented plain, dense, data-only contract may be rejected with the existing `INVALID_ARGUMENT` code before repository or cache I/O.

## Architecture

The batch is divided into three dependency stacks. Implementation within a stack is serial so later tickets reuse reviewed primitives. The stacks may be analysed independently, but the shared local clone is changed by branch switching only; no worktrees or parallel branch edits are used.

### Stack A: CI and supply-chain safety

1. MAR-2574 — pin secret-bearing actions and minimise workflow credentials.
2. MAR-2640 — make current-Node and release-equivalent checks required before merge.

MAR-2574 establishes immutable action identities, structural workflow policy, and the protected Pullfrog trust boundary before MAR-2640 makes those workflows mandatory. CI policy uses exact development-only `yaml@2.9.0` without adding a resolved package or published runtime dependency. YAML sources are parsed after the 256 KiB bound under strict YAML 1.2 core semantics with string and unique keys, merges disabled, zero errors or warnings, one plain-object document, and `toJS({ maxAliasCount: 100 })`. Equivalent duplicate keys, multiple documents, unknown tags, non-scalar keys, and excessive aliases fail as `source-integrity`; bounded simple aliases remain accepted. A deterministic iterative queue scans repository-local actions for external `uses` references and Docker `runs.image` values, matching `runs.using` case-insensitively like the GitHub runner, and independently inspects repository-local reusable workflows as workflows, including their credential and permission policy, so local wrappers cannot hide mutable external actions or evade workflow authority checks. Owner/repository references require a lowercase 40-character commit SHA; executable Docker images require a lowercase 64-character SHA-256 digest unless a local action names an existing repository-contained single-link regular Dockerfile whose basename starts `Dockerfile.` or ends `Dockerfile`, case-insensitively. The Dockerfile identity remains bound through both final revalidation sweeps, while its contents and `FROM` chain remain outside proof.

Visits are keyed by comparable source path and workflow/action role, allowing one dual-role source to be inspected once in each role while same-role cycles terminate. Each file or directory observation is bound across `lstat`/native-realpath/final-`lstat`; action-manifest candidates are bracketed by matching initial and final directory generations. Policy acceptance performs two bounded sequential revalidation sweeps over repository/workflow discovery, every successfully read source, and every exact action-manifest candidate set. The first sweep may run internal fault-injection callbacks; after it succeeds, the second repeats the same witness checks without callbacks. Any mismatch observed by either sweep discards provisional findings and returns a deterministic `source-integrity` result without rereading or reparsing sources or retraversing references. The sweeps are not a filesystem lock or simultaneous snapshot and do not claim to detect a mutation made after an entry's final observation, after the checker returns, or one indistinguishable through retained filesystem metadata. Invalid discovery, malformed or unsafe sources, and ambiguous action manifests use the same taxonomy; `local-reference` is reserved for disallowed, escaping, or missing local targets.

Repository-controlled input is bounded to 256 raw workflow-directory entries, 256 KiB per source through a bounded, no-follow descriptor read with nonblocking and no-controlling-terminal flags where supported, 4 MiB of aggregate source bytes, 512 unique source-path/role visits, and 16,384 parsed-tree nodes shared by secret scanning and executable-step structural objects. Workflow runner `parallel` groups are traversed iteratively, including nested groups, at exact locations; composite actions do not accept `parallel`, and similarly named data remains non-executable. A secret-tree or executable-structure cycle, or any exceeded bound, discards provisional findings and fails closed to the single global `source-integrity` result.

Workflow job policy distinguishes reusable-workflow callers from runners. Runner jobs with secret-context expressions, workflow-level secret-bearing env, or effective OIDC authority require the exact `pullfrog-review` environment. Top-level workflow permissions must be explicit exact `{}` or `{ contents: read }`; ordinary runners and repository-local callers may omit permissions to inherit or use either exact map. An exact `{}` overrides inherited OIDC but does not bypass secret-bearing runner environment enforcement. The protected Pullfrog job may additionally use exact `{ contents: read, id-token: write }`. This is a monotonic lower-authority compatibility broadening; omission at top level and write/additional scopes remain rejected. A local reusable-workflow caller may forward named secrets or use `secrets: inherit` only because the called workflow is recursively inspected and its credential-consuming runners must independently target that environment; direct secret-context values in `with` are rejected so credentials cannot masquerade as ordinary inputs. A pinned external reusable workflow must still declare exact `jobs.<id>.permissions: {}`, omit `secrets`, and receive no direct secret-context inputs. Literal and GitHub-supported `github` or `needs` inputs remain valid; this structural policy does not claim transitive information-flow or taint proof through job outputs. The external call has no configurable repository permission scopes without claiming that no token object exists.

Diagnostics keep the `file:location: rule` prefix and append exhaustive remediation: exact protected environment, movement of local credentials from `with` to `secrets`, omission of external `secrets` and direct secret-context inputs, lowercase 64-character SHA-256 image digest under `external-image-digest`, lowercase 40-character repository pin under `external-reference-sha`, allowed contained local target, location-aware literal permission maps, or stable unambiguous sources for `source-integrity`.

Pullfrog continues using its hosted OIDC mode. Provider-secret mappings are removed, `id-token: write` remains narrowly scoped to the pinned Pullfrog job, checkout credentials are not persisted, pushes are disabled, and the workflow targets the `pullfrog-review` environment. The checked-in target does not provision or protect that GitHub environment. Before any dispatch, maintainers must create and protect it, require approval, and allow only exact `main` plus the exact ticket branch currently under review. Repository action SHA enforcement must be enabled only after the pinned workflow reaches `main`.

The exact reviewed repository-controlled MAR-2574 code and behavioural-test snapshot is `7666139ad3d1f4853cfee8710ddc841dc3978aec`. Detailed remediation lineage and gate evidence are recorded once in the [MAR-2574 implementation plan](../plans/2026-08-23-workflow-supply-chain-hardening.md#implementation-evidence). These repository-policy changes preserve the Node runtime API, package exports, canonical data, cache schema, and generated declarations.

This snapshot does not claim complete upstream immutability, MAR-2574 acceptance, or external rollout completion: v0.1.60 still mints an internal MCP token with `contents: write` despite `push: disabled`, and its later exact-version agent-runtime production dependencies resolve outside the action lock. Both require an upstream least-authority release before the protected-environment rollout can complete acceptance.

MAR-2640 runs the existing stable release-equivalent job on pull requests and trusted main pushes. Artifact upload remains main-only. A non-mutating generated-version check runs before builds, sharing one pure version-source renderer with the build and package checks. The exact reviewed MAR-2640 code and behavioural-test snapshot is `40e6a4dd63d69c215db4f7b43d8fb06a7886d1f4`; it accepts only complete checkout-equivalent CRLF without accepting mixed endings or content drift and preserves the runtime API, stored data, generated declarations, and zero-runtime-dependency package contract. Branch protection adds the current-Node and release-equivalent contexts only after the pull request has emitted them successfully.

### Stack B: schema and API input safety

1. MAR-2641 — normalise negative-zero confidence.
2. MAR-2576 — avoid descriptor-map amplification before payload budgets.
3. MAR-2572 — reject sparse arrays and accessor-bearing input envelopes.

MAR-2641 remains a scalar schema correction. MAR-2576 introduces dependency-free guarded prototype, own-key, and single-descriptor reads in `src/property-inspection.ts`; `src/schema.ts` retains payload policy, budgets, reconstruction, and iterative traversal without materialising whole-object descriptor maps. MAR-2572 reuses only that inspection primitive for public envelope parsing and dense-array validation, while `src/api-input.ts` retains envelope policy, operation-budget precedence, and unknown ordinary data-property tolerance.

The exact reviewed MAR-2641 code and behavioural-test snapshot is `58c01dc1ff263b8aa80a3cfaac610296233ed7e1`. It normalises only numeric negative-zero confidence at the existing schema boundary, preserving the accepted range, ordinary numeric values, errors, public shapes, canonical storage, and cache format. Coverage proves immediate mutation results, package-produced canonical bytes, existing raw canonical `-0`, rebuilt-cache reads, and CLI output converge on positive zero.

Property inspection never intentionally invokes getters or setters. JavaScript proxy traps cannot be made inert; trap failures are caught and normalised to bounded `INVALID_ARGUMENT` errors.

### Stack C: filesystem, cache, locking, records, and baseline integrity

1. MAR-2573 — use one lossless BigInt filesystem identity model.
2. MAR-2635 — reject hard-linked mutable SQLite cache and gate files.
3. MAR-2637 — make abandoned recovery markers reclaimable across processes.
4. MAR-2636 — bound lock-candidate discovery and reclaim abandoned candidates.
5. MAR-2575 — validate and mutate against a stable canonical corpus generation.
6. MAR-2571 — prove cached records match canonical JSON before reads.
7. MAR-2639 — build baseline records from one stable repository observation.
8. MAR-2638 — preserve committed add details when operation-gate cleanup fails.

`filesystem-entry.ts` becomes the single pure authority for lossless `BigIntStats` projections and comparisons. Context-specific I/O and policy remain in records, instructions, staging, cache-location, artifact, and verified-file modules. Link-count policy is separate because canonical and instruction publication intentionally use temporary hard links while mutable SQLite files must have exactly one link.

Cache-location owns verified opens, identity checks, bounded directory inspection, quarantine, and exact-path mutation. Locking owns tokens, PIDs, liveness, phases, deadlines, and recovery decisions. Durable recovery completion precedes candidate maintenance so cleanup can distinguish active legacy/recovering markers from exact completed markers without process-local state.

The existing record-planning snapshot evolves into one immutable canonical snapshot carrying validated records, exact bounded entry-set and file observations, artifact observations, byte/count accounting, and one current-generation authority. Reads, mutation planning, init, and cache rebuild consume that snapshot instead of creating parallel snapshot implementations. Cache/canonical fingerprinting is then added as a small pure projection over the stable canonical snapshot and independently validated cache rows. Old cache generations rebuild as disposable state.

Baseline observation remains baseline-specific. It reuses generic file and directory witnesses but not the canonical-record snapshot. A complete baseline attempt retains compact witnesses for every source, revalidates them together, retries bounded repository churn, maps only recognised operational failures to deterministic truncation, and propagates internal defects.

Committed add progress remains record-specific. A successful record is retained outside the generic operation-lock callback so later gate-cleanup failure can add the record ID, relative path, `canonicalCommitted`, `operationCleanup` phase, and deterministic recovery action without changing error precedence or codes for other lock callers.

## Branch and pull-request model

Each stack begins from the same verified `origin/main`. A dependent ticket branch temporarily bases on its predecessor so its pull request shows one ticket-sized diff. Every ticket branch has an explicit `origin/<ticket-branch>` upstream and is pushed with an explicit `origin <ticket-branch>:<ticket-branch>` refspec.

All 13 pull requests remain unmerged until every ticket is implemented and initially reviewed. Final merging uses this order:

1. MAR-2574
2. MAR-2640
3. MAR-2641
4. MAR-2576
5. MAR-2572
6. MAR-2573
7. MAR-2635
8. MAR-2637
9. MAR-2636
10. MAR-2575
11. MAR-2571
12. MAR-2639
13. MAR-2638

After a predecessor squash-merges, its dependent branch is rebased onto current `origin/main`, retargeted to `main`, force-pushed only through its explicit ticket refspec, and reverified at the exact new head. Main CI is watched after every merge; any failure pauses the sequence until main is repaired and fully green.

## Ticket workflow

Each ticket receives its own implementation plan, focused red-green-refactor cycles, maintained documentation, and the smallest implementation that satisfies its accepted scope. Tests are few, complementary, and behavioural. They prove hostile-input, race, recovery, work-bound, or workflow-policy behaviour without duplicating type, lint, database, or build guarantees.

Before a pull request is declared ready, run:

- frozen dependency installation with no lockfile change;
- lint;
- all TypeScript projects;
- the full test suite;
- benchmark budgets;
- build;
- package validation;
- publish-contract validation;
- diff hygiene;
- Encephalon validation;
- the full GitHub OS/current-Node matrix and release-equivalent gate.

Pullfrog reviews the exact head. Six parallel reviewers then assess security, correctness, data consistency and races, test coverage, maintainability, and UX/API compatibility where relevant. Every high- or medium-confidence finding is fixed and the affected exact-head gates and reviews repeat. Each branch is also evaluated against `main` for separation of concerns, stale assumptions, experimental residue, and documentation accuracy.

## GitHub settings rollout

MAR-2574 requires external repository configuration after its workflow diff is ready:

- before any Pullfrog dispatch, create and protect the exact `pullfrog-review` environment, require approval, and allow only exact `main` plus the exact ticket branch currently under review;
- enable repository action SHA-pin enforcement only after the pinned workflow reaches `main`;
- dispatch only an approved exact-head Pullfrog validation whose ref is allowed by the environment policy, because the environment changes the OIDC subject.

MAR-2640 requires, after its pull request emits successful contexts, branch protection to require:

- `verify (ubuntu-latest)`;
- `verify (macos-latest)`;
- `verify (windows-latest)`;
- `verify (ubuntu-current)`;
- `Release-equivalent package gate`.

Existing administrator bypass and force-push settings remain unchanged. Required checks therefore govern ordinary merges but do not claim protection against administrator bypass or direct force-push.

## Release boundary

Completing this batch does not itself publish a package. After all 13 tickets are merged, Linear is reconciled and a separate release-preparation ticket chooses the next version, moves post-0.2.0 changelog entries under that version, regenerates version metadata, proves a genuinely successful npm publish dry run, and follows the maintained manual publication contract.
