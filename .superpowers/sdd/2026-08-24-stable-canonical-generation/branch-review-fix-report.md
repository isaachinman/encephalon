# MAR-2575 branch-review fix report

Date: 2026-08-24
Branch: `mar-2575-canonical-records-validate-and-mutate-against-a-stable`
Reviewed base: `aef71241f59ff6a792c3bc50dd943da29f8a070a`

## Outcome

The high-confidence findings from the six-role branch review are closed without changing an established public API, successful result shape, documented error contract or detail field, canonical record format, artifact layout, cache schema version, manifest projection, SQLite logical row shape, package export, or runtime dependency.

The implementation keeps one records-owned, non-nested canonical retry ledger: at most three complete attempts, one non-resetting 60-second deadline, and no canonical retry after a successful record link. Stable invalid repositories continue to return ordinary validation results. All generation, pathname, descriptor, digest, identity, link-count, and ancestor evidence added by this round remains private and unpersisted.

No maintained contract documentation changed because the implementation now matches the contract already documented on this branch.

## Finding closures

### A — early invalid and stable evidence

- `RecordScan` now retains bounded private evidence for an initially invalid brain root, bounded root/kind layout observations, unreadable or oversized files, and the first record rejected by aggregate-byte accounting.
- Closing snapshot validation rechecks that evidence after validation work, so a repair or successor replacement enters the existing shared retry ledger.
- Reopening unreadable evidence checks the 1 MiB bound before allocating or reading; an oversized readable successor retries into its settled ordinary size-limit result.
- A stable invalid generation still returns its existing validation issue and result shape.
- Coverage includes root-entry and kind-entry repairs, exact root/kind overflow-to-valid transitions, per-file and aggregate byte-limit shrink-to-valid transitions, and invalid-record-to-valid transitions.

### B — descriptor-bound corpus accounting

- Detached pathname sizes are no longer charged to the aggregate corpus budget.
- Preliminary pathname metadata is bound to the opened descriptor; the descriptor must be regular and stable before its accepted metadata is charged.
- The first size-rejected observation is retained and revalidated rather than returned as an unbracketed limit result.
- Coverage proves descriptor-generation growth cannot bypass the 8 MiB aggregate bound and shrinkage cannot leave a stale overflow result.

### C — traversal replacement errors

- Replacement errnos `ENOENT`, `ENOTDIR`, and `ELOOP` at already-enumerated kind and record metadata boundaries now enter the private canonical-generation sentinel.
- Genuine operational failures continue through their established classification without retry.
- One-shot replacement and bounded persistent-churn cases cover kind and record traversal; an injected `EIO` remains a one-attempt operational failure.

### D — canonical hard-link replacement errnos

- The final canonical `link` boundary preserves `EEXIST` as `RECORD_EXISTS`.
- After all preceding authority assertions, `ENOENT`, `ENOTDIR`, and `ELOOP` from that syscall now map through `authority.changed()` and therefore use the existing pre-link replanning policy.
- A link-time competitor regression pins the exact `RECORD_EXISTS` message/details, one-attempt behaviour, and preservation of the competing bytes. Later initialisation failure retains the complete already-committed prefix and does not publish a later baseline record.

### E — directory-creation identity

- Exact creation witnesses are retained separately for the canonical root, candidate kind, and staging directory.
- Publication preparation must capture the same directory identities; same-type empty successors are not adopted.
- The staging identity is checked again after private-file creation.
- Identity comparison deliberately uses canonical/path device and inode evidence rather than timestamps that legitimately change when children are created.

### F — cache-writer identity

- The writer now reuses MAR-2635's existing metadata-only cache authority; no second cache identity authority was introduced.
- Exact single-link primary and sidecar identities are revalidated immediately before `COMMIT` and again before safe close/success.
- If DML-time metadata authority fails, rollback and close occur only when SQLite remains proven safe; unsafe generations use the existing bounded close-suppression latch and fail closed.
- Authority errors retain precedence over rollback/close failures and preserve existing cache error contracts.
- Coverage includes primary and WAL hard links introduced during DML and a same-path primary successor installed after `COMMIT` but before close.

### G — hardened record opens

- One shared record-open helper now applies `O_NOFOLLOW` plus conditional `O_NONBLOCK` and `O_NOCTTY`.
- Descriptor metadata must prove a regular file before any read.
- A failed open re-observes the pathname: a replacement becomes the private generation sentinel, while an unchanged operational failure keeps its existing path-safe classification.
- Stable `EACCES`/`EPERM` remains ordinary unreadable-record validation; other stable descriptor/open failures retain path-safe `IO_ERROR` classification.
- The same helper is used by initial reads, closing reinspection, and publication authority reads.
- Child-process FIFO replacement coverage completes without a hang; permission and replacement races remain path-safe.

