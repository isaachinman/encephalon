import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import {
  appendFileSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  type DescriptorIoObservation,
  type ExternalReferenceObservation,
  formatWorkflowPolicyFindings,
  inspectWorkflowPolicy,
  isContainedComparablePath,
  parseWorkflowDocument,
  readValidatedNativeFile,
  workflowPolicyLimits,
} from './workflow-policy.ts'

const temporaryRoots: string[] = []
const policyPath = fileURLToPath(new URL('./workflow-policy.ts', import.meta.url))
const repositoryRoot = fileURLToPath(new URL('..', import.meta.url))
const directorySymlinkType = process.platform === 'win32' ? 'junction' : 'dir'
const windowsOnlyTest = process.platform === 'win32' ? test : test.skip
const posixOnlyTest = process.platform === 'win32' ? test.skip : test
const posixFifoTest = (() => {
  if (process.platform === 'win32') {
    return test.skip
  }
  const root = mkdtempSync(join(tmpdir(), 'encephalon-workflow-fifo-capability-test-'))
  try {
    return spawnSync('mkfifo', [join(root, 'fifo')]).status === 0 ? test : test.skip
  } finally {
    rmSync(root, { force: true, recursive: true })
  }
})()

type PullfrogStep = Record<string, unknown> & {
  env?: unknown
  name?: unknown
  uses?: unknown
  with?: unknown
}

type PullfrogJob = Record<string, unknown> & {
  environment?: unknown
  permissions?: unknown
  steps: PullfrogStep[]
}

type PullfrogWorkflow = Record<string, unknown> & {
  jobs: Record<string, PullfrogJob> & { pullfrog: PullfrogJob }
  name?: unknown
  permissions?: unknown
  'run-name'?: unknown
  on?: unknown
}

type WorkflowStep = Readonly<{
  uses?: unknown
  with?: Readonly<Record<string, unknown>>
}>

type CiWorkflow = Readonly<{
  jobs: Readonly<{
    release: Readonly<{ steps: readonly WorkflowStep[] }>
    verify: Readonly<{ steps: readonly WorkflowStep[] }>
  }>
}>

const assertExactPullfrogJob = (job: PullfrogJob) => {
  assert.deepEqual(Object.keys(job).toSorted(), ['environment', 'permissions', 'runs-on', 'steps'])
  assert.equal(job['runs-on'], 'ubuntu-latest')
  assert.equal(job.environment, 'pullfrog-review')
  assert.deepEqual(job.permissions, {
    contents: 'read',
    'id-token': 'write',
  })
  assert.equal(job.steps.length, 2)

  const [checkoutStep, pullfrogStep] = job.steps
  assert.deepEqual(Object.keys(checkoutStep ?? {}).toSorted(), ['name', 'uses', 'with'])
  assert.equal(checkoutStep?.name, 'Checkout code')
  assert.equal(checkoutStep?.uses, 'actions/checkout@d23441a48e516b6c34aea4fa41551a30e30af803')
  assert.deepEqual(checkoutStep?.with, {
    'fetch-depth': 1,
    'persist-credentials': false,
  })

  assert.deepEqual(Object.keys(pullfrogStep ?? {}).toSorted(), ['env', 'name', 'uses', 'with'])
  assert.equal(pullfrogStep?.name, 'Run agent')
  assert.equal(pullfrogStep?.uses, 'pullfrog/pullfrog@c4d0ca6f15d12382ddd20d2010bc596b405f42f0')
  assert.deepEqual(pullfrogStep?.with, {
    prompt: `${'$'}{{ inputs.prompt }}`,
    push: 'disabled',
  })
  assert.deepEqual(pullfrogStep?.env, {
    PULLFROG_FORCE_LOCAL_CLI: '1',
  })
}

const assertExactPullfrogWorkflow = (workflow: PullfrogWorkflow) => {
  assert.deepEqual(Object.keys(workflow).toSorted(), ['jobs', 'name', 'on', 'permissions', 'run-name'])
  assert.equal(workflow.name, 'Pullfrog')
  assert.equal(workflow['run-name'], `${'$'}{{ inputs.name || github.workflow }}`)
  assert.deepEqual(workflow.permissions, { contents: 'read' })
  assert.deepEqual(workflow.on, {
    workflow_dispatch: {
      inputs: {
        name: {
          description: 'Run name',
          type: 'string',
        },
        prompt: {
          description: 'Agent prompt',
          type: 'string',
        },
      },
    },
  })
  assert.deepEqual(Object.keys(workflow.jobs), ['pullfrog'])
  assertExactPullfrogJob(workflow.jobs.pullfrog)
}

const createFixture = (files: Readonly<Record<string, string>>) => {
  const root = mkdtempSync(join(tmpdir(), 'encephalon-workflow-policy-test-'))
  temporaryRoots.push(root)
  for (const [file, contents] of Object.entries(files)) {
    const path = join(root, file)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, contents, 'utf8')
  }
  return root
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { force: true, recursive: true })
  }
})

// Mutation caught: always appending a slash to the comparable root rejects children of POSIX, drive, and UNC roots.
test('contains comparable root children without accepting sibling prefixes', () => {
  assert.equal(isContainedComparablePath('/', '/repository/workflow.yml'), true)
  assert.equal(isContainedComparablePath('c:/', 'c:/repository/workflow.yml'), true)
  assert.equal(isContainedComparablePath('//server/share/', '//server/share/repository/workflow.yml'), true)
  assert.equal(isContainedComparablePath('/repository', '/repository'), true)
  assert.equal(isContainedComparablePath('/repository', '/repository-sibling/workflow.yml'), false)
  assert.equal(isContainedComparablePath('c:/repository', 'c:/repository-sibling/workflow.yml'), false)
  assert.equal(
    isContainedComparablePath('//server/share/repository', '//server/share/repository-sibling/workflow.yml'),
    false,
  )
})

// Mutation caught: swallowing every discovery failure, or rejecting absence, would make missing and invalid workflow paths equivalent.
test('treats only an absent workflow directory as an empty workflow set', () => {
  const absentGithubRoot = createFixture({
    'README.md': 'No workflows\n',
  })
  const absentWorkflowsRoot = createFixture({
    '.github/placeholder': 'No workflows\n',
  })
  const root = createFixture({
    '.github/workflows': 'not a directory\n',
  })

  assert.deepEqual(inspectWorkflowPolicy(absentGithubRoot), [])
  assert.deepEqual(inspectWorkflowPolicy(absentWorkflowsRoot), [])
  assert.deepEqual(inspectWorkflowPolicy(root), [
    {
      file: '.github/workflows',
      location: '$',
      rule: 'source-integrity',
    },
  ])
})

// Mutation caught: leaving root realpath errors unguarded would expose filesystem exceptions instead of policy diagnostics.
test('reports an invalid missing repository root as a source-integrity finding', () => {
  const root = createFixture({
    'README.md': 'fixture\n',
  })

  assert.deepEqual(inspectWorkflowPolicy(join(root, 'missing-root')), [
    {
      file: '.github/workflows',
      location: '$',
      rule: 'source-integrity',
    },
  ])
})

// Mutation caught: drifting a production default would silently weaken or over-constrain the reviewed policy bounds.
test('keeps the exact production workflow policy limits', () => {
  assert.deepEqual(workflowPolicyLimits, {
    maximumAggregateSourceBytes: 4 * 1024 * 1024,
    maximumSecretTreeNodes: 16_384,
    maximumSourceBytes: 256 * 1024,
    maximumSourceVisits: 512,
    maximumWorkflowDirectoryEntries: 256,
  })
})

// Mutation caught: filtering before counting would let arbitrary raw workflow-directory entries evade the source bound.
test('accepts the exact raw workflow-entry limit and rejects one over', () => {
  const root = createFixture({
    '.github/workflows/a.txt': 'data\n',
    '.github/workflows/b.txt': 'data\n',
    '.github/workflows/valid.yml': `name: Valid
on: workflow_dispatch
permissions:
  contents: read
jobs: {}
`,
  })

  assert.deepEqual(
    inspectWorkflowPolicy(root, {
      limits: { maximumWorkflowDirectoryEntries: 3 },
    }),
    [],
  )
  assert.deepEqual(inspectWorkflowPolicy(root, { limits: { maximumWorkflowDirectoryEntries: 2 } }), [
    {
      file: '.github/workflows',
      location: '$',
      rule: 'source-integrity',
    },
  ])
})

// Mutation caught: an unbounded descriptor read would accept one byte beyond the per-source limit.
test('accepts the exact per-source byte limit and rejects one over', () => {
  const source = `name: Bounded
on: workflow_dispatch
permissions:
  contents: read
jobs: {}
`
  const sourceBytes = Buffer.byteLength(source)
  const root = createFixture({
    '.github/workflows/bounded.yml': source,
  })

  assert.deepEqual(inspectWorkflowPolicy(root, { limits: { maximumSourceBytes: sourceBytes } }), [])
  assert.deepEqual(inspectWorkflowPolicy(root, { limits: { maximumSourceBytes: sourceBytes - 1 } }), [
    {
      file: '.github/workflows',
      location: '$',
      rule: 'source-integrity',
    },
  ])
})

// Mutation caught: allocating or requesting a sentinel byte would cross the supplied descriptor allowance on growth.
test('keeps allocation, read requests, and transferred bytes within the exact source allowance', () => {
  const source = `name: Growing
permissions:
  contents: read
jobs: {}
`
  const sourceBytes = Buffer.byteLength(source)
  const root = createFixture({ 'source.yml': source })
  const nativeRoot = realpathSync.native(root)
  const sourcePath = join(nativeRoot, 'source.yml')
  const observations: DescriptorIoObservation[] = []
  let grew = false

  const validated = readValidatedNativeFile(nativeRoot, sourcePath, {
    maximumBytes: sourceBytes,
    onDescriptorIo: observation => {
      observations.push(observation)
      if (observation.kind === 'read' && !grew) {
        grew = true
        appendFileSync(sourcePath, 'x')
      }
    },
  })

  assert.equal(grew, true)
  assert.deepEqual(validated, { kind: 'invalid' })
  assert.deepEqual(observations, [
    { allocatedBytes: sourceBytes, kind: 'allocation' },
    { bytesRead: sourceBytes, kind: 'read', requestedBytes: sourceBytes },
  ])
})

