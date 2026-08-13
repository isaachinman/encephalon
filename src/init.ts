import { parseInitInput } from './api-input.ts'
import { canonicalPayload, scanBaseline } from './baseline.ts'
import { hydrateResolvedRepository, prepareResolvedRepository } from './cache.ts'
import { EncephalonError, fail, wrapIo } from './errors.ts'
import { applyInstructionChangesOutcome, planInstructionChanges } from './instructions.ts'
import { withOperationLock } from './lock.ts'
import { ordinalStringCompare } from './order.ts'
import {
  assertCanonicalLayoutAdditions,
  assertRecordGraph,
  nextRecordCreatedAt,
  planRecordAddition,
  publishPlannedRecordOutcome,
  type RecordReadHooks,
  type RecordWriteHooks,
  readRecordSnapshotResolved,
} from './records.ts'
import { resolveRepository } from './repository.ts'
import { createRecordFile, validateAddRecordInput } from './schema.ts'
import type { AddRecordInput, BrainRecord, InitEncephalonInput, InitEncephalonResult, PrepareResult } from './types.ts'

const NEXT_ACTION =
  'Read ./node_modules/encephalon/skills/encephalon/SKILL.md and perform optional semantic enrichment for durable repository knowledge.'

type InitHooks = RecordReadHooks & {
  baselineScan?: () => void
  hydration?: (result: PrepareResult) => void
  instructionWriteHooks?: Parameters<typeof applyInstructionChangesOutcome>[2]
  lockHooks?: Parameters<typeof withOperationLock>[2]
  recordWriteHooks?: RecordWriteHooks
}

type InitPhase = 'preflight' | 'recordPublication' | 'cachePreparation' | 'instructionApplication' | 'operationCleanup'

type InitProgress = {
  phase: InitPhase
  committedRecordIds: string[]
  committedInstructionFiles: InitEncephalonResult['instructionFiles']
  cacheState: 'notAttempted' | 'disposable' | 'prepared'
}

type InitProgressDetails = InitProgress & {
  canonicalCommitted: boolean
  recoveryMode: 'rerun' | 'inspectAndRerun'
  recoveryAction: string
}

const recoveryActions = {
  cachePreparation: 'Run prepare, run validate, then repeat the same init operation with the same options.',
  inspectCachePreparation:
    'Inspect canonical state, run prepare, run validate, then repeat the same init operation with the same options.',
  inspectInstructions:
    'Inspect the reported canonical records, instruction files and recovery paths, then repeat the same init operation with the same options.',
  inspectOperationCleanup:
    'Inspect operation cleanup state, then repeat the same init operation with the same options.',
  inspectPreflight: 'Inspect the reported preflight state, then repeat the same init operation with the same options.',
  inspectRecords: 'Inspect the reported canonical records, then repeat the same init operation with the same options.',
  preflight: 'Resolve the reported preflight issue, then repeat the same init operation with the same options.',
  rerun: 'Repeat the same init operation with the same options.',
} as const

const inspectionRequired = (progress: InitProgress, error: EncephalonError) =>
  progress.phase === 'operationCleanup' ||
  error.code === 'INTERNAL_ERROR' ||
  error.code === 'REPOSITORY_CHANGED' ||
  error.details.canonicalCommitted === true ||
  error.details.instructionCommitted === true ||
  (Array.isArray(error.details.recoveryPaths) && error.details.recoveryPaths.length > 0)