### H — complete artifact ancestor evidence

- Stable and invalid artifact results retain a complete ordered ancestor witness chain in private `WeakMap` state.
- Equality compares every retained ancestor as well as the existing final evidence.
- Public artifact observations, validation results, cache manifests, and persisted formats are unchanged.
- Coverage replaces a higher ancestor while moving the same final inode back into place for both stable and stable-invalid artifact results.

### I — artifact churn uses the canonical ledger

- Stable canonical reads pass their canonical-changed callback into artifact validation.
- One-shot artifact inspection churn retries and settles; persistent churn exhausts the exact shared three-attempt ledger and path-free error envelope.

### J — one cache-recovery latch

- Snapshot-read recovery, writer recovery, outer disposable recovery, and rebuild notification share one session-owned recovery state.
- After one recovery is consumed, a later recoverable failure is terminal and cannot start a second quarantine or rebuild.
- The previous process-global weak recovery marker was removed.
- Coverage corrupts the locked snapshot read and then injects a recoverable writer failure, proving one quarantine, one writer initialisation, and no second recovery.

### K — coverage and contract guards

- The retry ledger has an internal deterministic clock seam and retains one clock/deadline for the whole operation.
- Tests prove a slow first stable attempt is accepted, a retry at 59,999 ms is permitted, a retry at exactly 60,000 ms is not started, and subsequent attempts do not reset the deadline.
- Planning constructs the canonical retry ledger lazily, so an optimistic cache probe does not consume its deadline.
- Manifest parity asserts schema version `1`, representative exact record columns/JSON, NFC-normalised FTS text, and the existing exact manifest hash bytes.
- The pre-DML authority regression instruments SQLite `exec` and statement `run`, proving zero DML before the first assertion succeeds; the existing after-insert failure continues to prove transaction rollback.
- Stale-cache coverage proves one optimistic manifest probe, one records scan, one graph validation, and no second locked full scan.

### L — maintainability

- Duplicate record descriptor reading was consolidated on `readBoundedDescriptor`.
- The unused stable planning scan and its uncalled internal wrapper were removed together.
- The unused cache snapshot preparer and obsolete recovery bookkeeping were removed after literal caller audits found no remaining callers.

## TDD evidence

Production changes followed focused failing regressions. Representative RED batches and their failure modes were:

1. Records/artifacts:

   ```text
   node --test --test-name-pattern='invalid brain-root entry|root and kind directory overflows|rejected per-file and aggregate|stable unreadable record|one-shot artifact inspection churn|exact retry deadline|record descriptor open cannot block|higher ancestor replacement' test/records.test.ts test/artifact-inspection.test.ts
   ```

   Initial result: 8/8 failed for stale early-invalid/limit evidence, immediate artifact churn escape, the missing exact deadline boundary, FIFO timeout, and missed higher-ancestor replacement. The same 8/8 passed after the records/artifact implementation.

2. Mutation identity and link mapping:

   ```text
   node --test --test-name-pattern='final link syscall boundary|never adopts same-type successors' test/records.test.ts
   ```

   Initial result: 2/2 failed because the link-boundary seam was not reached and a same-type successor was adopted. Both passed after the publication changes.

3. Cache writer authority:

   ```text
   node --test --test-name-pattern='cache writer rejects' test/cache.test.ts
   ```

   Initial result: 2/2 failed with missing exceptions for DML-time identity changes. Both passed after lifetime metadata authority was added.

4. Cache recovery ownership:

   ```text
   node --test --test-name-pattern='shares one recovery latch' test/cache.test.ts
   ```

   Initial result: failed with a missing terminal exception because a second recovery succeeded. It passed after the session recovery latch was shared.

5. Late records audit:

   ```text
   node --test --test-name-pattern='stable operational record-open|does not read oversized evidence' test/records.test.ts
   ```

   Initial result: 2/2 failed because stable `EIO` returned no exception and closing revalidation attempted one oversized rejected-record read. Both passed after operational-error preservation and the pre-read size check.

Complementary GREEN regressions cover descriptor-bound growth, traversal one-shot/exhaustion and operational errors, artifact persistent churn, all four deadline semantics, pre-DML zero-work, exact manifest/FTS parity, stale-cache work counts, post-insert rollback, and the initialisation committed-prefix envelope.

## Compatibility and security review