// Mutation caught: a blocking descriptor open would hang before rejecting a FIFO substituted after source realpath.
posixFifoTest('does not block when a workflow source is replaced by a FIFO before descriptor open', () => {
  const root = createFixture({
    '.github/workflows/fifo.yml': `name: FIFO replacement
on: workflow_dispatch
permissions:
  contents: read
jobs: {}
`,
  })
  const script = `
    import { spawnSync } from 'node:child_process'
    import { realpathSync, renameSync } from 'node:fs'
    import { join } from 'node:path'
    import { inspectWorkflowPolicy } from ${JSON.stringify(new URL('./workflow-policy.ts', import.meta.url).href)}
    const root = process.argv[1]
    const sourcePath = join(realpathSync.native(root), '.github/workflows/fifo.yml')
    let fifoCreated = false
    let replaced = false
    const findings = inspectWorkflowPolicy(root, {
      afterSourceInitialRealpath: path => {
        if (path === sourcePath && !replaced) {
          replaced = true
          renameSync(path, \`\${path}.original\`)
          const result = spawnSync('mkfifo', [path])
          fifoCreated = result.status === 0
          if (!fifoCreated) throw result.error ?? new Error('mkfifo failed')
        }
      },
    })
    process.stdout.write(JSON.stringify({ fifoCreated, findings, replaced }))
  `

  const child = spawnSync(process.execPath, ['--input-type=module', '--eval', script, root], {
    encoding: 'utf8',
    timeout: 2000,
  })

  assert.equal(child.error, undefined)
  assert.equal(child.status, 0, child.stderr)
  assert.deepEqual(JSON.parse(child.stdout), {
    fifoCreated: true,
    findings: [{ file: '.github/workflows', location: '$', rule: 'source-integrity' }],
    replaced: true,
  })
})

// Mutation caught: applying the aggregate limit after reading would transfer the second source's overflowing byte.
test('accepts an exact multi-source aggregate and does not read a source one byte over', () => {
  const firstSource = `name: First
on: workflow_dispatch
permissions:
  contents: read
jobs: {}
`
  const secondSource = `name: Second
on: workflow_dispatch
permissions:
  contents: read
jobs: {}
`
  const firstBytes = Buffer.byteLength(firstSource)
  const secondBytes = Buffer.byteLength(secondSource)
  const aggregateBytes = firstBytes + secondBytes
  const root = createFixture({
    '.github/workflows/a.yml': firstSource,
    '.github/workflows/b.yml': secondSource,
  })
  const nativeRoot = realpathSync.native(root)
  const firstPath = join(nativeRoot, '.github/workflows/a.yml')
  const secondPath = join(nativeRoot, '.github/workflows/b.yml')
  const exactObservations: Readonly<{ observation: DescriptorIoObservation; path: string }>[] = []

  assert.deepEqual(
    inspectWorkflowPolicy(root, {
      limits: { maximumAggregateSourceBytes: aggregateBytes },
      onSourceDescriptorIo: (path, observation) => {
        exactObservations.push({ observation, path })
      },
    }),
    [],
  )
  assert.deepEqual(exactObservations, [
    { observation: { allocatedBytes: firstBytes, kind: 'allocation' }, path: firstPath },
    { observation: { bytesRead: firstBytes, kind: 'read', requestedBytes: firstBytes }, path: firstPath },
    { observation: { allocatedBytes: secondBytes, kind: 'allocation' }, path: secondPath },
    { observation: { bytesRead: secondBytes, kind: 'read', requestedBytes: secondBytes }, path: secondPath },
  ])

  const overflowObservations: Readonly<{ observation: DescriptorIoObservation; path: string }>[] = []
  assert.deepEqual(
    inspectWorkflowPolicy(root, {
      limits: { maximumAggregateSourceBytes: aggregateBytes - 1 },
      onSourceDescriptorIo: (path, observation) => {
        overflowObservations.push({ observation, path })
      },
    }),
    [
      {
        file: '.github/workflows',
        location: '$',
        rule: 'source-integrity',
      },
    ],
  )
  assert.deepEqual(overflowObservations, [
    { observation: { allocatedBytes: firstBytes, kind: 'allocation' }, path: firstPath },
    { observation: { bytesRead: firstBytes, kind: 'read', requestedBytes: firstBytes }, path: firstPath },
  ])
})

// Mutation caught: treating zero remaining bytes as automatic overflow would reject an empty reachable source globally.
test('accepts an empty source when the preceding workflow exactly consumes the aggregate allowance', () => {
  const workflow = `name: Exact aggregate
on: workflow_dispatch
permissions:
  contents: read
jobs:
  verify:
    runs-on: ubuntu-latest
    steps:
      - uses: $/.github/actions/empty
`
  const workflowBytes = Buffer.byteLength(workflow)
  const root = createFixture({
    '.github/actions/empty/action.yml': '',
    '.github/workflows/exact.yml': workflow,
  })
  const nativeRoot = realpathSync.native(root)
  const workflowPath = join(nativeRoot, '.github/workflows/exact.yml')
  const emptyActionPath = join(nativeRoot, '.github/actions/empty/action.yml')
  const observations: Readonly<{ observation: DescriptorIoObservation; path: string }>[] = []

  assert.deepEqual(
    inspectWorkflowPolicy(root, {
      limits: { maximumAggregateSourceBytes: workflowBytes },
      onSourceDescriptorIo: (path, observation) => {
        observations.push({ observation, path })
      },
    }),
    [
      {
        file: '.github/actions/empty/action.yml',
        location: '$',
        rule: 'source-integrity',
      },
    ],
  )
  assert.deepEqual(observations, [
    { observation: { allocatedBytes: workflowBytes, kind: 'allocation' }, path: workflowPath },
    { observation: { bytesRead: workflowBytes, kind: 'read', requestedBytes: workflowBytes }, path: workflowPath },
    { observation: { allocatedBytes: 0, kind: 'allocation' }, path: emptyActionPath },
  ])
})

// Mutation caught: reserving visits after traversal would retain a provisional pin finding when unique source work overflows.
test('accepts the exact unique role-visit limit and discards provisional findings on overflow', () => {
  const root = createFixture({
    '.github/actions/checked/action.yml': `name: Checked
runs:
  using: composite
  steps: []
`,
    '.github/workflows/entry.yml': `name: Entry
on: workflow_dispatch
permissions:
  contents: read
jobs:
  verify:
    runs-on: ubuntu-latest
    steps:
      - uses: owner/action@v1
      - uses: $/.github/actions/checked
`,
  })

  assert.deepEqual(inspectWorkflowPolicy(root, { limits: { maximumSourceVisits: 2 } }), [
    {
      file: '.github/workflows/entry.yml',
      location: 'jobs.verify.steps[0].uses',
      rule: 'external-reference-sha',
    },
  ])
  assert.deepEqual(inspectWorkflowPolicy(root, { limits: { maximumSourceVisits: 1 } }), [
    {
      file: '.github/workflows',
      location: '$',
      rule: 'source-integrity',
    },
  ])
})

// Mutation caught: resetting the budget between secret and executable traversal would exceed the documented shared ceiling.
test('accepts the exact combined parsed-tree work limit and rejects one over', () => {
  const root = createFixture({
    '.github/workflows/tree.yml': `name: Tree
on: workflow_dispatch
permissions:
  contents: read
jobs:
  verify:
    runs-on: ubuntu-latest
    steps: []
`,
  })

  assert.deepEqual(inspectWorkflowPolicy(root, { limits: { maximumSecretTreeNodes: 4 } }), [])
  assert.deepEqual(inspectWorkflowPolicy(root, { limits: { maximumSecretTreeNodes: 3 } }), [
    {
      file: '.github/workflows',
      location: '$',
      rule: 'source-integrity',
    },
  ])
})

// Mutation caught: allocating each discovered source a fresh executable budget would let aggregate parsed-tree work overflow.
test('shares the combined parsed-tree work limit across discovered sources', () => {
  const root = createFixture({
    '.github/actions/checked/action.yml': `name: Checked
runs:
  using: composite
  steps:
    - uses: owner/action@0123456789abcdef0123456789abcdef01234567
`,
    '.github/workflows/tree.yml': `name: Tree
on: workflow_dispatch
permissions:
  contents: read
jobs:
  verify:
    runs-on: ubuntu-latest
    steps:
      - uses: $/.github/actions/checked
`,
  })

  assert.deepEqual(inspectWorkflowPolicy(root, { limits: { maximumSecretTreeNodes: 9 } }), [])
  assert.deepEqual(inspectWorkflowPolicy(root, { limits: { maximumSecretTreeNodes: 8 } }), [
    {
      file: '.github/workflows',
      location: '$',
      rule: 'source-integrity',
    },
  ])
})

// Mutation caught: removing recursive local-reference traversal would let a nested composite action hide an unpinned action.
test('recursively inspects local actions while accepting a fully pinned external action', () => {
  const root = createFixture({
    '.github/actions/checked/action.yml': `name: Checked
runs:
  using: composite
  steps:
    - uses: owner/action@0123456789abcdef0123456789abcdef01234567
    - uses: $/.github/actions/nested
`,
    '.github/actions/nested/action.yaml': `name: Nested
runs:
  using: composite
  steps:
    - uses: owner/action@v1
`,
    '.github/workflows/fixture.yml': `name: Fixture
on: workflow_dispatch
permissions:
  contents: read
jobs:
  verify:
    runs-on: ubuntu-latest
    steps:
      - uses: $/.github/actions/checked
`,
  })

  assert.deepEqual(inspectWorkflowPolicy(root), [
    {
      file: '.github/actions/nested/action.yaml',
      location: 'runs.steps[0].uses',
      rule: 'external-reference-sha',
    },
  ])
})

// Mutation caught: recursive source calls exhaust the JavaScript stack before a long bounded unique chain is inspected.
test('iteratively inspects a long unique local-action chain', () => {
  const chainLength = 5000
  let activeVisits = 0
  let maximumActiveVisits = 0
  let sourceVisits = 0
  const actionFiles = Object.fromEntries(
    Array.from({ length: chainLength }, (_, index) => {
      const name = `chain-${String(index).padStart(4, '0')}`
      const nextReference =
        index + 1 < chainLength ? `$/.github/actions/chain-${String(index + 1).padStart(4, '0')}` : 'owner/action@v1'
      return [
        `.github/actions/${name}/action.yml`,
        `name: ${name}
runs:
  using: composite
  steps:
    - uses: ${nextReference}
`,
      ]
    }),
  )
  const root = createFixture({
    ...actionFiles,
    '.github/workflows/entry.yml': `name: Entry
on: workflow_dispatch
permissions:
  contents: read
jobs:
  verify:
    runs-on: ubuntu-latest
    steps:
      - uses: $/.github/actions/chain-0000
`,
  })

  assert.deepEqual(
    inspectWorkflowPolicy(root, {
      limits: {
        maximumAggregateSourceBytes: 8 * 1024 * 1024,
        maximumSourceBytes: 1024,
        maximumSourceVisits: chainLength + 1,
      },
      onSourceVisit: phase => {
        if (phase === 'enter') {
          activeVisits += 1
          sourceVisits += 1
          maximumActiveVisits = Math.max(maximumActiveVisits, activeVisits)
        } else {
          activeVisits -= 1
        }
      },
    }),
    [
      {
        file: '.github/actions/chain-4999/action.yml',
        location: 'runs.steps[0].uses',
        rule: 'external-reference-sha',
      },
    ],
  )
  assert.equal(sourceVisits, chainLength + 1)
  assert.equal(maximumActiveVisits, 1)
  assert.equal(activeVisits, 0)
})

