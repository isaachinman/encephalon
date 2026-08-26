import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { test } from 'node:test'
import { workflowContainsSecretsContext } from './support/ci-workflow-policy.ts'

const root = resolve(import.meta.dirname, '..')
const githubExpression = (source: string) => `\${{ ${source} }}`

test('detects GitHub Actions secrets contexts in expressions and implicit conditions', () => {
  for (const workflow of [
    `env:\n  TOKEN: ${githubExpression('secrets.NPM_TOKEN')}\n`,
    `env:\n  TOKEN: ${githubExpression("secrets['NPM_TOKEN']")}\n`,
    `env:\n  TOKEN: ${githubExpression('secrets["NPM_TOKEN"]')}\n`,
    `env:\n  TOKEN: ${githubExpression("format('{1}', '}}', secrets['NPM_TOKEN'])")}\n`,
    `env:\n  TOKEN: ${githubExpression("format('{{0}}', secrets.NPM_TOKEN)")}\n`,
    `env:\n  TOKEN: prefix ${githubExpression('github.ref')} middle ${githubExpression('secrets.NPM_TOKEN')} suffix\n`,
    `env:\n  TOKEN: ${githubExpression('toJson(secrets)')}\n`,
    `env:\n  TOKEN: ${githubExpression('secrets != null')}\n`,
    'env:\n  TOKEN: "\\u0024{{ secrets.NPM_TOKEN }}"\n',
    'env:\n  TOKEN: "\\x24{{ secrets.NPM_TOKEN }}"\n',
    'env:\n  TOKEN: "\\U00000024{{ secrets.NPM_TOKEN }}"\n',
    'env:\n  TOKEN: "$\\\n    {{ secrets.NPM_TOKEN }}"\n',
    "jobs:\n  verify:\n    if: secrets.RUN_VERIFY == 'true'\n",
    "steps:\n  - if: secrets.RUN_STEP == 'true'\n    run: echo safe\n",
    'jobs:\n  verify:\n    if: >-\n      secrets.RUN_VERIFY\n',
    'jobs: { verify: { if: secrets.RUN_VERIFY, runs-on: ubuntu-latest } }\n',
    "env:\n  CONDITION: &condition secrets.RUN_VERIFY == 'true'\njobs:\n  verify:\n    if: *condition\n",
    "jobs:\n  verify:\n    if: github.ref == 'refs/heads/main' &&\n      secrets.RUN_VERIFY == 'true'\n",
    "jobs:\n  verify:\n    if:\n      github.ref == 'refs/heads/main' &&\n      secrets.RUN_VERIFY == 'true'\n",
    `steps:\n  - run: |\n      # ${githubExpression('secrets.NPM_TOKEN')}\n`,
    `env:\n  "${githubExpression('secrets.DYNAMIC_NAME')}": value\n`,
  ]) {
    assert.equal(workflowContainsSecretsContext(workflow), true, workflow)
  }
})

test('ignores secrets-shaped ordinary text outside GitHub Actions expressions', () => {
  for (const workflow of [
    `env:\n  REF: ${githubExpression('github.ref')}\n`,
    `env:\n  NOTE: ${githubExpression("'secrets.NPM_TOKEN'")}\n`,
    `env:\n  NOTE: ${githubExpression('github.secrets')}\n`,
    "jobs:\n  verify:\n    if: github.ref ==\n      'refs/heads/main'\n",
    "jobs:\n  verify:\n    if:\n      github.ref ==\n      'refs/heads/main'\n",
    "steps:\n  - if: github.ref == 'refs/heads/main'\n    run: echo secrets.RUN_STEP\n",
    'env:\n  NOTE: repository secrets are unavailable to pull requests\n',
    '# secrets.NPM_TOKEN must never be used here\nenv:\n  SAFE: true\n',
    `# ${githubExpression('secrets.NPM_TOKEN')} is documentation only\nenv:\n  SAFE: true\n`,
    'steps:\n  - run: echo "do not use secrets.NPM_TOKEN here"\n',
    `steps:\n  - run: echo 'do not use secrets["NPM_TOKEN"] here'\n`,
  ]) {
    assert.equal(workflowContainsSecretsContext(workflow), false, workflow)
  }
})

