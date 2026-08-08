import { canonicalPayload, scanBaseline } from './baseline.ts'
import { hydrateResolvedRepository } from './cache.ts'
import { EncephalonError, fail, wrapIo } from './errors.ts'
import { applyInstructionChanges, planInstructionChanges } from './instructions.ts'
import { withOperationLock } from './lock.ts'
import { ordinalStringCompare } from './order.ts'
import { addRecordResolved, readRecords } from './records.ts'
import { resolveRepository } from './repository.ts'
import type { AddRecordInput, BrainRecord, InitEncephalonInput, InitEncephalonResult } from './types.ts'

const NEXT_ACTION =
  'Read ./node_modules/encephalon/skills/encephalon/SKILL.md and perform optional semantic enrichment for durable repository knowledge.'

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
        matching.some(record => canonicalPayload(record.payload) !== canonicalPayload(candidate.payload))
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

const initResolved = (input: InitEncephalonInput): InitEncephalonResult => {
  if (input.remove === true && input.refreshBaseline === true) {
    return fail('INVALID_ARGUMENT', 'init cannot refresh and remove managed instructions in the same operation.')
  }
  const root = resolveRepository(input)
  planInstructionChanges(root, input.remove === true)

  if (input.remove === true) {
    return withOperationLock(root, () => ({
      instructionFiles: applyInstructionChanges(root, planInstructionChanges(root, true)),
      nextAction: NEXT_ACTION,
      recordsCreated: [],
      skippedConflicts: [],
    }))
  }

  readRecords({ root })
  return withOperationLock(root, () => {
    const instructionPlans = planInstructionChanges(root, false)
    const actions = baselineActions(readRecords({ root }), scanBaseline(root), input.refreshBaseline === true)
    const recordsCreated = actions.additions.map(addition =>
      addRecordResolved(root, { ...addition, root }, { hydrate: false }),
    )
    hydrateResolvedRepository(root, false)
    const instructionFiles = applyInstructionChanges(root, instructionPlans)
    return {
      instructionFiles,
      nextAction: NEXT_ACTION,
      recordsCreated,
      skippedConflicts: actions.conflicts,
    }
  })
}

export const initEncephalon = (input: InitEncephalonInput = {}): InitEncephalonResult => {
  try {
    return initResolved(input)
  } catch (error) {
    if (error instanceof EncephalonError) {
      throw error
    }
    return wrapIo('Unable to initialise Encephalon.', error)
  }
}