// Mutation caught: keying recursive visits by path alone would skip either the workflow jobs or composite-action steps of one dual-role source.
test('inspects one source independently as a reusable workflow and composite action', () => {
  const root = createFixture({
    '.github/workflows/action.yml': `name: Dual role
on: workflow_call
permissions:
  contents: read
jobs:
  inspect:
    runs-on: ubuntu-latest
    steps:
      - run: echo "\${{ secrets.TOKEN }}"
runs:
  using: composite
  steps:
    - uses: owner/action@v1
`,
    '.github/workflows/entry.yml': `name: Entry
on: workflow_dispatch
permissions:
  contents: read
jobs:
  call:
    uses: ./.github/workflows/action.yml
  verify:
    runs-on: ubuntu-latest
    steps:
      - uses: $/.github/workflows
`,
  })

  assert.deepEqual(inspectWorkflowPolicy(root), [
    {
      file: '.github/workflows/action.yml',
      location: 'jobs.inspect.environment',
      rule: 'credential-environment',
    },
    {
      file: '.github/workflows/action.yml',
      location: 'runs.steps[0].uses',
      rule: 'external-reference-sha',
    },
  ])
})

// Mutation caught: accepting parsed findings without final file revalidation would return a decision from replaced workflow bytes.
test('rejects a workflow replaced after traversal and discards provisional findings', () => {
  const root = createFixture({
    '.github/workflows/mutable.yml': `name: Mutable
on: workflow_dispatch
permissions:
  contents: read
jobs:
  verify:
    runs-on: ubuntu-latest
    steps:
      - uses: owner/action@v1
`,
  })
  let finalRevalidationCalls = 0

  const findings = inspectWorkflowPolicy(root, {
    beforeFinalRevalidation: () => {
      finalRevalidationCalls += 1
      writeFileSync(
        join(root, '.github/workflows/mutable.yml'),
        `name: Replacement
on: workflow_dispatch
permissions:
  contents: read
jobs: {}
`,
        'utf8',
      )
    },
  })

  assert.equal(finalRevalidationCalls, 1)
  assert.deepEqual(findings, [
    {
      file: '.github/workflows',
      location: '$',
      rule: 'source-integrity',
    },
  ])
})

// Mutation caught: trusting metadata captured before final realpath would accept a file replacement at the witness boundary.
test('rejects a workflow replaced after realpath during final file revalidation', () => {
  const root = createFixture({
    '.github/workflows/mutable.yml': `name: Mutable
on: workflow_dispatch
permissions:
  contents: read
jobs:
  verify:
    runs-on: ubuntu-latest
    steps:
      - uses: owner/action@v1
`,
  })
  const workflowPath = join(realpathSync.native(root), '.github/workflows/mutable.yml')
  let replacementCalls = 0

  const findings = inspectWorkflowPolicy(root, {
    afterFinalFileRealpath: path => {
      if (path === workflowPath && replacementCalls === 0) {
        replacementCalls += 1
        renameSync(path, `${path}.original`)
        writeFileSync(
          path,
          `name: Replacement
on: workflow_dispatch
permissions:
  contents: read
jobs: {}
`,
          'utf8',
        )
      }
    },
  })

  assert.equal(replacementCalls, 1)
  assert.deepEqual(findings, [
    {
      file: '.github/workflows',
      location: '$',
      rule: 'source-integrity',
    },
  ])
})

// Mutation caught: a single ordered final sweep would let a later source hook rewrite an already accepted source.
test('rejects an earlier workflow rewritten during later workflow final revalidation', () => {
  const root = createFixture({
    '.github/workflows/a.yml': `name: Earlier
on: workflow_dispatch
permissions:
  contents: read
jobs: {}
`,
    '.github/workflows/b.yml': `name: Later
on: workflow_dispatch
permissions:
  contents: read
jobs: {}
`,
  })
  const nativeRoot = realpathSync.native(root)
  const earlierWorkflowPath = join(nativeRoot, '.github/workflows/a.yml')
  const laterWorkflowPath = join(nativeRoot, '.github/workflows/b.yml')
  let replacementCalls = 0

  const findings = inspectWorkflowPolicy(root, {
    afterFinalFileRealpath: path => {
      if (path === laterWorkflowPath && replacementCalls === 0) {
        replacementCalls += 1
        writeFileSync(
          earlierWorkflowPath,
          `name: Rewritten
on: workflow_dispatch
permissions:
  contents: read
jobs:
  verify:
    runs-on: ubuntu-latest
    steps:
      - uses: owner/action@v1
`,
          'utf8',
        )
      }
    },
  })

  assert.equal(replacementCalls, 1)
  assert.deepEqual(findings, [
    {
      file: '.github/workflows',
      location: '$',
      rule: 'source-integrity',
    },
  ])
})

// Mutation caught: recording the lstat taken before final realpath would let the read primitive return a mixed witness.
test('rejects a source replaced between its final realpath and closing lstat', () => {
  const root = createFixture({
    'source.yml': `name: Original
permissions:
  contents: read
jobs: {}
`,
  })
  const nativeRoot = realpathSync.native(root)
  const sourcePath = join(nativeRoot, 'source.yml')
  let replacementCalls = 0

  const validated = readValidatedNativeFile(nativeRoot, sourcePath, {
    afterFinalRealpath: path => {
      replacementCalls += 1
      renameSync(path, `${path}.original`)
      writeFileSync(
        path,
        `name: Replacement
permissions:
  contents: read
jobs: {}
`,
        'utf8',
      )
    },
  })

  assert.equal(replacementCalls, 1)
  assert.deepEqual(validated, { kind: 'invalid' })
})

// Mutation caught: trusting directory metadata captured before final realpath would accept a replaced workflow generation.
test('rejects a workflow directory replaced after realpath during final discovery revalidation', () => {
  const root = createFixture({
    '.github/workflows/stable.yml': `name: Stable
on: workflow_dispatch
permissions:
  contents: read
jobs: {}
`,
  })
  const workflowsPath = join(realpathSync.native(root), '.github/workflows')
  let replacementCalls = 0

  const findings = inspectWorkflowPolicy(root, {
    afterFinalDirectoryRealpath: path => {
      if (path === workflowsPath && replacementCalls === 0) {
        replacementCalls += 1
        renameSync(path, `${path}-original`)
        mkdirSync(path)
      }
    },
  })

  assert.equal(replacementCalls, 1)
  assert.deepEqual(findings, [
    {
      file: '.github/workflows',
      location: '$',
      rule: 'source-integrity',
    },
  ])
})

// Mutation caught: omitting either absent discovery state, or retaining callbacks, would weaken the second sweep.
test('revalidates absent workflow discovery without callbacks in the second final sweep', () => {
  const absentGithubRoot = createFixture({
    'README.md': 'No GitHub directory\n',
  })
  const absentWorkflowsRoot = createFixture({
    '.github/placeholder': 'No workflows directory\n',
  })
  const cases = [
    { path: join(absentGithubRoot, '.github'), root: absentGithubRoot },
    { path: join(absentWorkflowsRoot, '.github/workflows'), root: absentWorkflowsRoot },
  ]

  const results = cases.map(({ path, root }) => {
    let firstSweepComplete = false
    let callbackCallsAfterFirstSweep = 0
    const findings = inspectWorkflowPolicy(root, {
      afterFinalDirectoryRealpath: () => {
        if (firstSweepComplete) {
          callbackCallsAfterFirstSweep += 1
        }
      },
      afterFirstFinalRevalidation: () => {
        firstSweepComplete = true
        mkdirSync(path, { recursive: true })
      },
    })
    return { callbackCallsAfterFirstSweep, findings }
  })

  assert.deepEqual(results, [
    {
      callbackCallsAfterFirstSweep: 0,
      findings: [
        {
          file: '.github/workflows',
          location: '$',
          rule: 'source-integrity',
        },
      ],
    },
    {
      callbackCallsAfterFirstSweep: 0,
      findings: [
        {
          file: '.github/workflows',
          location: '$',
          rule: 'source-integrity',
        },
      ],
    },
  ])
})

// Mutation caught: retaining only the selected action manifest would accept a second candidate added after target resolution.
test('rejects action-manifest ambiguity introduced after target selection', () => {
  const root = createFixture({
    '.github/actions/mutable/action.yml': `name: Mutable
runs:
  using: composite
  steps:
    - uses: owner/action@v1
`,
    '.github/workflows/action.yml': `name: Action caller
on: workflow_dispatch
permissions:
  contents: read
jobs:
  verify:
    runs-on: ubuntu-latest
    steps:
      - uses: $/.github/actions/mutable
`,
  })
  let finalRevalidationCalls = 0

  const findings = inspectWorkflowPolicy(root, {
    beforeFinalRevalidation: () => {
      finalRevalidationCalls += 1
      writeFileSync(
        join(root, '.github/actions/mutable/action.yaml'),
        `name: Late manifest
runs:
  using: composite
  steps: []
`,
        'utf8',
      )
    },
  })

  assert.equal(finalRevalidationCalls, 1)
  assert.deepEqual(findings, [
    {
      file: '.github/workflows',
      location: '$',
      rule: 'source-integrity',
    },
  ])
})

// Mutation caught: observing only the opening action-directory generation would accept a replacement between candidates.
test('rejects an action directory replaced after its first candidate revalidation', () => {
  const root = createFixture({
    '.github/actions/mutable/action.yml': `name: Mutable
runs:
  using: composite
  steps:
    - uses: owner/action@v1
`,
    '.github/workflows/action.yml': `name: Action caller
on: workflow_dispatch
permissions:
  contents: read
jobs:
  verify:
    runs-on: ubuntu-latest
    steps:
      - uses: $/.github/actions/mutable
`,
  })
  const actionPath = join(realpathSync.native(root), '.github/actions/mutable')
  let replacementCalls = 0

  const findings = inspectWorkflowPolicy(root, {
    afterActionCandidateRevalidation: (path, index) => {
      if (path === actionPath && index === 0 && replacementCalls === 0) {
        replacementCalls += 1
        renameSync(path, `${path}-original`)
        mkdirSync(path)
      }
    },
  })

  assert.equal(replacementCalls, 1)
  assert.deepEqual(findings, [
    {
      file: '.github/workflows',
      location: '$',
      rule: 'source-integrity',
    },
  ])
})