- Public/cache/persisted formats are unchanged: canonical JSON, runtime paths, artifact observations, cache schema version `1`, manifest entry keys/order/hash bytes, record rows, FTS rows, instruction files, and package exports require no migration.
- Existing error codes, messages, detail fields, precedence, `RECORD_EXISTS` handling, committed-add fields, and initialisation progress envelopes are preserved.
- The private canonical sentinel never enters public causes or details. New evidence contains absolute paths, filesystem identity, metadata, digests, and ancestor chains only in private in-memory structures and is never copied into validation issues, error details, CLI output, cache rows, or manifests.
- Stable operational filesystem failures remain ordinary path-safe `IO_ERROR`/validation classifications. Replacement errors alone enter generation retry.
- Cache sidecars were evaluated against the existing MAR-2635 authority. The fix extends that authority's lifetime through DML, commit, and close instead of creating parallel sidecar logic.
- No post-link canonical retry was added. Record-producing flows retain committed-prefix and publication-verification semantics.
- Retry remains one non-nested maximum-three/non-resetting-60-second records ledger.

## Verification gates

All commands ran on the exact ticket branch from base `aef71241f59ff6a792c3bc50dd943da29f8a070a`.

- `node --test test/artifact-inspection.test.ts test/records.test.ts` — 171 passed, 0 failed.
- `node --test test/init.test.ts` — 176 passed, 0 failed, 2 expected case-sensitive-filesystem skips.
- `node --test --test-reporter=dot test/cache.test.ts` — 226 passed, 0 failed.
- `node --test test/staging.test.ts test/errors.test.ts test/cli.test.ts test/package.test.ts` — 32 passed, 0 failed.
- `bun run test` — 747 total, 745 passed, 0 failed, 2 expected skips; includes build.
- `bun run lint` — 131 files checked, no diagnostics.
- `bun run typecheck` — source, scripts, tests, and runtime-guard configurations passed.
- `bun run benchmark:check` — CI profile completed within the maintained budgets.
- `bun run build` — passed.
- `bun run check:package` — passed.
- `bun run check:generated` — passed.
- `bun run check:workflows` — 63 passed, 0 failed, 1 platform skip; policy command passed.
- `bun run check:publish` — passed its expected already-published-version preflight classification.
- `node dist/cli.mjs validate --root .` — valid, 38 records checked, no errors.
- `git diff --check` — passed.

## Final generation review addendum

This addendum supersedes the directory-creation wording in finding E above. A portable Node filesystem call cannot return an identity handle for the exact directory instance created by `mkdirSync`, so a pathname witness captured after that call cannot prove operation ownership if a same-name successor is installed before the call returns. The final closure does not use such a witness as ownership proof.

### Final finding closures

1. **Created root, kind, and staging identity:** an attempt that creates the canonical root aborts through the private preparation change immediately when `mkdirSync` returns, before any kind or staging syscall. It therefore cannot follow a root symlink successor, create children outside the repository, leak a raw `ENOTDIR` for a file successor, or reach a canonical hard link. The next complete attempt binds the exact successor root, creates every required baseline kind plus `_staging` in one preparation pass, and aborts again before publication if it created any child. A third complete scan treats that post-creation layout as its baseline, binds the exact root/kind/staging identities, and is the first attempt allowed to link. Existing roots that only require child creation still use one preparation replan. All phases consume the same maximum-three/non-resetting-60-second ledger without a nested retry path; stable invalid successors retain ordinary validation.
2. **Parent revalidation errors:** `assertParentIdentity` now receives the canonical changed callback and the read hooks. `ENOENT`, `ENOTDIR`, and `ELOOP` at this exact secondary boundary enter the private generation sentinel; a stable operational failure is normalised without retaining the absolute pathname and preserves its established public classification.
3. **Record-open privacy:** the shared `openObservedRecordDescriptor` boundary now preserves existing sentinel/`EncephalonError` authority, re-observes a failed pathname to distinguish replacement, and normalises a stable operational failure before it can reach either pre-commit or committed cause chains. Closing and publication reinspection use the same helper and hooks. The committed publication authority also normalises later fstat/fault and descriptor-close failures, so a post-link operational cause cannot retain the canonical absolute path.
4. **Unreadable closing evidence:** after exact path and parent revalidation, only a later `EACCES` or `EPERM` confirms the original stable `INVALID_RECORD` result. Other failures, including `EIO`, are rethrown through the path-safe record operational error.
5. **Descriptor helper cleanup:** the unreachable `invalidRecordReadChange` fallback was removed. Every `readBoundedDescriptor` caller must now provide its exact generation-changed authority.
6. **Cache sidecar privacy and close safety:** the sidecar-changed database snapshot is retained in a module-private `WeakMap` keyed by a plain `EncephalonError`. Terminal public errors expose only the established code, message, and details; they have no enumerable database carrier or private subclass name and remain JSON serialisable. After trusted lock initialisation, the existing MAR-2635 metadata-only authority captures one fresh sidecar baseline so a contender may accept its own journal transition after `BEGIN IMMEDIATE`; the following authority check requires exact presence and identity. A post-capture replacement, appearance, or disappearance is terminal, suppresses SQLite close, latches the database against reopening, and cannot retry or quarantine. The same close-safety decision recognises a private sidecar-change carrier discovered during secondary validation after another initialisation failure. DML-time WAL and post-BEGIN gate-journal successors are preserved exactly.

