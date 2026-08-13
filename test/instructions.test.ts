import assert from 'node:assert/strict'
import { closeSync } from 'node:fs'
import { afterEach, describe, test } from 'node:test'
import * as api from '../src/index.ts'
import { applyInstructionChangesOutcome, planInstructionChanges } from '../src/instructions.ts'
import { createTestRepository, removeTestRepository } from '../test/helpers.ts'

const roots: string[] = []

const createRoot = () => {
  const root = createTestRepository()
  roots.push(root)
  return root
}

const createDeletePlan = (root: string) => {
  api.initEncephalon({ root })
  const [agentsPlan] = planInstructionChanges(root, true)
  assert.equal(agentsPlan?.action, 'delete')
  return agentsPlan
}

afterEach(() => {
  roots.splice(0).forEach(removeTestRepository)
})

describe('instruction apply outcomes', () => {
  test('retains an earlier action when a later file fails before commit', () => {
    const root = createRoot()
    const plans = planInstructionChanges(root, false)

    const outcome = applyInstructionChangesOutcome(root, plans, {
      fault: (point, generatedPath) => {
        if (point === 'after-temp-create' && generatedPath?.includes('.CLAUDE.md.')) {
          throw Object.assign(new Error('Injected second-file pre-commit failure'), {
            code: 'EIO',
          })
        }
      },
    })

    assert.deepEqual(outcome.instructionFiles, [{ action: 'updated', file: 'AGENTS.md' }])
    assert.equal(outcome.error?.code, 'IO_ERROR')
  })

  test('includes the current post-commit action exactly once', () => {
    const root = createRoot()
    const [agentsPlan] = planInstructionChanges(root, false)
    assert.ok(agentsPlan)

    const outcome = applyInstructionChangesOutcome(root, [agentsPlan], {
      fault: point => {
        if (point === 'after-publication') {
          throw Object.assign(new Error('Injected current-file post-commit failure'), {
            code: 'EIO',
          })
        }
      },
    })

    assert.deepEqual(outcome.instructionFiles, [{ action: 'updated', file: 'AGENTS.md' }])
    assert.equal(outcome.error?.code, 'IO_ERROR')
  })

  test('reports committed removal when root close fails', {
    skip: process.platform === 'win32' ? 'Windows does not hold a repository-root directory descriptor.' : false,
  }, () => {
    const root = createRoot()
    const agentsPlan = createDeletePlan(root)

    const outcome = applyInstructionChangesOutcome(root, [agentsPlan], {
      rootClose: descriptor => {
        closeSync(descriptor)
        throw Object.assign(new Error('Injected deletion root descriptor close failure'), {
          code: 'EIO',
        })
      },
    })

    assert.deepEqual(outcome.instructionFiles, [{ action: 'removed', file: 'AGENTS.md' }])
    assert.ok(outcome.error)
    assert.equal(outcome.error.details.instructionCommitted, true)
    assert.equal(outcome.error.details.postCommitPhase, 'resourceCleanup')
  })
})