// Mutation caught: comparing a candidate only before its post-observation hook would accept rewritten action bytes.
test('rejects an action manifest rewritten after candidate revalidation', () => {
  const root = createFixture({
    '.github/actions/mutable/action.yml': `name: Mutable
runs:
  using: composite
  steps: []
`,
    '.github/workflows/action.yml': `name: Action caller
on: workflow_dispatch
permissions:
  contents: read
jobs:
  verify:
    runs-on: ubuntu-latest
    steps:
      - uses: $/.github/actions/mutable
`,
  })
  const actionDirectory = join(realpathSync.native(root), '.github/actions/mutable')
  const actionManifest = join(actionDirectory, 'action.yml')
  let replacementCalls = 0

  const findings = inspectWorkflowPolicy(root, {
    afterActionCandidateRevalidation: (path, index) => {
      if (path === actionDirectory && index === 0 && replacementCalls === 0) {
        replacementCalls += 1
        writeFileSync(
          actionManifest,
          `name: Rewritten
runs:
  using: composite
  steps:
    - uses: owner/action@v1
`,
          'utf8',
        )
      }
    },
  })

  assert.equal(replacementCalls, 1)
  assert.deepEqual(findings, [
    {
      file: '.github/workflows',
      location: '$',
      rule: 'source-integrity',
    },
  ])
})

test('accepts self-repository action and reusable-workflow references', () => {
  const root = createFixture({
    '.github/actions/checked/action.yml': `name: Checked
runs:
  using: composite
  steps: []
`,
    '.github/workflows/called.yml': `name: Called
on: workflow_call
permissions:
  contents: read
jobs: {}
`,
    '.github/workflows/caller.yml': `name: Caller
on: workflow_dispatch
permissions:
  contents: read
jobs:
  call-dollar:
    uses: $/.github/workflows/called.yml
  call-relative:
    uses: ./.github/workflows/called.yml
  verify:
    runs-on: ubuntu-latest
    steps:
      - uses: $/.github/actions/checked
`,
  })

  assert.deepEqual(inspectWorkflowPolicy(root), [])
})

// Mutation caught: YAML 1.1 boolean-key coercion would merge distinct valid GitHub job identifiers.
test('preserves YAML 1.2 job identifiers in block and flow mappings', () => {
  const jobNames = ['on', 'yes', 'no', 'off', 'true', 'false'] as const
  const blockJobs = jobNames
    .map(
      jobName => `  ${jobName}:
    runs-on: ubuntu-latest
    steps:
      - uses: owner/action@v1`,
    )
    .join('\n')
  const flowJobs = jobNames
    .map(jobName => `${jobName}: { runs-on: ubuntu-latest, steps: [ { uses: owner/action@v1 } ] }`)
    .join(', ')
  const root = createFixture({
    '.github/workflows/block.yml': `name: Block keys
on: workflow_dispatch
permissions:
  contents: read
jobs:
${blockJobs}
`,
    '.github/workflows/flow.yml': `name: Flow keys
on: workflow_dispatch
permissions: { contents: read }
jobs: { ${flowJobs} }
`,
  })

  assert.deepEqual(inspectWorkflowPolicy(root), [
    { file: '.github/workflows/block.yml', location: 'jobs.false.steps[0].uses', rule: 'external-reference-sha' },
    { file: '.github/workflows/block.yml', location: 'jobs.no.steps[0].uses', rule: 'external-reference-sha' },
    { file: '.github/workflows/block.yml', location: 'jobs.off.steps[0].uses', rule: 'external-reference-sha' },
    { file: '.github/workflows/block.yml', location: 'jobs.on.steps[0].uses', rule: 'external-reference-sha' },
    { file: '.github/workflows/block.yml', location: 'jobs.true.steps[0].uses', rule: 'external-reference-sha' },
    { file: '.github/workflows/block.yml', location: 'jobs.yes.steps[0].uses', rule: 'external-reference-sha' },
    { file: '.github/workflows/flow.yml', location: 'jobs.false.steps[0].uses', rule: 'external-reference-sha' },
    { file: '.github/workflows/flow.yml', location: 'jobs.no.steps[0].uses', rule: 'external-reference-sha' },
    { file: '.github/workflows/flow.yml', location: 'jobs.off.steps[0].uses', rule: 'external-reference-sha' },
    { file: '.github/workflows/flow.yml', location: 'jobs.on.steps[0].uses', rule: 'external-reference-sha' },
    { file: '.github/workflows/flow.yml', location: 'jobs.true.steps[0].uses', rule: 'external-reference-sha' },
    { file: '.github/workflows/flow.yml', location: 'jobs.yes.steps[0].uses', rule: 'external-reference-sha' },
  ])
})

// Mutation caught: rejecting all aliases or quoted keys would exclude unambiguous YAML 1.2 workflow documents.
test('accepts quoted keys and bounded simple aliases', () => {
  const root = createFixture({
    '.github/workflows/aliases.yml': `name: Aliases
"on": workflow_dispatch
permissions: &read
  contents: read
jobs:
  "on": &job
    runs-on: ubuntu-latest
    steps:
      - uses: owner/action@0123456789abcdef0123456789abcdef01234567
  "yes": *job
`,
  })

  assert.deepEqual(inspectWorkflowPolicy(root), [])
})

// Mutation caught: permissive parsing would silently overwrite ambiguous keys, accept extra documents, or expand aliases without a ceiling.
test('rejects ambiguous or unsafe YAML documents as source integrity failures', () => {
  const aliases = Array.from({ length: 100 }, () => '  - *item').join('\n')
  const root = createFixture({
    '.github/workflows/boolean-equivalent.yml': `name: Boolean equivalent
on: workflow_dispatch
permissions: { contents: read }
jobs:
  true: {}
  "true": {}
`,
    '.github/workflows/escaped-equivalent.yml': `name: Escaped equivalent
on: workflow_dispatch
permissions: { contents: read }
jobs:
  "verify": {}
  "\\x76erify": {}
`,
    '.github/workflows/exact-duplicate.yml': `name: Exact duplicate
on: workflow_dispatch
permissions: {}
permissions: { contents: read }
jobs: {}
`,
    '.github/workflows/excessive-aliases.yml': `name: Excessive aliases
on: workflow_dispatch
permissions: { contents: read }
item: &item value
items:
${aliases}
jobs: {}
`,
    '.github/workflows/flow-duplicate.yml': `name: Flow duplicate
on: workflow_dispatch
permissions: { contents: read }
jobs: { verify: {}, verify: {} }
`,
    '.github/workflows/multiple-documents.yml': `name: First
on: workflow_dispatch
permissions: { contents: read }
jobs: {}
---
name: Second
on: workflow_dispatch
permissions: { contents: read }
jobs: {}
`,
    '.github/workflows/non-scalar-key.yml': `name: Non-scalar key
on: workflow_dispatch
permissions: { contents: read }
? [jobs, alias]
: {}
jobs: {}
`,
    '.github/workflows/quoted-equivalent.yml': `name: Quoted equivalent
on: workflow_dispatch
permissions: { contents: read }
jobs:
  verify: {}
  "verify": {}
`,
    '.github/workflows/unknown-tag.yml': `name: !unknown Tagged
on: workflow_dispatch
permissions: { contents: read }
jobs: {}
`,
  })

  assert.deepEqual(inspectWorkflowPolicy(root), [
    { file: '.github/workflows/boolean-equivalent.yml', location: '$', rule: 'source-integrity' },
    { file: '.github/workflows/escaped-equivalent.yml', location: '$', rule: 'source-integrity' },
    { file: '.github/workflows/exact-duplicate.yml', location: '$', rule: 'source-integrity' },
    { file: '.github/workflows/excessive-aliases.yml', location: '$', rule: 'source-integrity' },
    { file: '.github/workflows/flow-duplicate.yml', location: '$', rule: 'source-integrity' },
    { file: '.github/workflows/multiple-documents.yml', location: '$', rule: 'source-integrity' },
    { file: '.github/workflows/non-scalar-key.yml', location: '$', rule: 'source-integrity' },
    { file: '.github/workflows/quoted-equivalent.yml', location: '$', rule: 'source-integrity' },
    { file: '.github/workflows/unknown-tag.yml', location: '$', rule: 'source-integrity' },
  ])
})

// Mutation caught: inspecting only direct workflow steps would allow parallel groups to conceal mutable actions and wrappers.
test('inspects nested workflow parallel groups without treating composite or data fields as executable', () => {
  const root = createFixture({
    '.github/actions/composite-data/action.yml': `name: Composite data
runs:
  using: composite
  steps:
    - parallel:
        - uses: owner/composite-data@v1
`,
    '.github/actions/wrapper/action.yml': `name: Wrapper
runs:
  using: composite
  steps:
    - uses: owner/wrapped@v1
`,
    '.github/workflows/parallel.yml': `name: Parallel
on: workflow_dispatch
permissions: { contents: read }
jobs:
  verify:
    runs-on: ubuntu-latest
    metadata:
      parallel:
        - uses: owner/job-data@v1
    steps:
      - uses: $/.github/actions/composite-data
        with:
          parallel:
            - uses: owner/input-data@v1
      - parallel:
          - uses: owner/direct@v1
          - uses: $/.github/actions/wrapper
          - parallel:
              - uses: owner/nested@v2
`,
  })

  assert.deepEqual(inspectWorkflowPolicy(root), [
    {
      file: '.github/actions/wrapper/action.yml',
      location: 'runs.steps[0].uses',
      rule: 'external-reference-sha',
    },
    {
      file: '.github/workflows/parallel.yml',
      location: 'jobs.verify.steps[1].parallel[0].uses',
      rule: 'external-reference-sha',
    },
    {
      file: '.github/workflows/parallel.yml',
      location: 'jobs.verify.steps[1].parallel[2].parallel[0].uses',
      rule: 'external-reference-sha',
    },
  ])
})

// Mutation caught: recursively following a cyclic parallel alias would loop or overflow instead of failing closed once.
test('rejects cyclic workflow parallel groups without recursive stack growth', () => {
  const root = createFixture({
    '.github/workflows/cyclic-parallel.yml': `name: Cyclic parallel
on: workflow_dispatch
permissions: { contents: read }
jobs:
  verify:
    runs-on: ubuntu-latest
    steps: &steps
      - parallel: *steps
`,
  })

  assert.deepEqual(inspectWorkflowPolicy(root), [
    { file: '.github/workflows', location: '$', rule: 'source-integrity' },
  ])
})

// Mutation caught: accepting an active executable object would let a composite action's self-aliased steps evade fail-closed traversal.
test('rejects self-aliased composite action steps in the executable walker', () => {
  const root = createFixture({
    '.github/actions/cyclic/action.yml': `name: Cyclic composite
runs:
  using: composite
  steps: &steps
    - *steps
`,
    '.github/workflows/cyclic-action.yml': `name: Cyclic action caller
on: workflow_dispatch
permissions: { contents: read }
jobs:
  verify:
    runs-on: ubuntu-latest
    steps:
      - uses: $/.github/actions/cyclic
`,
  })

  assert.deepEqual(inspectWorkflowPolicy(root), [
    { file: '.github/workflows', location: '$', rule: 'source-integrity' },
  ])
})

