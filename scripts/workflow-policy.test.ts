import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { formatWorkflowPolicyFindings, inspectWorkflowPolicy } from './workflow-policy.ts'

const temporaryRoots: string[] = []
const policyPath = fileURLToPath(new URL('./workflow-policy.ts', import.meta.url))
const repositoryRoot = fileURLToPath(new URL('..', import.meta.url))
const directorySymlinkType = process.platform === 'win32' ? 'junction' : 'dir'

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
  true?: unknown
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
  const triggerKeys = Object.keys(workflow).filter(key => key === 'on' || key === 'true')
  assert.equal(triggerKeys.length, 1)
  assert.deepEqual(
    Object.keys(workflow)
      .filter(key => key !== 'on' && key !== 'true')
      .toSorted(),
    ['jobs', 'name', 'permissions', 'run-name'],
  )
  assert.equal(workflow.name, 'Pullfrog')
  assert.equal(workflow['run-name'], `${'$'}{{ inputs.name || github.workflow }}`)
  assert.deepEqual(workflow.permissions, { contents: 'read' })
  assert.deepEqual(workflow.on ?? workflow.true, {
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
      rule: 'local-reference',
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
    - uses: ./.github/actions/nested
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
      - uses: ./.github/actions/checked
`,
  })

  assert.deepEqual(inspectWorkflowPolicy(root), [
    {
      file: '.github/actions/nested/action.yaml',
      location: 'runs.steps[0].uses',
      rule: 'external-action-sha',
    },
  ])
})

// Mutation caught: removing credential detection would allow dot, bracket, inherited, or OIDC credentials without the protected environment.
test('requires the exact protected environment for every credential-bearing job shape', () => {
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
  inherited:
    runs-on: ubuntu-latest
    secrets: inherit
    steps:
      - run: echo inherited
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
      location: 'jobs.inherited.environment',
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

// Mutation caught: omitting workflow-level env inheritance would let every job consume a shared secret without the protected environment.
test('requires the exact protected environment for workflow-level secret inheritance', () => {
  const root = createFixture({
    '.github/workflows/workflow-environment.yml': `name: Workflow environment
on: workflow_dispatch
permissions:
  contents: read
env:
  TOKEN: \${{ secrets.TOKEN }}
jobs:
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

// Mutation caught: broadening permissions would allow missing scope, contents writes, extra read scopes, or OIDC outside Pullfrog.
test('enforces exact workflow read scope and the narrow Pullfrog OIDC exception', () => {
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
      location: 'jobs.empty.permissions',
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
  ])
})

// Mutation caught: removing containment or cycle handling would let a local reference escape the repository or recurse forever.
test('rejects escaping local references and terminates self-referencing local actions', () => {
  const root = createFixture({
    '.github/actions/self/action.yml': `name: Self
runs:
  using: composite
  steps:
    - uses: ./.github/actions/self
`,
    '.github/workflows/boundary.yml': `name: Boundary
on: workflow_dispatch
permissions:
  contents: read
jobs:
  verify:
    runs-on: ubuntu-latest
    steps:
      - uses: ./../outside/action
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
  ])
})

// Mutation caught: normalising POSIX backslashes as separators would hide an ancestor symlink behind a slash-shaped path.
test('rejects a POSIX ancestor symlink whose backslash name resembles a slash path', {
  skip: process.platform === 'win32' ? 'Windows treats backslashes as path separators.' : false,
}, () => {
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
      - uses: ./.github/actions/slash\\path/checked
`,
  })
  symlinkSync(join(root, '.github/actions/slash/path'), join(root, '.github/actions/slash\\path'), directorySymlinkType)

  assert.deepEqual(inspectWorkflowPolicy(root), [
    {
      file: '.github/workflows/backslash.yml',
      location: 'jobs.verify.steps[0].uses',
      rule: 'local-reference',
    },
  ])
})

