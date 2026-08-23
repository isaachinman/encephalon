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

MAR-2574 establishes immutable action identities, structural workflow policy, and the protected Pullfrog trust boundary before MAR-2640 makes those workflows mandatory. CI policy remains dependency-free. It recursively scans repository-local composite actions for external `uses` references and independently and recursively inspects repository-local reusable workflows as workflows, including their credential and permission policy, so local wrappers cannot hide mutable external actions or evade workflow authority checks.

Pullfrog continues using its hosted OIDC mode. Provider-secret mappings are removed, `id-token: write` remains narrowly scoped to the pinned Pullfrog job, checkout credentials are not persisted, pushes are disabled, and the workflow targets the `pullfrog-review` environment. The checked-in target does not provision or protect that GitHub environment. Before any dispatch, maintainers must create and protect it, require approval, and allow only exact `main` plus the exact ticket branch currently under review. Repository action SHA enforcement must be enabled only after the pinned workflow reaches `main`.

The final repository-controlled MAR-2574 implementation and behavioural-test snapshot is `31ba01944a1e4afccf867c7f7607859c437f3e0e`. It uses official exact `@types/bun@1.3.1` declarations only as a development dependency, with Bun types and `skipLibCheck` limited to the scripts project and the historical handwritten Bun declaration removed; Node consumers and the runtime package remain unchanged. It recursively enforces immutable external action references, exact workflow and job permission maps, exact environment targeting for credential-bearing jobs, and stable repository-contained workflow discovery; disables checkout credentials and git pushes; and forces the pinned local Pullfrog core so v0.1.60 cannot bootstrap mutable `pullfrog@^0.1.60`. It does not claim complete upstream immutability or MAR-2574 acceptance: v0.1.60 still mints an internal MCP token with `contents: write` despite `push: disabled`, and its later exact-version agent-runtime production dependencies resolve outside the action lock. Both require an upstream least-authority release before the external environment rollout can complete acceptance.

MAR-2640 runs the existing stable release-equivalent job on pull requests and trusted main pushes. Artifact upload remains main-only. A non-mutating generated-version check runs before builds, sharing one pure version-source renderer with the build and package checks. Branch protection adds the current-Node and release-equivalent contexts after the pull request has emitted them successfully.

### Stack B: schema and API input safety

1. MAR-2641 — normalise negative-zero confidence.
2. MAR-2576 — avoid descriptor-map amplification before payload budgets.
3. MAR-2572 — reject sparse arrays and accessor-bearing input envelopes.

MAR-2641 remains a scalar schema correction. MAR-2576 introduces a small guarded property-inspection primitive and retains iterative payload traversal without materialising whole-object descriptor maps. MAR-2572 reuses that primitive for public envelope parsing and dense-array validation while retaining operation-budget precedence and ignoring unknown ordinary data properties.

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