test('inspects only executable uses positions', () => {
  const root = createFixture({
    '.github/actions/checked/action.yml': `name: Checked
inputs:
  uses:
    description: Data named like an executable key
runs:
  using: composite
  steps:
    - uses: owner/action@0123456789abcdef0123456789abcdef01234567 # v1.0.0
      with:
        uses: owner/input@v1 # data-only
`,
    '.github/workflows/called.yml': `name: Called
on: workflow_call
permissions:
  contents: read
jobs: {}
`,
    '.github/workflows/caller.yml': `name: Caller
on: workflow_dispatch
permissions:
  contents: read
jobs:
  call:
    uses: $/.github/workflows/called.yml
    with:
      uses: owner/input@v1
  verify:
    runs-on: ubuntu-latest
    steps:
      - uses: $/.github/actions/checked
        with:
          uses: owner/input@v1
`,
  })

  const externalReferences: ExternalReferenceObservation[] = []
  assert.deepEqual(
    inspectWorkflowPolicy(root, {
      onExternalReference: observation => {
        externalReferences.push(observation)
      },
    }),
    [],
  )
  assert.deepEqual(externalReferences, [
    {
      file: '.github/actions/checked/action.yml',
      location: 'runs.steps[0].uses',
      reference: 'owner/action@0123456789abcdef0123456789abcdef01234567',
      releaseComment: 'v1.0.0',
    },
  ])
})

// Mutation caught: removing runner credential detection would allow dotted, bracket, or OIDC credentials without the protected environment.
test('requires the exact protected environment for direct runner credentials', () => {
  const root = createFixture({
    '.github/workflows/credentials.yml': `name: Credentials
on: workflow_dispatch
permissions:
  contents: read
jobs:
  bracket:
    runs-on: ubuntu-latest
    environment: staging
    steps:
      - run: echo "\${{  secrets['TOKEN'] }}"
  dot:
    runs-on: ubuntu-latest
    steps:
      - run: echo "\${{ secrets.TOKEN }}"
  empty:
    runs-on: ubuntu-latest
    permissions: {}
    steps:
      - run: echo "\${{ secrets.TOKEN }}"
  oidc:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      id-token: write
    steps:
      - run: echo oidc
`,
  })

  assert.deepEqual(inspectWorkflowPolicy(root), [
    {
      file: '.github/workflows/credentials.yml',
      location: 'jobs.bracket.environment',
      rule: 'credential-environment',
    },
    {
      file: '.github/workflows/credentials.yml',
      location: 'jobs.dot.environment',
      rule: 'credential-environment',
    },
    {
      file: '.github/workflows/credentials.yml',
      location: 'jobs.empty.environment',
      rule: 'credential-environment',
    },
    {
      file: '.github/workflows/credentials.yml',
      location: 'jobs.oidc.environment',
      rule: 'credential-environment',
    },
    {
      file: '.github/workflows/credentials.yml',
      location: 'jobs.oidc.permissions.id-token',
      rule: 'permission',
    },
  ])
})

// Mutation caught: scanning only runner steps would miss secret expressions in job-level environment values.
test('requires protection for job-level secret environments only on unprotected runners', () => {
  const root = createFixture({
    '.github/workflows/job-environment.yml': `name: Job environment
on: workflow_dispatch
permissions:
  contents: read
jobs:
  protected:
    runs-on: ubuntu-latest
    environment: pullfrog-review
    env:
      TOKEN: \${{ secrets.TOKEN }}
    steps:
      - run: echo protected
  unprotected:
    runs-on: ubuntu-latest
    env:
      TOKEN: \${{ secrets.TOKEN }}
    steps:
      - run: echo unprotected
`,
  })

  assert.deepEqual(inspectWorkflowPolicy(root), [
    {
      file: '.github/workflows/job-environment.yml',
      location: 'jobs.unprotected.environment',
      rule: 'credential-environment',
    },
  ])
})

// Mutation caught: treating a local reusable-workflow caller as a runner would require an unsupported caller environment.
test('allows local reusable workflows to map or inherit secrets when every consuming runner is protected', () => {
  const root = createFixture({
    '.github/workflows/called.yml': `name: Called
on:
  workflow_call:
    secrets:
      REUSABLE_TOKEN:
        required: true
permissions:
  contents: read
jobs:
  consume-inherited:
    runs-on: ubuntu-latest
    environment: pullfrog-review
    steps:
      - run: echo "\${{ secrets.REUSABLE_TOKEN }}"
  consume-named:
    runs-on: ubuntu-latest
    environment: pullfrog-review
    steps:
      - run: echo "\${{ secrets.REUSABLE_TOKEN }}"
`,
    '.github/workflows/caller.yml': `name: Caller
on: workflow_dispatch
permissions:
  contents: read
jobs:
  inherited:
    uses: ./.github/workflows/called.yml
    permissions: {}
    secrets: inherit
  named:
    uses: ./.github/workflows/called.yml
    permissions:
      contents: read
    secrets:
      REUSABLE_TOKEN: \${{ secrets.REUSABLE_TOKEN }}
`,
  })

  assert.deepEqual(inspectWorkflowPolicy(root), [])
})

// Mutation caught: trusting a local caller's protected boundary would let its called credential-consuming runner omit the environment.
test('reports an unprotected local reusable-workflow runner in the called file', () => {
  const root = createFixture({
    '.github/workflows/called.yml': `name: Called
on: workflow_call
permissions:
  contents: read
jobs:
  consume:
    runs-on: ubuntu-latest
    steps:
      - run: echo "\${{ secrets.REUSABLE_TOKEN }}"
`,
    '.github/workflows/caller.yml': `name: Caller
on: workflow_dispatch
permissions:
  contents: read
jobs:
  call:
    uses: $/.github/workflows/called.yml
    permissions: {}
    secrets: inherit
`,
  })

  assert.deepEqual(inspectWorkflowPolicy(root), [
    {
      file: '.github/workflows/called.yml',
      location: 'jobs.consume.environment',
      rule: 'credential-environment',
    },
  ])
})

// Mutation caught: allowing a pinned external reusable workflow to receive caller credentials would escape recursive local policy inspection.
test('rejects named and inherited secrets forwarded to external reusable workflows', () => {
  const root = createFixture({
    '.github/workflows/external.yml': `name: External
on: workflow_dispatch
permissions:
  contents: read
jobs:
  inherited:
    uses: owner/repository/.github/workflows/called.yml@0123456789abcdef0123456789abcdef01234567
    permissions: {}
    secrets: inherit
  named:
    uses: owner/repository/.github/workflows/called.yml@0123456789abcdef0123456789abcdef01234567
    permissions: {}
    secrets:
      token: \${{ secrets.TOKEN }}
`,
  })

  assert.deepEqual(inspectWorkflowPolicy(root), [
    {
      file: '.github/workflows/external.yml',
      location: 'jobs.inherited.secrets',
      rule: 'credential-forwarding',
    },
    {
      file: '.github/workflows/external.yml',
      location: 'jobs.named.secrets',
      rule: 'credential-forwarding',
    },
  ])
})

// Mutation caught: reusing runner-job permission defaults would give an external reusable workflow configurable repository authority.
test('accepts a pinned external reusable workflow only with exact empty job permissions', () => {
  const root = createFixture({
    '.github/workflows/external.yml': `name: External
on: workflow_dispatch
permissions:
  contents: read
jobs:
  call:
    uses: owner/repository/.github/workflows/called.yml@0123456789abcdef0123456789abcdef01234567
    permissions: {}
`,
  })

  assert.deepEqual(inspectWorkflowPolicy(root), [])
})

// Mutation caught: accepting omitted or non-empty caller permissions would delegate configurable repository authority externally.
test('rejects omitted or non-empty permissions on external reusable workflows', () => {
  const root = createFixture({
    '.github/workflows/external.yml': `name: External
on: workflow_dispatch
permissions:
  contents: read
jobs:
  non-empty:
    uses: owner/repository/.github/workflows/called.yml@0123456789abcdef0123456789abcdef01234567
    permissions:
      contents: read
  omitted:
    uses: owner/repository/.github/workflows/called.yml@0123456789abcdef0123456789abcdef01234567
`,
  })

  assert.deepEqual(inspectWorkflowPolicy(root), [
    {
      file: '.github/workflows/external.yml',
      location: 'jobs.non-empty.permissions',
      rule: 'permission',
    },
    {
      file: '.github/workflows/external.yml',
      location: 'jobs.omitted.permissions',
      rule: 'permission',
    },
  ])
})

// Mutation caught: limiting immutable-reference diagnostics to action steps would miss mutable reusable-workflow calls.
test('rejects an unpinned external reusable workflow under the reference taxonomy', () => {
  const root = createFixture({
    '.github/workflows/external.yml': `name: External
on: workflow_dispatch
permissions:
  contents: read
jobs:
  call:
    uses: owner/repository/.github/workflows/called.yml@main
    permissions: {}
`,
  })

  assert.deepEqual(inspectWorkflowPolicy(root), [
    {
      file: '.github/workflows/external.yml',
      location: 'jobs.call.uses',
      rule: 'external-reference-sha',
    },
  ])
})

// Mutation caught: requiring immediate secret access would miss spaced dot/bracket expressions, while dropping the expression prefix would flag plain text.
test('detects spaced secret context access only inside GitHub expressions', () => {
  const root = createFixture({
    '.github/workflows/spaced-secrets.yml': `name: Spaced secrets
on: workflow_dispatch
permissions:
  contents: read
jobs:
  bracket:
    runs-on: ubuntu-latest
    environment: staging
    steps:
      - run: echo "\${{ secrets ['TOKEN'] }}"
  dot:
    runs-on: ubuntu-latest
    steps:
      - run: echo "\${{ secrets .TOKEN }}"
  plain:
    runs-on: ubuntu-latest
    steps:
      - run: echo "secrets ['TOKEN']"
  protected:
    runs-on: ubuntu-latest
    environment: pullfrog-review
    steps:
      - run: echo "\${{ secrets ['TOKEN'] }}"
`,
  })

  assert.deepEqual(inspectWorkflowPolicy(root), [
    {
      file: '.github/workflows/spaced-secrets.yml',
      location: 'jobs.bracket.environment',
      rule: 'credential-environment',
    },
    {
      file: '.github/workflows/spaced-secrets.yml',
      location: 'jobs.dot.environment',
      rule: 'credential-environment',
    },
  ])
})