const progressDetails = (progress: InitProgress, error: EncephalonError): InitProgressDetails => {
  const recoveryMode = inspectionRequired(progress, error) ? 'inspectAndRerun' : 'rerun'
  const recoveryAction = (() => {
    if (progress.phase === 'preflight') {
      return recoveryMode === 'inspectAndRerun' ? recoveryActions.inspectPreflight : recoveryActions.preflight
    }
    if (progress.phase === 'cachePreparation') {
      return recoveryMode === 'inspectAndRerun'
        ? recoveryActions.inspectCachePreparation
        : recoveryActions.cachePreparation
    }
    if (progress.phase === 'operationCleanup') {
      return recoveryActions.inspectOperationCleanup
    }
    if (recoveryMode === 'inspectAndRerun' && progress.phase === 'instructionApplication') {
      return recoveryActions.inspectInstructions
    }
    if (recoveryMode === 'inspectAndRerun') {
      return recoveryActions.inspectRecords
    }
    return recoveryActions.rerun
  })()
  return {
    cacheState: progress.cacheState,
    canonicalCommitted: progress.committedRecordIds.length > 0,
    committedInstructionFiles: [...progress.committedInstructionFiles],
    committedRecordIds: [...progress.committedRecordIds],
    phase: progress.phase,
    recoveryAction,
    recoveryMode,
  }
}

const decorateInitError = (progress: InitProgress, error: EncephalonError) =>
  new EncephalonError(
    error.code,
    error.message,
    {
      ...error.details,
      initProgress: progressDetails(progress, error),
    },
    { cause: error.cause },
  )

const wrapInitError = (error: unknown): EncephalonError => {
  try {
    return wrapIo('Unable to initialise Encephalon.', error)
  } catch (wrappedError) {
    if (wrappedError instanceof EncephalonError) {
      return wrappedError
    }
    throw wrappedError
  }
}

const activeRecords = (records: BrainRecord[]) => {
  const superseded = new Set(records.flatMap(record => record.supersedes ?? []))
  return records.filter(record => !superseded.has(record.id))
}

const baselineActions = (records: BrainRecord[], baseline: AddRecordInput[], refresh: boolean) =>
  baseline.reduce<{
    additions: AddRecordInput[]
    conflicts: InitEncephalonResult['skippedConflicts']
  }>(
    (result, candidate) => {
      const matching = activeRecords(records).filter(
        record => record.kind === candidate.kind && record.subject === candidate.subject,
      )
      if (matching.length === 0) {
        return { ...result, additions: [...result.additions, candidate] }
      }
      const generated = matching.every(record => record.source === 'encephalon:init')
      if (!generated) {
        return {
          ...result,
          conflicts: [
            ...result.conflicts,
            {
              activeRecordIds: matching.map(record => record.id).sort(ordinalStringCompare),
              kind: candidate.kind,
              subject: candidate.subject,
            },
          ],
        }
      }
      if (
        refresh &&
        (matching.length > 1 ||
          matching.some(record => canonicalPayload(record.payload) !== canonicalPayload(candidate.payload)))
      ) {
        return {
          ...result,
          additions: [
            ...result.additions,
            {
              ...candidate,
              supersedes: matching.map(record => record.id).sort(ordinalStringCompare),
            },
          ],
        }
      }
      return result
    },
    { additions: [], conflicts: [] },
  )