### Final TDD evidence

- The five records privacy/error regressions were introduced together and initially failed 5/5: the parent disappearance did not retry, stable parent/open failures retained injected absolute paths, committed reinspection retained the raw open cause, and a closing `EIO` was swallowed as `INVALID_RECORD`. The focused batch passed 5/5 after the shared-boundary changes.
- The DML-time single-link WAL successor regression initially failed because the public error name was `CacheDatabaseSidecarChanged`. It passed after the carrier moved to private weak state and also proved no `database` property, no absolute path/device/inode/private name, successful JSON serialisation, zero quarantine, and exact successor preservation.
- The wrapped-`mkdirSync` root/kind/staging regression initially linked into a successor from the same attempt. A dedicated root file/symlink RED additionally returned raw `ENOTDIR` or could create descendants through the successor. Root creation now aborts before any descendant syscall; missing-root first use proves exactly three complete scans/graph validations, two preparation replans, no earlier link, and publication only from scan three. Persistent replacement proves exactly three scans/graphs, three replacements, and zero links. Stable invalid successors retain ordinary `VALIDATION_FAILED`, and multi-kind initialisation proves every planned kind plus staging is created together on scan two before all baseline links occur on scan three.
- The initial post-BEGIN sidecar fix was RED because a single-link journal successor was closed and retried. It now proves one open, zero callback entries, closes, retries, or quarantines, a terminal session latch, and exact successor preservation. Fresh post-BEGIN appearance/disappearance regressions then exposed optional-presence adoption; exact metadata reconciliation closes both. A secondary-validation regression initially threw the private carrier but failed to latch, allowing the next open; close suppression now recognises that carrier wherever it appears. The existing cross-process timestamp regression caught an over-strict pre-BEGIN witness and now proves that only the trusted operation-owned `BEGIN` transition is freshly captured before strict comparison.
- An armed post-link `after-record-fstat` regression initially retained the injected absolute record path in `publicationVerification.cause`. It now has the same path-safe `EIO` cause as the existing committed open regression.
- Existing later-boundary tests precreate their canonical directories so their scan/link assertions continue to measure the intended graph, final-link, post-link, cache-sealing, and committed-prefix races rather than the new safe first-use preparation phase. First-use add and init coverage explicitly records the additional preparation attempt.

### Final compatibility and security review

- No public API, package export, canonical JSON, runtime path, validation result, cache schema/version, manifest, FTS row, instruction, or persisted format changed.
- Established public codes, messages, details, `RECORD_EXISTS`, committed-prefix fields, and no-post-link-retry behaviour are preserved.
- A first mutation into a missing canonical layout now performs two bounded preparation replans before linking: one after root creation and one after all planned child creation. This is an internal phase-count change within the existing three-attempt/60-second contract. The maintained contract already states that a pre-link generation change discards and recomputes the complete attempt, so no contract documentation change was required.
- Private directory identities, record paths, filesystem metadata, cache database handles, digests, payloads, ancestor evidence, and sentinel class names are absent from public details and cause chains.
- The cache change reuses the MAR-2635 authority and does not add a second identity authority or recovery/quarantine path.

### Final verification gates

- `node --test test/records.test.ts` — 160 passed, 0 failed.
- `node --test --test-reporter=dot test/cache.test.ts` — 229 passed, 0 failed.
- `node --test test/init.test.ts` — 177 passed, 0 failed, 2 expected filesystem-platform skips.
- `node --test test/artifact-inspection.test.ts test/staging.test.ts test/errors.test.ts test/cli.test.ts test/package.test.ts` — 53 passed, 0 failed.
- `bun run test` — 761 total, 759 passed, 0 failed, 2 expected skips; includes build.
- `bun run lint` — 131 files checked, no diagnostics.
- `bun run typecheck` — source, scripts, tests, and runtime-guard configurations passed.
- `bun run benchmark:check` — CI profile completed within the maintained budgets.
- `bun run build` — passed.
- `bun run check:package` — passed serially. An earlier parallel invocation raced a simultaneous build and transiently packaged the output between declaration-file replacement steps; the required isolated rerun passed.
- `bun run check:generated` — passed.
- `bun run check:workflows` — 63 passed, 0 failed, 1 expected Windows-only skip; policy command passed.
- `bun run check:publish` — passed its expected already-published-version preflight classification for `0.2.0`.
- `node dist/cli.mjs validate --root .` — valid, 38 records checked, no errors.
- `git diff --check` — passed.

An independent final read-only review found no remaining implementation issue after the root-phase, committed-fstat, strict sidecar-presence, and secondary-carrier closures. Its only final finding was the stale phase/count wording corrected in this addendum.