// Mutation caught: requiring secrets at the expression start would miss nested context use, while scanning outside expression bounds would flag plain text.
test('detects the secrets context anywhere inside a GitHub expression', () => {
  const root = createFixture({
    '.github/workflows/nested-secrets.yml': `name: Nested secrets
on: workflow_dispatch
permissions:
  contents: read
jobs:
  formatted:
    runs-on: ubuntu-latest
    steps:
      - run: echo "\${{ format('{{value {0}}}', secrets.TOKEN) }}"
  serialized:
    runs-on: ubuntu-latest
    steps:
      - run: echo "\${{ toJSON(secrets) }}"
  mixed-case:
    runs-on: ubuntu-latest
    steps:
      - run: echo "\${{ SeCrEtS.TOKEN }}"
  member:
    runs-on: ubuntu-latest
    steps:
      - run: echo "\${{ outputs.secrets }}"
  function-member:
    runs-on: ubuntu-latest
    steps:
      - run: echo "\${{ fromJSON(needs.prepare.outputs.payload).secrets }}"
  spaced-member:
    runs-on: ubuntu-latest
    steps:
      - run: echo "\${{ outputs . SeCrEtS }}"
  second-expression:
    runs-on: ubuntu-latest
    steps:
      - run: echo "\${{ github.ref }} then \${{ secrets.SECOND }}"
  quoted:
    runs-on: ubuntu-latest
    steps:
      - run: echo "\${{ 'secrets' }}"
  quoted-format:
    runs-on: ubuntu-latest
    steps:
      - run: echo "\${{ format('don''t expose secrets {0}', github.ref) }}"
  outside:
    runs-on: ubuntu-latest
    steps:
      - run: echo "\${{ github.ref }} secrets.TOKEN"
  hyphenated:
    runs-on: ubuntu-latest
    steps:
      - run: echo "\${{ outputs.non-secrets }} \${{ outputs.secrets-token }}"
  prefixed:
    runs-on: ubuntu-latest
    steps:
      - run: echo "\${{ outputs.mysecrets }}"
  suffixed:
    runs-on: ubuntu-latest
    steps:
      - run: echo "\${{ outputs.secretsValue }}"
`,
  })

  assert.deepEqual(inspectWorkflowPolicy(root), [
    {
      file: '.github/workflows/nested-secrets.yml',
      location: 'jobs.formatted.environment',
      rule: 'credential-environment',
    },
    {
      file: '.github/workflows/nested-secrets.yml',
      location: 'jobs.mixed-case.environment',
      rule: 'credential-environment',
    },
    {
      file: '.github/workflows/nested-secrets.yml',
      location: 'jobs.second-expression.environment',
      rule: 'credential-environment',
    },
    {
      file: '.github/workflows/nested-secrets.yml',
      location: 'jobs.serialized.environment',
      rule: 'credential-environment',
    },
  ])
})

// Mutation caught: excluding reusable workflow roots from discovery would miss their own unprotected secret expressions.
test('independently inspects credential environments in local reusable workflows', () => {
  const root = createFixture({
    '.github/workflows/reusable.yml': `name: Reusable
on: workflow_call
permissions:
  contents: read
jobs:
  inspect:
    runs-on: ubuntu-latest
    steps:
      - run: echo "\${{ secrets.REUSABLE_TOKEN }}"
`,
  })

  assert.deepEqual(inspectWorkflowPolicy(root), [
    {
      file: '.github/workflows/reusable.yml',
      location: 'jobs.inspect.environment',
      rule: 'credential-environment',
    },
  ])
})

// Mutation caught: applying workflow-level env to callers would require an unsupported environment even though workflow env is not forwarded.
test('requires the exact protected environment only for runners inheriting workflow-level secret env', () => {
  const root = createFixture({
    '.github/workflows/called.yml': `name: Called
on: workflow_call
permissions:
  contents: read
jobs: {}
`,
    '.github/workflows/workflow-environment.yml': `name: Workflow environment
on: workflow_dispatch
permissions:
  contents: read
env:
  TOKEN: \${{ secrets.TOKEN }}
jobs:
  call:
    uses: ./.github/workflows/called.yml
    secrets: inherit
  missing:
    runs-on: ubuntu-latest
    steps:
      - run: echo inherited
  protected:
    runs-on: ubuntu-latest
    environment:
      name: pullfrog-review
    steps:
      - run: echo protected
  wrong:
    runs-on: ubuntu-latest
    environment: staging
    steps:
      - run: echo inherited
`,
  })

  assert.deepEqual(inspectWorkflowPolicy(root), [
    {
      file: '.github/workflows/workflow-environment.yml',
      location: 'jobs.missing.environment',
      rule: 'credential-environment',
    },
    {
      file: '.github/workflows/workflow-environment.yml',
      location: 'jobs.wrong.environment',
      rule: 'credential-environment',
    },
  ])
})

// Mutation caught: accepting lower authority must not admit omission, writes, extra scopes, or OIDC outside Pullfrog.
test('accepts explicit least-authority permission maps and retains the narrow Pullfrog OIDC exception', () => {
  const root = createFixture({
    '.github/workflows/contents-write.yml': `name: Contents write
on: workflow_dispatch
permissions:
  contents: write
jobs:
  verify:
    runs-on: ubuntu-latest
    permissions:
      contents: write
    steps:
      - run: echo unsafe
`,
    '.github/workflows/empty-top.yml': `name: Empty top-level permissions
on: workflow_dispatch
permissions: {}
jobs:
  verify:
    runs-on: ubuntu-latest
    steps:
      - run: echo empty
`,
    '.github/workflows/extra-read.yml': `name: Extra read
on: workflow_dispatch
permissions:
  contents: read
  issues: read
jobs:
  verify:
    runs-on: ubuntu-latest
    steps:
      - run: echo extra
`,
    '.github/workflows/job-shapes.yml': `name: Job shapes
on: workflow_dispatch
permissions:
  contents: read
jobs:
  inherited:
    runs-on: ubuntu-latest
    steps:
      - run: echo inherited
  exact:
    runs-on: ubuntu-latest
    permissions:
      contents: read
    steps:
      - run: echo exact
  empty:
    runs-on: ubuntu-latest
    permissions: {}
    steps:
      - run: echo empty
  read-all:
    runs-on: ubuntu-latest
    permissions: read-all
    steps:
      - run: echo broad
  write-all:
    runs-on: ubuntu-latest
    permissions: write-all
    steps:
      - run: echo broad
  extra-read:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      issues: read
    steps:
      - run: echo extra
  extra-write:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      checks: write
    steps:
      - run: echo extra
`,
    '.github/workflows/missing.yml': `name: Missing
on: workflow_dispatch
jobs:
  verify:
    runs-on: ubuntu-latest
    steps:
      - run: echo missing
`,
    '.github/workflows/oidc.yml': `name: OIDC
on: workflow_dispatch
permissions:
  contents: read
jobs:
  verify:
    runs-on: ubuntu-latest
    environment: pullfrog-review
    permissions:
      contents: read
      id-token: write
    steps:
      - run: echo oidc
`,
    '.github/workflows/pullfrog.yml': `name: Pullfrog
on: workflow_dispatch
permissions:
  contents: read
jobs:
  pullfrog:
    runs-on: ubuntu-latest
    environment:
      name: pullfrog-review
    permissions:
      contents: read
      id-token: write
      issues: read
    steps:
      - run: echo allowed
`,
    '.github/workflows/root-oidc.yml': `name: Root OIDC
on: workflow_dispatch
permissions:
  contents: read
  id-token: write
jobs:
  inherited:
    runs-on: ubuntu-latest
    steps:
      - run: echo inherited
  overridden:
    runs-on: ubuntu-latest
    permissions: {}
    steps:
      - run: echo no oidc
`,
  })

  assert.deepEqual(inspectWorkflowPolicy(root), [
    {
      file: '.github/workflows/contents-write.yml',
      location: 'jobs.verify.permissions.contents',
      rule: 'permission',
    },
    {
      file: '.github/workflows/contents-write.yml',
      location: 'permissions.contents',
      rule: 'permission',
    },
    {
      file: '.github/workflows/extra-read.yml',
      location: 'permissions',
      rule: 'permission',
    },
    {
      file: '.github/workflows/job-shapes.yml',
      location: 'jobs.extra-read.permissions.issues',
      rule: 'permission',
    },
    {
      file: '.github/workflows/job-shapes.yml',
      location: 'jobs.extra-write.permissions.checks',
      rule: 'permission',
    },
    {
      file: '.github/workflows/job-shapes.yml',
      location: 'jobs.read-all.permissions',
      rule: 'permission',
    },
    {
      file: '.github/workflows/job-shapes.yml',
      location: 'jobs.write-all.environment',
      rule: 'credential-environment',
    },
    {
      file: '.github/workflows/job-shapes.yml',
      location: 'jobs.write-all.permissions',
      rule: 'permission',
    },
    {
      file: '.github/workflows/missing.yml',
      location: 'permissions',
      rule: 'permission',
    },
    {
      file: '.github/workflows/oidc.yml',
      location: 'jobs.verify.permissions.id-token',
      rule: 'permission',
    },
    {
      file: '.github/workflows/pullfrog.yml',
      location: 'jobs.pullfrog.permissions.issues',
      rule: 'permission',
    },
    {
      file: '.github/workflows/root-oidc.yml',
      location: 'jobs.inherited.environment',
      rule: 'credential-environment',
    },
    {
      file: '.github/workflows/root-oidc.yml',
      location: 'permissions.id-token',
      rule: 'permission',
    },
  ])
})

// Mutation caught: removing containment or cycle handling would let a local reference escape the repository or recurse forever.
test('rejects escaping and workspace-relative actions while terminating self-references', () => {
  const root = createFixture({
    '.github/actions/self/action.yml': `name: Self
runs:
  using: composite
  steps:
    - uses: $/.github/actions/self
`,
    '.github/workflows/boundary.yml': `name: Boundary
on: workflow_dispatch
permissions:
  contents: read
jobs:
  verify:
    runs-on: ubuntu-latest
    steps:
      - uses: $/../outside/action
      - uses: $/.github/actions/self
      - uses: ./.github/actions/self
`,
  })
  const outside = createFixture({
    'action/action.yml': `name: Outside
runs:
  using: composite
  steps: []
`,
  })
  assert.notEqual(root, outside)

  assert.deepEqual(inspectWorkflowPolicy(root), [
    {
      file: '.github/workflows/boundary.yml',
      location: 'jobs.verify.steps[0].uses',
      rule: 'local-reference',
    },
    {
      file: '.github/workflows/boundary.yml',
      location: 'jobs.verify.steps[2].uses',
      rule: 'local-reference',
    },
  ])
})

// Mutation caught: normalising POSIX backslashes as separators would hide an ancestor symlink behind a slash-shaped path.
posixOnlyTest('rejects a POSIX ancestor symlink whose backslash name resembles a slash path', () => {
  const root = createFixture({
    '.github/actions/slash/path/checked/action.yml': `name: Checked
runs:
  using: composite
  steps: []
`,
    '.github/workflows/backslash.yml': `name: Backslash
on: workflow_dispatch
permissions:
  contents: read
jobs:
  verify:
    runs-on: ubuntu-latest
    steps:
      - uses: $/.github/actions/slash\\path/checked
`,
  })
  symlinkSync(join(root, '.github/actions/slash/path'), join(root, '.github/actions/slash\\path'), directorySymlinkType)

  assert.deepEqual(inspectWorkflowPolicy(root), [
    {
      file: '.github/workflows/backslash.yml',
      location: 'jobs.verify.steps[0].uses',
      rule: 'source-integrity',
    },
  ])
})