const initResolved = (
  input: InitEncephalonInput,
  progress: InitProgress,
  hooks: InitHooks = {},
): InitEncephalonResult => {
  if (input.remove === true && input.refreshBaseline === true) {
    return fail('INVALID_ARGUMENT', 'init cannot refresh and remove managed instructions in the same operation.')
  }
  const root = resolveRepository(input)
  planInstructionChanges(root, input.remove === true)

  if (input.remove === true) {
    return withOperationLock(
      root,
      () => {
        const instructionPlans = planInstructionChanges(root, true)
        progress.phase = 'instructionApplication'
        const instructionOutcome = applyInstructionChangesOutcome(root, instructionPlans, hooks.instructionWriteHooks)
        progress.committedInstructionFiles = [...instructionOutcome.instructionFiles]
        if (instructionOutcome.error !== undefined) {
          throw instructionOutcome.error
        }
        progress.phase = 'operationCleanup'
        return {
          instructionFiles: instructionOutcome.instructionFiles,
          nextAction: NEXT_ACTION,
          recordsCreated: [],
          skippedConflicts: [],
        }
      },
      hooks.lockHooks,
    )
  }

  return withOperationLock(
    root,
    location => {
      const instructionPlans = planInstructionChanges(root, false)
      hooks.baselineScan?.()
      const baseline = scanBaseline(root)
      const refresh = input.refreshBaseline === true
      const recordSnapshot = readRecordSnapshotResolved(
        root,
        hooks,
        refresh
          ? baseline.map(candidate => ({
              kind: candidate.kind,
              source: 'encephalon:init',
              subject: candidate.subject,
            }))
          : undefined,
      )
      const { records } = recordSnapshot
      const actions = baselineActions(records, baseline, refresh)
      const { plans } = actions.additions.reduce<{
        cursor: BrainRecord[]
        plans: ReturnType<typeof planRecordAddition>[]
      }>(
        (result, addition) => {
          const recordFile = createRecordFile(
            validateAddRecordInput({ ...addition, root }),
            nextRecordCreatedAt(result.cursor),
          )
          const plan = planRecordAddition(root, recordFile)
          return { cursor: [...result.cursor, plan.record], plans: [...result.plans, plan] }
        },
        { cursor: records, plans: [] },
      )
      let recordsCreated: BrainRecord[] = []
      if (plans.length > 0) {
        assertRecordGraph(
          root,
          [...records, ...plans.map(plan => plan.record)],
          'The generated baseline would make canonical records invalid.',
          hooks,
        )
        const authority = assertCanonicalLayoutAdditions(
          plans.map(plan => plan.record.kind),
          recordSnapshot.authority,
        )
        const recordWriteOptions = {
          authority,
          ...(hooks.recordWriteHooks === undefined ? {} : { hooks: hooks.recordWriteHooks }),
        }
        progress.phase = 'recordPublication'
        for (const plan of plans) {
          const publication = publishPlannedRecordOutcome(root, plan, recordWriteOptions)
          recordsCreated = [...recordsCreated, publication.record]
          progress.committedRecordIds = [...progress.committedRecordIds, publication.record.id]
          progress.cacheState = 'disposable'
          if (publication.committedError !== undefined) {
            throw publication.committedError
          }
        }
      }
      progress.phase = 'cachePreparation'
      progress.cacheState = 'disposable'
      const cacheResult =
        plans.length > 0
          ? hydrateResolvedRepository(root, false, location)
          : prepareResolvedRepository(root, false, location)
      progress.cacheState = 'prepared'
      hooks.hydration?.(cacheResult)
      progress.phase = 'instructionApplication'
      const instructionOutcome = applyInstructionChangesOutcome(root, instructionPlans, hooks.instructionWriteHooks)
      progress.committedInstructionFiles = [...instructionOutcome.instructionFiles]
      if (instructionOutcome.error !== undefined) {
        throw instructionOutcome.error
      }
      progress.phase = 'operationCleanup'
      return {
        instructionFiles: instructionOutcome.instructionFiles,
        nextAction: NEXT_ACTION,
        recordsCreated,
        skippedConflicts: actions.conflicts,
      }
    },
    hooks.lockHooks,
  )
}

const runInit = (input: InitEncephalonInput, hooks: InitHooks = {}): InitEncephalonResult => {
  const progress: InitProgress = {
    cacheState: 'notAttempted',
    committedInstructionFiles: [],
    committedRecordIds: [],
    phase: 'preflight',
  }
  try {
    return initResolved(parseInitInput(input), progress, hooks)
  } catch (error) {
    if (error instanceof EncephalonError) {
      throw decorateInitError(progress, error)
    }
    throw decorateInitError(progress, wrapInitError(error))
  }
}

export const initEncephalon = (input: InitEncephalonInput = {}): InitEncephalonResult => runInit(input)

/** @internal */
export const initEncephalonWithHooks = (input: InitEncephalonInput = {}, hooks: InitHooks = {}): InitEncephalonResult =>
  runInit(input, hooks)