test('runs pull-request and current-Node package checks with a trusted release gate', () => {
  const workflow = readFileSync(resolve(root, '.github', 'workflows', 'ci.yml'), 'utf8')
  const readme = readFileSync(resolve(root, 'README.md'), 'utf8')
  const publishCheck = readFileSync(resolve(root, 'scripts', 'check-publish.ts'), 'utf8')
  const packageJson = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as {
    scripts?: Record<string, unknown>
  }
  const generatedVersionScript = String(packageJson.scripts?.['check:generated'])
  const packageScript = String(packageJson.scripts?.['check:package'])
  const publishScript = String(packageJson.scripts?.['check:publish'])
  const workflowPolicyScript = String(packageJson.scripts?.['check:workflows'])
  const eventsStart = workflow.indexOf('\non:\n') + 1
  const permissionsStart = workflow.indexOf('\npermissions:\n', eventsStart)
  const concurrencyStart = workflow.indexOf('\nconcurrency:\n', permissionsStart)
  const jobsStart = workflow.indexOf('\njobs:\n')
  const releaseStart = workflow.indexOf('\n  release:\n', jobsStart)
  const workflowConfiguration = workflow.slice(0, jobsStart)
  const verificationJob = workflow.slice(jobsStart, releaseStart)
  const releaseJob = workflow.slice(releaseStart)
  const matrixStart = verificationJob.indexOf('      matrix:\n')
  const runnerStart = verificationJob.indexOf('    runs-on:', matrixStart)
  const matrixBlock = verificationJob.slice(matrixStart, runnerStart)
  const verificationStepsStart = verificationJob.indexOf('    steps:\n')
  const verificationHeader = verificationJob.slice(0, matrixStart)
  const verificationRunner = verificationJob.slice(runnerStart, verificationStepsStart)
  const verificationSteps = verificationJob.slice(verificationStepsStart)
  const releaseStepsStart = releaseJob.indexOf('    steps:\n')
  const releaseHeader = releaseJob.slice(0, releaseStepsStart)
  const releaseSteps = releaseJob.slice(releaseStepsStart)
  const uploadActionStart = releaseJob.indexOf('      - name: Upload trusted release-equivalent package artifact\n')
  const uploadStep = releaseJob.slice(uploadActionStart)

  assert.equal(
    workflow.slice(eventsStart, permissionsStart),
    `on:
  push:
    branches:
      - main
  pull_request:
    branches:
      - main
    types: [opened, reopened, synchronize, edited]
`,
  )
  assert.doesNotMatch(workflow.slice(eventsStart, permissionsStart), /paths|ignore|workflow_dispatch|schedule/)
  assert.equal(
    workflow.slice(permissionsStart + 1, concurrencyStart),
    `permissions:
  contents: read
`,
  )
  assert.doesNotMatch(workflowConfiguration, /^(?:defaults|env):/gmu)
  assert.equal(workflowContainsSecretsContext(workflow), false)
  assert.match(
    workflowConfiguration,
    /concurrency:\n\s+group: \$\{\{ github\.workflow \}\}-\$\{\{ github\.event\.pull_request\.number \|\| github\.run_id \}\}\n\s+cancel-in-progress: true/,
  )

  assert.equal(
    verificationHeader,
    `
jobs:
  verify:
    name: verify (\${{ matrix.context }})
    strategy:
      fail-fast: false
`,
  )
  assert.equal(
    matrixBlock,
    `      matrix:
        include:
          - context: ubuntu-latest
            os: ubuntu-latest
            node: 24.15.0
          - context: macos-latest
            os: macos-latest
            node: 24.15.0
          - context: windows-latest
            os: windows-latest
            node: 24.15.0
          - context: ubuntu-current
            os: ubuntu-latest
            node: 26
`,
  )
  assert.match(verificationRunner, /^ {4}runs-on: \$\{\{ matrix\.os \}\}\n$/)
  assert.doesNotMatch(verificationJob, /^ {4}(?:if|continue-on-error|permissions):/m)
  const trustedVerificationPrefix =
    /^ {4}steps:\n {6}- uses: actions\/checkout@[^\n]+\n {8}with:\n {10}persist-credentials: false\n {6}- uses: actions\/setup-node@[^\n]+\n {8}with:\n {10}node-version: 24\.15\.0\n {6}- run: node \.\/scripts\/check-generated-version\.ts\n {6}- if: matrix\.context == 'ubuntu-current'\n {8}uses: actions\/setup-node@[^\n]+\n {8}with:\n {10}node-version: \$\{\{ matrix\.node \}\}\n {6}- uses: oven-sh\/setup-bun@[^\n]+\n {8}with:\n {10}bun-version: 1\.3\.1\n {6}- run: bun install --frozen-lockfile --ignore-scripts\n/u
  assert.match(verificationSteps, trustedVerificationPrefix)
  assert.doesNotMatch(
    verificationSteps.replace('    steps:\n', '    steps:\n      - uses: ./.github/actions/repair-generated-source\n'),
    trustedVerificationPrefix,
  )
  assert.deepEqual(
    [...verificationSteps.matchAll(/^\s+(?:- )?run: (.+)$/gm)].map(match => match[1]),
    [
      'node ./scripts/check-generated-version.ts',
      'bun install --frozen-lockfile --ignore-scripts',
      'node --test scripts/workflow-policy.test.ts',
      'node ./scripts/workflow-policy.ts',
      'bun run typecheck',
      'bun run test',
      'bun run lint',
      'bun run benchmark:check',
      'bun run build',
      'git diff --exit-code HEAD',
      'node ./scripts/check-package.ts',
      'git diff --exit-code HEAD',
    ],
  )
  assert.equal(verificationSteps.match(/^\s+(?:- )?run:/gm)?.length, 12)
  assert.equal(verificationSteps.match(/^\s{6}- if:/gm)?.length, 1)
  assert.doesNotMatch(verificationSteps, /^\s{8}continue-on-error:/m)
  assert.match(
    verificationJob,
    /- run: node \.\/scripts\/check-package\.ts\n {8}env:\n {10}NODE_OPTIONS: ''\n {10}NODE_PATH: ''/u,
  )

  assert.equal(
    releaseHeader,
    `
  release:
    name: Release-equivalent package gate
    needs: verify
    runs-on: ubuntu-latest
`,
  )
  assert.doesNotMatch(releaseJob, /^ {4}permissions:/m)
  const trustedReleasePrefix =
    /^ {4}steps:\n {6}- uses: actions\/checkout@[^\n]+\n {8}with:\n {10}persist-credentials: false\n {6}- uses: actions\/setup-node@[^\n]+\n {8}with:\n {10}node-version: 24\.15\.0\n {6}- run: node \.\/scripts\/check-generated-version\.ts\n {6}- uses: oven-sh\/setup-bun@[^\n]+\n {8}with:\n {10}bun-version: 1\.3\.1\n {6}- run: bun install --frozen-lockfile --ignore-scripts\n/u
  assert.match(releaseSteps, trustedReleasePrefix)
  assert.doesNotMatch(
    releaseSteps.replace('    steps:\n', '    steps:\n      - run: bun run repair-generated-source\n'),
    trustedReleasePrefix,
  )
  assert.deepEqual(
    [...releaseSteps.matchAll(/^\s{6}- run: (.+)$/gm)].map(match => match[1]),
    [
      'node ./scripts/check-generated-version.ts',
      'bun install --frozen-lockfile --ignore-scripts',
      'node --test scripts/workflow-policy.test.ts',
      'node ./scripts/workflow-policy.ts',
      'bun run build',
      'git diff --exit-code HEAD',
      'git diff --exit-code HEAD',
    ],
  )
  assert.equal(releaseSteps.match(/^\s+(?:- )?run:/gm)?.length, 9)
  assert.equal(releaseSteps.match(/^\s{8}if:/gm)?.length, 1)
  assert.doesNotMatch(releaseSteps, /^\s{8}continue-on-error:/m)
  assert.equal(releaseJob.match(/npm pack --dry-run=false/g)?.length ?? 0, 0)
  assert.match(
    releaseJob,
    /- name: Check npm publish dry run\n\s+env:\n\s+NODE_OPTIONS: ''\n\s+NODE_PATH: ''\n\s+run: node \.\/scripts\/check-publish\.ts/,
  )
  assert.match(
    releaseJob,
    /- name: Check and retain release-equivalent package artifact\n\s+id: package\n\s+shell: bash\n\s+env:\n\s+NODE_OPTIONS: ''\n\s+NODE_PATH: ''\n\s+run: \|\n\s+retained_tarball=\$\(node \.\/scripts\/check-package\.ts --retain-tarball package-artifacts\)\n\s+echo "tarball=\$retained_tarball" >> "\$GITHUB_OUTPUT"/,
  )
  assert.equal(releaseJob.match(/node \.\/scripts\/check-publish\.ts/g)?.length, 1)
  assert.equal(releaseJob.match(/node \.\/scripts\/check-package\.ts --retain-tarball/g)?.length, 1)
  assert.equal(releaseJob.match(/actions\/upload-artifact/g)?.length, 1)
  assert.match(
    releaseJob,
    /- name: Upload trusted release-equivalent package artifact\n\s+if: success\(\) && github\.event_name == 'push' && github\.ref == 'refs\/heads\/main'\n\s+uses: actions\/upload-artifact@\S+/,
  )
  assert.equal(
    [
      'node ./scripts/check-generated-version.ts',
      'bun run build',
      'git diff --exit-code HEAD',
      'node ./scripts/check-publish.ts',
      'node ./scripts/check-package.ts --retain-tarball package-artifacts',
      'actions/upload-artifact',
    ]
      .map(step => releaseJob.indexOf(step))
      .every(
        (position, index, positions) =>
          position >= 0 && (index === 0 || position > (positions[index - 1] ?? Number.POSITIVE_INFINITY)),
      ),
    true,
  )
  assert.equal(
    releaseJob.lastIndexOf('git diff --exit-code HEAD') >
      releaseJob.indexOf('node ./scripts/check-package.ts --retain-tarball package-artifacts'),
    true,
  )
  assert.equal(
    uploadStep
      .split('\n')
      .filter(line => !line.includes('uses: actions/upload-artifact@'))
      .slice(1)
      .join('\n'),
    `        if: success() && github.event_name == 'push' && github.ref == 'refs/heads/main'
        with:
          name: encephalon-npm-package
          path: \${{ steps.package.outputs.tarball }}
          if-no-files-found: error
          retention-days: 7
`,
  )

  assert.doesNotMatch(workflow, /\n {2}upload:\n/)
  assert.equal(workflow.match(/node \.\/scripts\/check-generated-version\.ts/g)?.length, 2)
  assert.doesNotMatch(workflow, /^\s+- run: bun run \.\/scripts\/check-generated-version\.ts$/m)
  assert.doesNotMatch(workflow, /^\s+- run: bun run check:generated$/m)
  assert.doesNotMatch(workflow, /^\s+- run: bun run check:workflows$/m)
  assert.doesNotMatch(workflow, /^\s+- run: bun (?:run|test).*workflow-policy/m)
  assert.equal(workflow.match(/^\s+- run: bun install --frozen-lockfile --ignore-scripts$/gmu)?.length, 2)
  assert.doesNotMatch(workflow, /^\s+- run: bun install --frozen-lockfile$/m)
  const pinnedActionReferences = [...workflow.matchAll(/^\s+(?:- )?uses: [^@\s]+@([^\s#]+)/gmu)].map(match => match[1])
  assert.equal(pinnedActionReferences.length, 8)
  assert.equal(
    pinnedActionReferences.every(reference => /^[0-9a-f]{40}$/u.test(reference ?? '')),
    true,
  )
  assert.equal(workflow.match(/^\s+- run: git diff --exit-code HEAD$/gmu)?.length, 4)
  assert.equal(workflow.match(/NODE_OPTIONS: ''/g)?.length, 3)
  assert.equal(workflow.match(/NODE_PATH: ''/g)?.length, 3)
  assert.match(readme, /four verification lanes/)
  assert.match(readme, /trusted pushes to `main`/)
  assert.match(readme, /release-equivalent package gate/)
  assert.equal(generatedVersionScript, 'bun run scripts/check-generated-version.ts')
  assert.equal(packageScript, 'node ./scripts/check-package.ts')
  assert.equal(publishScript, 'node ./scripts/check-publish.ts')
  assert.equal(workflowPolicyScript, 'bun test scripts/workflow-policy.test.ts && bun run scripts/workflow-policy.ts')
  assert.equal(publishCheck.includes("'--dry-run'"), true)
  assert.equal(publishCheck.includes("'--ignore-scripts'"), true)
})