// Mutation caught: trusting lexical paths, directory defaults, or raw parsing would accept unsafe targets or crash on malformed YAML.
test('accepts only unambiguous regular local YAML targets within the native repository path', () => {
  const root = createFixture({
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
      - uses: ./.github/actions/ambiguous
      - uses: ./.github/actions/symlinked
      - uses: ./.github/actions/missing
      - uses: ./.github/actions/invalid
`,
  })
  const outside = createFixture({
    'action/action.yml': `name: Outside
runs:
  using: composite
  steps: []
`,
  })
  symlinkSync(join(outside, 'action/action.yml'), join(root, '.github/actions/ambiguous/action.yaml'))
  symlinkSync(join(outside, 'action'), join(root, '.github/actions/symlinked'), directorySymlinkType)

  assert.deepEqual(inspectWorkflowPolicy(root), [
    {
      file: '.github/actions/invalid/action.yml',
      location: '$',
      rule: 'local-reference',
    },
    {
      file: '.github/workflows/invalid.yaml',
      location: '$',
      rule: 'local-reference',
    },
    {
      file: '.github/workflows/local-files.yml',
      location: 'jobs.verify.steps[0].uses',
      rule: 'local-reference',
    },
    {
      file: '.github/workflows/local-files.yml',
      location: 'jobs.verify.steps[1].uses',
      rule: 'local-reference',
    },
    {
      file: '.github/workflows/local-files.yml',
      location: 'jobs.verify.steps[2].uses',
      rule: 'local-reference',
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
    'linked.yml': `name: Linked
on: workflow_dispatch
permissions:
  contents: read
jobs: {}
`,
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
  symlinkSync(join(outside, 'linked.yml'), join(candidateRoot, '.github/workflows/linked.yml'))

  assert.deepEqual(inspectWorkflowPolicy(symlinkedDirectoryRoot), [
    {
      file: '.github/workflows',
      location: '$',
      rule: 'local-reference',
    },
  ])
  assert.deepEqual(inspectWorkflowPolicy(candidateRoot), [
    {
      file: '.github/workflows/directory.yaml',
      location: '$',
      rule: 'local-reference',
    },
    {
      file: '.github/workflows/linked.yml',
      location: '$',
      rule: 'local-reference',
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
      rule: 'local-reference',
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
      rule: 'local-reference',
    },
  ]
  assert.deepEqual(inspectWorkflowPolicy(danglingGithubRoot), expectedFinding)
  assert.deepEqual(inspectWorkflowPolicy(danglingWorkflowsRoot), expectedFinding)
})

// Mutation caught: weakening external-reference validation would accept Docker, short, uppercase, or owner-less action references.
test('accepts only owner and repository references pinned to a lowercase full commit', () => {
  const root = createFixture({
    '.github/workflows/references.yml': `name: References
on: workflow_dispatch
permissions:
  contents: read
jobs:
  verify:
    runs-on: ubuntu-latest
    steps:
      - uses: owner/repository/path@0123456789abcdef0123456789abcdef01234567
      - uses: docker://alpine@0123456789abcdef0123456789abcdef01234567
      - uses: action@0123456789abcdef0123456789abcdef01234567
      - uses: owner/action@0123456789ABCDEF0123456789ABCDEF01234567
`,
  })

  assert.deepEqual(inspectWorkflowPolicy(root), [
    {
      file: '.github/workflows/references.yml',
      location: 'jobs.verify.steps[1].uses',
      rule: 'external-action-sha',
    },
    {
      file: '.github/workflows/references.yml',
      location: 'jobs.verify.steps[2].uses',
      rule: 'external-action-sha',
    },
    {
      file: '.github/workflows/references.yml',
      location: 'jobs.verify.steps[3].uses',
      rule: 'external-action-sha',
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
      rule: 'external-action-sha',
    },
    {
      file: '.github/workflows/z.yml',
      location: 'jobs.a.steps[0].uses',
      rule: 'external-action-sha',
    },
    {
      file: '.github/workflows/z.yml',
      location: 'jobs.z.steps[0].uses',
      rule: 'external-action-sha',
    },
  ])
  assert.equal(
    formatWorkflowPolicyFindings(findings),
    `.github/workflows/a.yaml:jobs.verify.steps[0].uses: external-action-sha
.github/workflows/z.yml:jobs.a.steps[0].uses: external-action-sha
.github/workflows/z.yml:jobs.z.steps[0].uses: external-action-sha
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
      - uses: ./.github/actions/checked
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
  assert.equal(failing.stderr, '.github/workflows/fail.yml:jobs.verify.steps[0].uses: external-action-sha\n')
})

// This suite owns the structural workflow security contract; test/package.test.ts independently guards its CI bootstrap.
// Mutation caught: mutable actions, hidden local wrappers, unprotected credentials, or write permissions would escape repository policy.
test('repository workflows obey immutable action and credential boundaries', () => {
  assert.deepEqual(inspectWorkflowPolicy(repositoryRoot), [])

  // Mutation caught: removing push: disabled would restore Pullfrog's write-capable Git token and push tools.
  const pullfrogWorkflow = Bun.YAML.parse(
    readFileSync(join(repositoryRoot, '.github/workflows/pullfrog.yml'), 'utf8'),
  ) as PullfrogWorkflow
  const pullfrogJob = pullfrogWorkflow.jobs.pullfrog
  assertExactPullfrogWorkflow(pullfrogWorkflow)
  const { true: bunTrigger, ...stablePullfrogWorkflow } = pullfrogWorkflow
  assertExactPullfrogWorkflow({ ...stablePullfrogWorkflow, on: bunTrigger })
  assert.throws(() => assertExactPullfrogWorkflow({ ...pullfrogWorkflow, on: pullfrogWorkflow.true }))

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

  const ciWorkflow = Bun.YAML.parse(
    readFileSync(join(repositoryRoot, '.github/workflows/ci.yml'), 'utf8'),
  ) as CiWorkflow
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
  const ciCheckoutSteps = Object.values(ciWorkflow.jobs).flatMap(job =>
    job.steps.filter(step => typeof step.uses === 'string' && step.uses.startsWith('actions/checkout@')),
  )
  assert.equal(ciCheckoutSteps.length, 2)
  assert.equal(
    ciCheckoutSteps.every(step => step.with?.['persist-credentials'] === false),
    true,
  )

  const dependabotConfiguration = Bun.YAML.parse(readFileSync(join(repositoryRoot, '.github/dependabot.yml'), 'utf8'))
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

  const packageJson = JSON.parse(readFileSync(join(repositoryRoot, 'package.json'), 'utf8')) as {
    scripts?: Readonly<Record<string, unknown>>
  }
  assert.equal(
    packageJson.scripts?.['check:workflows'],
    'bun test scripts/workflow-policy.test.ts && bun run scripts/workflow-policy.ts',
  )
})
