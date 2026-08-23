import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { formatWorkflowPolicyFindings, inspectWorkflowPolicy } from './workflow-policy.ts'

const temporaryRoots: string[] = []
const policyPath = fileURLToPath(new URL('./workflow-policy.ts', import.meta.url))

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
  const absentRoot = createFixture({
    'README.md': 'No workflows\n',
  })
  const root = createFixture({
    '.github/workflows': 'not a directory\n',
  })

  assert.deepEqual(inspectWorkflowPolicy(absentRoot), [])
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
      file: '.github/workflows/missing.yml',
      location: 'permissions',
      rule: 'permission',
    },
    {
      file: '.github/workflows/oidc.yml',
      location: 'jobs.verify.permissions.id-token',
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
  symlinkSync(join(outside, 'action'), join(root, '.github/actions/symlinked'))

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
