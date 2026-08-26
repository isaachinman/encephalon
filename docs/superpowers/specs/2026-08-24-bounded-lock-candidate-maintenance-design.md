# Bounded Lock Candidate Maintenance Design

## Goal

Make operation-lock acquisition independent of cache-directory size while incrementally reclaiming exact candidates abandoned before promotion. Unrelated candidate-shaped entries must remain inert: they cannot block the current operation, authorise deletion, or expose private metadata.

## Compatibility boundaries

- The SQLite `BEGIN IMMEDIATE` transaction remains the authoritative operation lock.
- Public APIs, callback results, `CACHE_BUSY`, the single 60-second deadline, cache schema, canonical data, and error precedence remain unchanged.
- The fixed `operation.lock`, fixed `operation-lock.recovery`, current random candidate, cache location, and SQLite gate remain fail-closed under their existing errors.
- The intentional compatibility correction is that an unrelated malformed, linked, or unsupported candidate no longer rejects an otherwise safe operation.
- Candidate owners retain the existing exact three-field `{ acquiredAt, pid, token }` JSON shape. No stored-format migration is introduced.
- Candidate tokens, owner bytes, PIDs, absolute paths, and raw directory contents never enter public errors or diagnostics.

## Bounded discovery and forward progress

The pre-gate `readdirSync(...).filter(...)` scan is removed. Before the SQLite gate, an operation performs only exact work for its own randomly named candidate: exclusive creation, bounded owner publication, and identity revalidation.

After the gate transaction succeeds and the current candidate is promoted to `operation.lock`, candidate maintenance streams direct cache-directory entries. Each operation visits at most 64 raw entries, fully inspects at most 16 candidate-shaped entries, and attempts at most 4 reclamations. Unknown names count against the visit budget; exhausting any budget ends maintenance without probing or materialising the remainder.

A dependency-free bounded-directory reader owns only the synchronous read loop. Canonical-directory collection continues to open, bound, sort, and close its own snapshot through that primitive. Candidate maintenance retains the open reader at a bounded process-local cursor layer so the next operation resumes after a stable prefix rather than reopening at its beginning. Native Windows readers are closed after every maintenance call so a directory-search handle cannot prevent repository deletion on filesystems without POSIX delete semantics.

Cursors are bound to the exact cache-directory path and BigInt device/inode identity. At most eight readers are retained. End-of-directory, cache identity change, reader/open failure, test-reader change, LRU eviction, or native Windows call completion closes and discards the applicable reader; close failure never replaces an earlier read error. Reaching end-of-directory causes the next operation to open a new pass so later additions become discoverable. This provides deterministic progress through a retained pass for repeated operations in one live non-Windows process without a new persistent cursor file, daemon, cache schema, or public protocol. Process restart or each native Windows call may restart the pass from its beginning. There is no cross-process or post-restart progress or fairness guarantee, but every individual operation remains bounded and safe.

## Candidate authority and abandonment

Maintenance recognises only lowercase canonical UUID-v4 names of the form `operation.lock.<uuid>`. A selected pathname becomes eligible only after no-follow observation proves a real, contained directory with stable BigInt identity. Files, symlinks, junctions, special entries, unreadable paths, and changed observations are preserved.

The fixed owner limit remains 4 KiB. A well-formed candidate owner is accepted only when its JSON bytes are the exact canonical three-field representation, its timestamp is canonical and bounded, its PID and token are bounded, and the token exactly equals the UUID in the directory name. That candidate is abandoned only when `process.kill(pid, 0)` positively reports `ESRCH`. A live PID, reused PID, `EPERM`, or any uncertain result is preserved regardless of age.

Missing or syntactically malformed single-link regular owner evidence becomes eligible only when the unchanged evidence is strictly older than the existing 5,000 ms grace boundary. Missing-owner age uses the stable directory modification time. Malformed-owner age uses the newer of the stable directory and owner-file modification times. An age of exactly 5,000 ms is preserved. Oversized owners are preserved because maintenance has no exact bounded bytes or digest for them. Hard-linked, linked, non-regular, unreadable, or otherwise ambiguous owner evidence is preserved. Any `owner.recovered.json` evidence is unsupported for a random candidate and is preserved.

## Exact reclaim protocol

Before reclamation, maintenance captures the directory identity, exact owner observation, missing recovery witness, and exact permitted child set: either empty or only `owner.json`. It then reobserves all evidence, recomputes the dead-owner or grace rule, and passes the exact observations to the existing quarantine primitive.

Quarantine rechecks current ownership immediately before rename. After moving the exact directory to a random sibling quarantine, it verifies the moved directory identity, exact child set, and exact owner/witness identities, metadata, and raw bytes, then reasserts the current fixed lock before unlinking anything. Extra children are never recursively removed. A same-path successor, token change, owner-file replacement, child-set change, directory replacement, or lost fixed-lock authority preserves the verified quarantine. If a post-move verification or unlink fails, the canonical candidate has still been safely reclaimed; the verified quarantine remains as bounded cleanup debt.

Candidate-local open, observation, sharing, quarantine, or cleanup failures for unrelated entries are best effort. They are suppressed only after both the cache location and exact current fixed lock remain authoritative, while every entry, inspection, and attempted quarantine still consumes its corresponding budget. The best-effort boundary never includes the fixed `operation.lock`, fixed `operation-lock.recovery`, current candidate, cache location, or SQLite gate: a failure of any of those invariants remains fail-closed with its existing subsystem error and precedence.

## Current candidate lifecycle

The current operation retains its exact directory and owner-file observation. Promotion verifies the exact owner bytes, identity, metadata, missing recovery witness, and exact child set immediately before and after rename. Release uses the same evidence rather than token equality alone. Final failed-acquisition cleanup uses only the originally captured directory; it never reopens the random pathname and adopts a replacement.

Maintenance runs after promotion and before the protected callback while the gate remains held. Its time does not reset the single 60-second acquisition deadline or change callback results, public errors, error precedence, cache schema, canonical data, or public API surface.

## Diagnostics and tests

One private per-call hook reports only frozen numeric/boolean statistics:

```ts
type LockCandidateMaintenanceStats = Readonly<{
  candidatesInspected: number
  candidatesReclaimed: number
  cursorExhausted: boolean
  directoryEntriesVisited: number
  reclamationAttempts: number
}>
```

Tests prove lazy 100,000-entry bounding, under-gate placement, cursor progress beyond a persistent inert prefix, abandonment before and after owner publication, live/ambiguous/extra-child preservation, exact token and identity replacement safety, bounded sharing failures, and unchanged operation results. Documentation states the exact budgets, process-local cursor lifetime, and unchanged public contract.