// Windows paths are case-insensitive and accept either separator; this must not alter the stricter POSIX test above.
windowsOnlyTest('accepts Windows local actions through case and separator spelling differences', () => {
  const root = createFixture({
    '.github/actions/MiXeD/ActionDirectory/action.yml': `name: Checked
runs:
  using: composite
  steps: []
`,
    '.github/workflows/windows-path.yml': `name: Windows path
on: workflow_dispatch
permissions:
  contents: read
jobs:
  verify:
    runs-on: windows-latest
    steps:
      - uses: $/.github\\actions/mixed\\actiondirectory
`,
  })

  assert.deepEqual(inspectWorkflowPolicy(root), [])
})

// Mutation caught: trusting lexical paths, directory defaults, or raw parsing would accept unsafe targets or crash on malformed YAML.
test('accepts only unambiguous regular local YAML targets within the native repository path', () => {
  const root = createFixture({
    '.github/actions/ambiguous/action.yaml': `name: Ambiguous YAML
runs:
  using: composite
  steps: []
`,
    '.github/actions/ambiguous/action.yml': `name: Ambiguous YML
runs:
  using: composite
  steps: []
`,
    '.github/actions/invalid/action.yml': 'name: [invalid',
    '.github/workflows/invalid.yaml': 'name: [invalid',
    '.github/workflows/local-files.yml': `name: Local files
on: workflow_dispatch
permissions:
  contents: read
jobs:
  verify:
    runs-on: ubuntu-latest
    steps:
      - uses: $/.github/actions/ambiguous
      - uses: $/.github/actions/symlinked
      - uses: $/.github/actions/missing
      - uses: $/.github/actions/invalid
`,
  })
  const outside = createFixture({
    'action/action.yml': `name: Outside
runs:
  using: composite
  steps: []
`,
  })
  symlinkSync(join(outside, 'action'), join(root, '.github/actions/symlinked'), directorySymlinkType)

  assert.deepEqual(inspectWorkflowPolicy(root), [
    {
      file: '.github/actions/invalid/action.yml',
      location: '$',
      rule: 'source-integrity',
    },
    {
      file: '.github/workflows/invalid.yaml',
      location: '$',
      rule: 'source-integrity',
    },
    {
      file: '.github/workflows/local-files.yml',
      location: 'jobs.verify.steps[0].uses',
      rule: 'source-integrity',
    },
    {
      file: '.github/workflows/local-files.yml',
      location: 'jobs.verify.steps[1].uses',
      rule: 'source-integrity',
    },
    {
      file: '.github/workflows/local-files.yml',
      location: 'jobs.verify.steps[2].uses',
      rule: 'local-reference',
    },
  ])
})

test('rejects multiply linked workflow and local-action files', () => {
  const root = createFixture({
    '.github/actions/linked/placeholder': 'fixture\n',
    '.github/workflows/entry.yml': `name: Entry
on: workflow_dispatch
permissions:
  contents: read
jobs:
  verify:
    runs-on: ubuntu-latest
    steps:
      - uses: $/.github/actions/linked
`,
  })
  const outside = createFixture({
    'action.yml': `name: Linked action
runs:
  using: composite
  steps: []
`,
    'workflow.yml': `name: Linked workflow
on: workflow_dispatch
permissions:
  contents: read
jobs: {}
`,
  })
  linkSync(join(outside, 'action.yml'), join(root, '.github/actions/linked/action.yml'))
  linkSync(join(outside, 'workflow.yml'), join(root, '.github/workflows/linked.yml'))

  assert.deepEqual(inspectWorkflowPolicy(root), [
    {
      file: '.github/workflows/entry.yml',
      location: 'jobs.verify.steps[0].uses',
      rule: 'source-integrity',
    },
    {
      file: '.github/workflows/linked.yml',
      location: '$',
      rule: 'source-integrity',
    },
  ])
})

// Mutation caught: trusting Dirent types or the workflow directory path would hide symlinked and non-regular root candidates.
test('rejects a symlinked workflow directory and every non-regular YAML candidate', () => {
  const outside = createFixture({
    '.github/workflows/outside.yml': `name: Outside
on: workflow_dispatch
permissions:
  contents: read
jobs: {}
`,
    'linked-directory/placeholder': 'outside\n',
  })
  const symlinkedDirectoryRoot = createFixture({
    '.github/placeholder': 'fixture\n',
  })
  symlinkSync(
    join(outside, '.github/workflows'),
    join(symlinkedDirectoryRoot, '.github/workflows'),
    directorySymlinkType,
  )

  const candidateRoot = createFixture({
    '.github/workflows/directory.yaml/placeholder': 'fixture\n',
    '.github/workflows/valid.yml': `name: Valid
on: workflow_dispatch
permissions:
  contents: read
jobs: {}
`,
  })
  symlinkSync(
    join(outside, 'linked-directory'),
    join(candidateRoot, '.github/workflows/linked.yml'),
    directorySymlinkType,
  )

  assert.deepEqual(inspectWorkflowPolicy(symlinkedDirectoryRoot), [
    {
      file: '.github/workflows',
      location: '$',
      rule: 'source-integrity',
    },
  ])
  assert.deepEqual(inspectWorkflowPolicy(candidateRoot), [
    {
      file: '.github/workflows/directory.yaml',
      location: '$',
      rule: 'source-integrity',
    },
    {
      file: '.github/workflows/linked.yml',
      location: '$',
      rule: 'source-integrity',
    },
  ])
})

// Mutation caught: treating child ENOENT as sufficient would accept a missing workflow directory through a non-native parent.
test('rejects a symlinked GitHub parent even when its workflow child is absent', () => {
  const outside = createFixture({
    '.github/placeholder': 'outside\n',
  })
  const root = createFixture({
    'README.md': 'fixture\n',
  })
  symlinkSync(join(outside, '.github'), join(root, '.github'), directorySymlinkType)

  assert.deepEqual(inspectWorkflowPolicy(root), [
    {
      file: '.github/workflows',
      location: '$',
      rule: 'source-integrity',
    },
  ])
})

// Mutation caught: treating realpath ENOENT as path absence would accept a persistent dangling symlink.
test('rejects dangling symlinks at either workflow discovery directory', () => {
  const danglingGithubRoot = createFixture({
    'README.md': 'fixture\n',
  })
  symlinkSync(join(danglingGithubRoot, 'missing-github'), join(danglingGithubRoot, '.github'), directorySymlinkType)

  const danglingWorkflowsRoot = createFixture({
    '.github/placeholder': 'fixture\n',
  })
  symlinkSync(
    join(danglingWorkflowsRoot, '.github/missing-workflows'),
    join(danglingWorkflowsRoot, '.github/workflows'),
    directorySymlinkType,
  )

  const expectedFinding = [
    {
      file: '.github/workflows',
      location: '$',
      rule: 'source-integrity',
    },
  ]
  assert.deepEqual(inspectWorkflowPolicy(danglingGithubRoot), expectedFinding)
  assert.deepEqual(inspectWorkflowPolicy(danglingWorkflowsRoot), expectedFinding)
})

// Mutation caught: treating Docker actions as repository references would reject immutable images or misclassify mutable ones.
test('accepts immutable repository and Docker action references under their exact pin rules', () => {
  const root = createFixture({
    '.github/workflows/references.yml': `name: References
on: workflow_dispatch
permissions:
  contents: read
jobs:
  call:
    uses: docker://alpine@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef
    permissions: {}
  verify:
    runs-on: ubuntu-latest
    steps:
      - uses: owner/repository/path@0123456789abcdef0123456789abcdef01234567
      - uses: docker://alpine@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef
      - uses: docker://registry.example.com:5000/team/image:v1@sha256:abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789
      - uses: docker://alpine:3.20
      - uses: docker://alpine@sha256:01234567
      - uses: docker://alpine@sha256:0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF
      - uses: docker://alpine@sha512:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef
      - uses: action@0123456789abcdef0123456789abcdef01234567
      - uses: owner/action@0123456789ABCDEF0123456789ABCDEF01234567
`,
  })

  assert.deepEqual(inspectWorkflowPolicy(root), [
    {
      file: '.github/workflows/references.yml',
      location: 'jobs.call.uses',
      rule: 'external-reference-sha',
    },
    {
      file: '.github/workflows/references.yml',
      location: 'jobs.verify.steps[3].uses',
      rule: 'external-image-digest',
    },
    {
      file: '.github/workflows/references.yml',
      location: 'jobs.verify.steps[4].uses',
      rule: 'external-image-digest',
    },
    {
      file: '.github/workflows/references.yml',
      location: 'jobs.verify.steps[5].uses',
      rule: 'external-image-digest',
    },
    {
      file: '.github/workflows/references.yml',
      location: 'jobs.verify.steps[6].uses',
      rule: 'external-image-digest',
    },
    {
      file: '.github/workflows/references.yml',
      location: 'jobs.verify.steps[7].uses',
      rule: 'external-reference-sha',
    },
    {
      file: '.github/workflows/references.yml',
      location: 'jobs.verify.steps[8].uses',
      rule: 'external-reference-sha',
    },
  ])
})

// Mutations caught: local docker:// images remain inspected, while mutable repository Dockerfile FROM chains stay outside proof.
test('inspects reachable local Docker images while accepting repository Dockerfiles', () => {
  const root = createFixture({
    '.github/actions/dockerfile-relative/action.yml': `name: Relative Dockerfile
runs:
  using: docker
  image: ./Dockerfile
`,
    '.github/actions/dockerfile-relative/Dockerfile': 'FROM alpine:3.20\n',
    '.github/actions/dockerfile/action.yml': `name: Dockerfile
runs:
  using: docker
  image: Dockerfile
`,
    '.github/actions/dockerfile/Dockerfile': 'FROM alpine:3.20\n',
    '.github/actions/mutable/action.yml': `name: Mutable image
runs:
  using: docker
  image: docker://alpine:3.20
`,
    '.github/actions/pinned/action.yml': `name: Pinned image
runs:
  using: docker
  image: docker://registry.example.com:5000/team/image:v1@sha256:abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789
`,
    '.github/workflows/docker.yml': `name: Docker actions
on: workflow_dispatch
permissions:
  contents: read
jobs:
  verify:
    runs-on: ubuntu-latest
    steps:
      - uses: $/.github/actions/pinned
      - uses: $/.github/actions/mutable
      - uses: $/.github/actions/dockerfile
      - uses: $/.github/actions/dockerfile-relative
`,
  })

  assert.deepEqual(inspectWorkflowPolicy(root), [
    {
      file: '.github/actions/mutable/action.yml',
      location: 'runs.image',
      rule: 'external-image-digest',
    },
  ])
})

