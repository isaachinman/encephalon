# Durable Recovery Marker Phase Design

## Goal

Make completed operation-gate recovery durably visible to every process. If removal of `operation-lock.recovery` fails after the SQLite gate is usable and held, a later process must reclaim that exact completed marker without waiting for the original PID to exit.

## Compatibility boundaries

- The SQLite transaction remains the authoritative operation lock.
- Public APIs, success values, `CACHE_BUSY`, cache-coordination error codes, and safe error details remain unchanged.
- A recovery marker with legacy phase-less owner metadata is interpreted as `recovering`.
- A valid live `recovering` owner is never reclaimed because of age.
- Canonical records and the disposable SQLite cache format do not change.
- Tokens, PIDs, filesystem identities, owner bytes, and absolute paths remain absent from public errors.

## Owner lifecycle

Recovery `owner.json` uses the existing bounded token, PID, and canonical acquisition timestamp together with a phase enum:

```ts
type RecoveryPhase = 'recovering' | 'recovered'

type RecoveryOwner = {
  acquiredAt: string
  phase: RecoveryPhase
  pid: number
  token: string
}
```

Readers accept only the exact legacy three-key shape or the exact four-key phased shape. A phase-less legacy owner is normalised to `recovering`; unknown phases, extra keys, invalid bounds, non-canonical timestamps, partial JSON, and non-record values are never interpreted as `recovered`.

A newly created marker writes immutable explicit `recovering` metadata to `owner.json`. After a verified SQLite `BEGIN IMMEDIATE` succeeds and the marker's exact directory identity plus complete original owner file still match, the owner exclusively publishes `owner.recovered.json` with the same fields and `phase: 'recovered'`. A valid matching recovered witness is the cleanup commit point. It does not authorise entry into the protected operation by itself; the current process must still hold the SQLite transaction.

## Atomic publication

`cache-location.ts` owns the filesystem primitive. It never overwrites `owner.json`, because portable Node filesystem APIs do not provide a compare-and-swap rename and a check-then-rename could overwrite a successor owner. Instead it opens the bounded fixed `owner.recovered.json` with exclusive creation and no-follow semantics and writes one strict canonical recovered witness. Readers accept it only when its exact bytes, stable single-link regular-file identity, and fields match the exact explicit recovering owner and captured directory. Partial bytes, phase-less legacy owners, and identical-byte inode replacements are not accepted.

The completed witness file is flushed, followed by a capability-aware flush of the exact held containing directory. Only documented Windows directory-sync unsupported results may skip that second flush. The directory, immutable owner, and witness identities and bytes are revalidated afterward before publication succeeds. An existing witness is idempotent only when all of that exact evidence already matches; a partial or replaced witness is not adopted.

Publication returns an internal outcome that distinguishes no recovered evidence from exact recovered evidence that became visible before a later flush or verification error. A post-visibility error remains the current operation's primary failure: the operation never enters, exact witness-based cleanup is still attempted, and any cleanup error remains secondary. If cleanup also fails, the visible exact witness remains independently reclaimable by another process.

The fixed witness avoids unbounded filename accumulation. A process crash during its write can leave one partial witness beside the unchanged recovering owner, but strict canonical byte comparison never accepts it as recovered. Stale-marker quarantine recognises and safely removes that bounded no-follow regular file after first moving the exact directory to quarantine. A crash after durable validation leaves a complete recovered witness.

Publication never mutates or removes a changed owner. Because the witness repeats the original owner fields, any token, owner-file identity, owner bytes, phase, or owned-directory identity replacement makes it non-matching and preserves the successor. Exact identity is checked at every filesystem boundary.

## Observation and reclaim

Recovery observation classifies an exact explicit recovering owner plus exact matching recovered witness as stale regardless of PID liveness. Destructive reclaim captures both files and requires the same directory identities, file identities, raw canonical bytes, token, PID, timestamp, and phases. After moving the exact directory to quarantine, it revalidates those exact child snapshots before unlinking either file. A changed token, phase, owner or witness file, owner metadata, or directory identity is not deleted; the intact quarantine is retained and the identity change is reported.

An exact `recovering` or legacy phase-less owner is stale only under the established policy: its PID is no longer running, or malformed/ownerless metadata remains unchanged beyond the bounded stale interval. Wall-clock age never overrides a valid live recovering PID.

The process-local `abandonedRecoveryMarkers` map is removed as an authority. Once recovered publication succeeds, cleanup failure still fails the current public operation with the established error precedence, but the durable marker is cleanup debt and a same-process or different-process retry can reclaim it.

## Behavioural evidence

- A focused test first proves the existing same-process cleanup-failure case through the durable recovered phase, without an in-memory exception.
- A two-process test keeps process A alive after injected cleanup failure and proves process B enters within the test barrier while A remains alive.
- Active live recovering and phase-less legacy owners remain protected when time advances.
- Token, phase, and directory-identity replacements before publication or quarantine are preserved.
- A child terminated during recovered-witness publication leaves the immutable complete owner plus either an unaccepted partial witness or an exact complete witness; a successor converges without accepting partial state.
- Existing corrupt-gate confirmation, stale-owner, PID, sharing-violation, timeout, and non-overlap regressions continue to pass.

## Documentation impact

`docs/contract.md`, `README.md`, and `CHANGELOG.md` describe the durable recovery lifecycle and legacy interpretation. No package export or generated declaration changes are expected.