// Mutation caught: removing deterministic sorting would make findings and formatted diagnostics depend on filesystem or object order.
test('sorts literal diagnostics by file, location, and rule before formatting them', () => {
  // biome-ignore assist/source/useSortedKeys: Reversed fixture insertion order proves output sorting is structural.
  const root = createFixture({
    '.github/workflows/z.yml': `name: Z
on: workflow_dispatch
permissions:
  contents: read
jobs:
  z:
    runs-on: ubuntu-latest
    steps:
      - uses: owner/action@v1
  a:
    runs-on: ubuntu-latest
    steps:
      - uses: owner/action@main
`,
    '.github/workflows/a.yaml': `name: A
on: workflow_dispatch
permissions:
  contents: read
jobs:
  verify:
    runs-on: ubuntu-latest
    steps:
      - uses: owner/action@v2
`,
  })

  const findings = inspectWorkflowPolicy(root)
  assert.deepEqual(findings, [
    {
      file: '.github/workflows/a.yaml',
      location: 'jobs.verify.steps[0].uses',
      rule: 'external-reference-sha',
    },
    {
      file: '.github/workflows/z.yml',
      location: 'jobs.a.steps[0].uses',
      rule: 'external-reference-sha',
    },
    {
      file: '.github/workflows/z.yml',
      location: 'jobs.z.steps[0].uses',
      rule: 'external-reference-sha',
    },
  ])
  assert.equal(
    formatWorkflowPolicyFindings(findings),
    `.github/workflows/a.yaml:jobs.verify.steps[0].uses: external-reference-sha: pin the external reference to a lowercase 40-character commit SHA
.github/workflows/z.yml:jobs.a.steps[0].uses: external-reference-sha: pin the external reference to a lowercase 40-character commit SHA
.github/workflows/z.yml:jobs.z.steps[0].uses: external-reference-sha: pin the external reference to a lowercase 40-character commit SHA
`,
  )
})

// Mutation caught: a context-free permission suffix would not tell maintainers which literal maps each location accepts.
test('formats permission remediation for workflow, job, ambiguous caller, and Pullfrog locations', () => {
  assert.equal(
    formatWorkflowPolicyFindings([
      { file: '.github/workflows/root.yml', location: 'permissions', rule: 'permission' },
      {
        file: '.github/workflows/runner.yml',
        location: 'jobs.verify.permissions.contents',
        rule: 'permission',
      },
      { file: '.github/workflows/caller.yml', location: 'jobs.call.permissions', rule: 'permission' },
      {
        file: '.github/workflows/pullfrog.yml',
        location: 'jobs.pullfrog.permissions.issues',
        rule: 'permission',
      },
      {
        file: '.github/actions/docker/action.yml',
        location: 'runs.image',
        rule: 'external-image-digest',
      },
    ]),
    `.github/workflows/root.yml:permissions: permission: set permissions to literal {} or { contents: read }
.github/workflows/runner.yml:jobs.verify.permissions.contents: permission: omit permissions to inherit, or set literal {} or { contents: read }
.github/workflows/caller.yml:jobs.call.permissions: permission: external reusable-workflow callers require literal {}; runners and local callers may omit permissions to inherit or set literal {} or { contents: read }
.github/workflows/pullfrog.yml:jobs.pullfrog.permissions.issues: permission: omit permissions to inherit, or set literal {}, { contents: read }, or { contents: read, id-token: write }
.github/actions/docker/action.yml:runs.image: external-image-digest: pin the external Docker image to a lowercase 64-character SHA-256 digest
`,
  )
})

// Mutation caught: removing CLI exit and stderr handling would let policy failures pass silently in automation.
test('keeps the CLI silent on success and writes findings to stderr on failure', () => {
  const passingRoot = createFixture({
    '.github/actions/checked/action.yml': `name: Checked
runs:
  using: composite
  steps:
    - uses: owner/action@0123456789abcdef0123456789abcdef01234567
`,
    '.github/workflows/pass.yml': `name: Pass
on: workflow_dispatch
permissions:
  contents: read
jobs:
  verify:
    runs-on: ubuntu-latest
    steps:
      - uses: $/.github/actions/checked
`,
  })
  const failingRoot = createFixture({
    '.github/workflows/fail.yml': `name: Fail
on: workflow_dispatch
permissions:
  contents: read
jobs:
  verify:
    runs-on: ubuntu-latest
    steps:
      - uses: owner/action@v1
`,
  })

  const passing = spawnSync(process.execPath, [policyPath], { cwd: passingRoot, encoding: 'utf8' })
  assert.equal(passing.status, 0)
  assert.equal(passing.stdout, '')
  assert.equal(passing.stderr, '')

  const failing = spawnSync(process.execPath, [policyPath], { cwd: failingRoot, encoding: 'utf8' })
  assert.equal(failing.status, 1)
  assert.equal(failing.stdout, '')
  assert.equal(
    failing.stderr,
    '.github/workflows/fail.yml:jobs.verify.steps[0].uses: external-reference-sha: pin the external reference to a lowercase 40-character commit SHA\n',
  )
})

// This suite owns the structural workflow security contract; test/package.test.ts independently guards its CI bootstrap.
// Mutation caught: mutable actions, hidden local wrappers, unprotected credentials, or write permissions would escape repository policy.
test('repository workflows obey immutable action and credential boundaries', () => {
  const externalReferences: ExternalReferenceObservation[] = []
  assert.deepEqual(
    inspectWorkflowPolicy(repositoryRoot, {
      onExternalReference: observation => {
        externalReferences.push(observation)
      },
    }),
    [],
  )

  // Mutation caught: removing push: disabled would restore Pullfrog's write-capable Git token and push tools.
  const parsedPullfrogWorkflow = parseWorkflowDocument(
    readFileSync(join(repositoryRoot, '.github/workflows/pullfrog.yml'), 'utf8'),
  )
  assert.notEqual(parsedPullfrogWorkflow, undefined)
  const pullfrogWorkflow = parsedPullfrogWorkflow as PullfrogWorkflow
  const pullfrogJob = pullfrogWorkflow.jobs.pullfrog
  assertExactPullfrogWorkflow(pullfrogWorkflow)
  assert.throws(() => assertExactPullfrogWorkflow({ ...pullfrogWorkflow, on: undefined }))

  // Mutations caught: credentials cannot be inherited from workflow scope and action families cannot hide in sibling jobs.
  assert.throws(() =>
    assertExactPullfrogWorkflow({
      ...pullfrogWorkflow,
      env: { PROVIDER_API_KEY: 'provider-secret-mapping' },
    }),
  )
  assert.throws(() =>
    assertExactPullfrogWorkflow({
      ...pullfrogWorkflow,
      jobs: {
        ...pullfrogWorkflow.jobs,
        'pullfrog-shadow': pullfrogJob,
      },
    }),
  )

  // Mutations caught: provider mappings cannot move to job scope or hide in an additional step.
  assert.throws(() =>
    assertExactPullfrogJob({
      ...pullfrogJob,
      env: { PROVIDER_API_KEY: 'provider-secret-mapping' },
    }),
  )
  assert.throws(() =>
    assertExactPullfrogJob({
      ...pullfrogJob,
      steps: [
        ...pullfrogJob.steps,
        {
          env: { PROVIDER_API_KEY: 'provider-secret-mapping' },
          name: 'Map provider credential',
          run: 'echo mapped',
        },
      ],
    }),
  )

  const parsedCiWorkflow = parseWorkflowDocument(readFileSync(join(repositoryRoot, '.github/workflows/ci.yml'), 'utf8'))
  assert.notEqual(parsedCiWorkflow, undefined)
  const ciWorkflow = parsedCiWorkflow as CiWorkflow
  const packageConfiguration = JSON.parse(readFileSync(join(repositoryRoot, 'package.json'), 'utf8')) as Readonly<{
    devDependencies?: Readonly<Record<string, unknown>>
    packageManager?: unknown
  }>
  assert.equal(typeof packageConfiguration.packageManager, 'string')
  const packageManagerMatch = /^bun@(\d+\.\d+\.\d+)$/u.exec(packageConfiguration.packageManager as string)
  assert.notEqual(packageManagerMatch, null)
  const bunVersion = packageManagerMatch?.[1]
  assert.equal(packageConfiguration.devDependencies?.['@types/bun'], bunVersion)
  assert.deepEqual(
    ciWorkflow.jobs.verify.steps.filter(step => step.uses !== undefined).map(step => step.uses),
    [
      'actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1',
      'actions/setup-node@820762786026740c76f36085b0efc47a31fe5020',
      'oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6',
    ],
  )
  assert.deepEqual(
    ciWorkflow.jobs.release.steps.filter(step => step.uses !== undefined).map(step => step.uses),
    [
      'actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1',
      'actions/setup-node@820762786026740c76f36085b0efc47a31fe5020',
      'oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6',
      'actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02',
    ],
  )
  // Mutation caught: hosted CI must not install a different Bun than the manifest and exact declarations use.
  const setupBunReference = 'oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6'
  const setupBunSteps = Object.values(ciWorkflow.jobs).flatMap(job =>
    job.steps.filter(step => step.uses === setupBunReference),
  )
  assert.equal(setupBunSteps.length, 2)
  assert.deepEqual(
    setupBunSteps.map(step => step.with?.['bun-version']),
    [bunVersion, bunVersion],
  )
  const ciCheckoutSteps = Object.values(ciWorkflow.jobs).flatMap(job =>
    job.steps.filter(step => typeof step.uses === 'string' && step.uses.startsWith('actions/checkout@')),
  )
  assert.equal(ciCheckoutSteps.length, 2)
  assert.equal(
    ciCheckoutSteps.every(step => step.with?.['persist-credentials'] === false),
    true,
  )

  // Structurally observed executable references bind to exact adjacent YAML scalar comments without scanning data fields.
  const reviewedReleaseComments: Readonly<Record<string, string>> = {
    'actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1': 'v7.0.1',
    'actions/checkout@d23441a48e516b6c34aea4fa41551a30e30af803': 'v6.1.0',
    'actions/setup-node@820762786026740c76f36085b0efc47a31fe5020': 'v7.0.0',
    'actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02': 'v4.6.2',
    'oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6': 'v2.2.0',
    'pullfrog/pullfrog@c4d0ca6f15d12382ddd20d2010bc596b405f42f0': 'v0.1.60',
  }
  assert.deepEqual(
    [...new Set(externalReferences.map(observation => observation.reference))].toSorted(),
    Object.keys(reviewedReleaseComments).toSorted(),
  )
  assert.equal(
    externalReferences.every(
      observation => observation.releaseComment === reviewedReleaseComments[observation.reference],
    ),
    true,
  )

  const dependabotConfiguration = parseWorkflowDocument(
    readFileSync(join(repositoryRoot, '.github/dependabot.yml'), 'utf8'),
  )
  assert.deepEqual(dependabotConfiguration, {
    updates: [
      {
        directory: '/',
        'package-ecosystem': 'github-actions',
        schedule: { interval: 'weekly' },
      },
    ],
    version: 2,
  })
})
