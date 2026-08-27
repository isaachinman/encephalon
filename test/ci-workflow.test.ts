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

test('passes one exact package candidate through runtime and release-equivalent gates', () => {
  const workflow = readFileSync(resolve(root, '.github', 'workflows', 'ci.yml'), 'utf8')
  const readme = readFileSync(resolve(root, 'README.md'), 'utf8')
  const contract = readFileSync(resolve(root, 'docs', 'contract.md'), 'utf8')
  const publishCheck = readFileSync(resolve(root, 'scripts', 'check-publish.ts'), 'utf8')
  const packageJson = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as {
    scripts?: Record<string, unknown>
  }
  const generatedVersionScript = String(packageJson.scripts?.['check:generated'])
  const packageScript = String(packageJson.scripts?.['check:package'])
  const publishScript = String(packageJson.scripts?.['check:publish'])
  const eventsStart = workflow.indexOf('\non:\n') + 1
  const permissionsStart = workflow.indexOf('\npermissions:\n', eventsStart)
  const concurrencyStart = workflow.indexOf('\nconcurrency:\n', permissionsStart)
  const jobsStart = workflow.indexOf('\njobs:\n')
  const packageStart = workflow.indexOf('\n  package:\n', jobsStart)
  const candidateStart = workflow.indexOf('\n  candidate:\n', packageStart)
  const releaseStart = workflow.indexOf('\n  release:\n', candidateStart)
  const workflowConfiguration = workflow.slice(0, jobsStart)
  const verificationJob = workflow.slice(jobsStart, packageStart)
  const packageJob = workflow.slice(packageStart, candidateStart)
  const candidateJob = workflow.slice(candidateStart, releaseStart)
  const releaseJob = workflow.slice(releaseStart)
  const candidateTarball = 'package-artifacts/encephalon-0.3.0.tgz'
  const materialiseCandidate =
    "tar --extract --gzip --file package-artifacts/encephalon-0.3.0.tgz --strip-components=1 --wildcards 'package/dist/*'"
  const matrixStart = verificationJob.indexOf('      matrix:\n')
  const runnerStart = verificationJob.indexOf('    runs-on:', matrixStart)
  const matrixBlock = verificationJob.slice(matrixStart, runnerStart)
  const verificationStepsStart = verificationJob.indexOf('    steps:\n')
  const verificationHeader = verificationJob.slice(0, matrixStart)
  const verificationRunner = verificationJob.slice(runnerStart, verificationStepsStart)
  const verificationSteps = verificationJob.slice(verificationStepsStart)

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
  assert.doesNotMatch(workflow, /NODE_AUTH_TOKEN|NPM_TOKEN|\.npmrc|registry-url|always-auth/u)
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
    /^ {4}steps:\n {6}- uses: actions\/checkout@\S+\n {8}with:\n {10}persist-credentials: false\n {6}- uses: actions\/setup-node@\S+\n {8}with:\n {10}node-version: 24\.15\.0\n {6}- run: node \.\/scripts\/check-generated-version\.ts\n {6}- if: matrix\.context == 'ubuntu-current'\n {8}uses: actions\/setup-node@\S+\n {8}with:\n {10}node-version: \$\{\{ matrix\.node \}\}\n {6}- uses: oven-sh\/setup-bun@v2\n {8}with:\n {10}bun-version: 1\.3\.1\n {6}- run: bun install --frozen-lockfile\n/u
  assert.match(verificationSteps, trustedVerificationPrefix)
  assert.doesNotMatch(
    verificationSteps.replace('    steps:\n', '    steps:\n      - uses: ./.github/actions/repair-generated-source\n'),
    trustedVerificationPrefix,
  )
  assert.deepEqual(
    [...verificationSteps.matchAll(/^\s+(?:- )?run: (.+)$/gm)].map(match => match[1]),
    [
      'node ./scripts/check-generated-version.ts',
      'bun install --frozen-lockfile',
      'bun run typecheck',
      'bun run test',
      'bun run lint',
      'bun run benchmark:check',
    ],
  )
  assert.equal(verificationSteps.match(/^\s+(?:- )?run:/gm)?.length, 6)
  assert.equal(verificationSteps.match(/^\s{6}- if:/gm)?.length, 1)
  assert.doesNotMatch(verificationSteps, /^\s{8}continue-on-error:/m)

  assert.match(
    packageJob,
    /^\n {2}package:\n {4}name: Build exact package candidate\n {4}needs: verify\n {4}runs-on: ubuntu-latest\n/u,
  )
  assert.match(
    candidateJob,
    /^\n {2}candidate:\n {4}name: candidate \(Node \$\{\{ matrix\.node \}\}\)\n {4}needs: package\n/u,
  )
  assert.match(candidateJob, /matrix:\n {8}node:\n {10}- 24\.15\.0\n {10}- 26\n {4}runs-on: ubuntu-latest/u)
  assert.match(
    releaseJob,
    /^\n {2}release:\n {4}name: Release-equivalent package gate\n {4}needs: candidate\n {4}runs-on: ubuntu-latest\n/u,
  )
  assert.doesNotMatch(`${packageJob}${candidateJob}${releaseJob}`, /^ {4}(?:if|continue-on-error|permissions):/m)

  for (const sourceBuildingJob of [verificationJob, packageJob]) {
    const setupNode = sourceBuildingJob.indexOf('uses: actions/setup-node@')
    const generatedVersion = sourceBuildingJob.indexOf('run: node ./scripts/check-generated-version.ts')
    const setupBun = sourceBuildingJob.indexOf('uses: oven-sh/setup-bun@v2')
    const install = sourceBuildingJob.indexOf('run: bun install --frozen-lockfile')
    assert.equal(
      [setupNode, generatedVersion, setupBun, install].every(
        (position, index, positions) =>
          position >= 0 && (index === 0 || position > (positions[index - 1] ?? Number.POSITIVE_INFINITY)),
      ),
      true,
    )
  }

  assert.deepEqual(
    [...packageJob.matchAll(/^\s{6}- run: (.+)$/gm)].map(match => match[1]),
    [
      'node ./scripts/check-generated-version.ts',
      'bun install --frozen-lockfile',
      'git diff --exit-code HEAD',
      'bun run build',
      'git diff --exit-code HEAD',
      'git diff --exit-code HEAD',
      `sha256sum ${candidateTarball}`,
    ],
  )
  assert.match(
    packageJob,
    /- name: Check and retain exact package candidate\n\s+env:\n\s+NODE_OPTIONS: ''\n\s+NODE_PATH: ''\n\s+run: node \.\/scripts\/check-package\.ts --retain-tarball package-artifacts/u,
  )
  const build = packageJob.indexOf('bun run build')
  const packageCheck = packageJob.indexOf('node ./scripts/check-package.ts --retain-tarball package-artifacts')
  const cleanTreeChecks = [...packageJob.matchAll(/git diff --exit-code HEAD/g)].map(match => match.index)
  assert.equal(cleanTreeChecks.length, 3)
  assert.equal((cleanTreeChecks[0] ?? Number.POSITIVE_INFINITY) < build, true)
  assert.equal(
    (cleanTreeChecks[1] ?? -1) > build && (cleanTreeChecks[1] ?? Number.POSITIVE_INFINITY) < packageCheck,
    true,
  )
  assert.equal((cleanTreeChecks[2] ?? -1) > packageCheck, true)
  assert.match(
    packageJob,
    new RegExp(
      `- name: Upload exact package candidate\\n\\s+uses: actions/upload-artifact@\\S+\\n\\s+with:\\n\\s+name: encephalon-npm-package\\n\\s+path: ${candidateTarball.replaceAll('.', '\\.')}\\n\\s+if-no-files-found: error\\n\\s+retention-days: 7`,
      'u',
    ),
  )
  assert.doesNotMatch(packageJob, /github\.event_name|github\.ref/u)

  assert.match(
    candidateJob,
    new RegExp(
      `actions/download-artifact@\\S+\\n\\s+with:\\n\\s+name: encephalon-npm-package\\n\\s+path: package-artifacts[\\s\\S]+node \\.\\/scripts\\/check-package\\.ts --tarball ${candidateTarball.replaceAll('.', '\\.')}`,
      'u',
    ),
  )
  assert.equal(candidateJob.match(/node \.\/scripts\/check-package\.ts --tarball/g)?.length, 1)
  assert.equal(candidateJob.includes(`run: ${materialiseCandidate}`), true)
  assert.equal(
    candidateJob.indexOf(materialiseCandidate) < candidateJob.indexOf('node ./scripts/check-package.ts --tarball'),
    true,
  )
  assert.doesNotMatch(candidateJob, /bun run build|--retain-tarball|npm pack/u)

  assert.match(
    releaseJob,
    new RegExp(
      `actions/download-artifact@\\S+\\n\\s+with:\\n\\s+name: encephalon-npm-package\\n\\s+path: package-artifacts[\\s\\S]+node \\.\\/scripts\\/check-package\\.ts --tarball ${candidateTarball.replaceAll('.', '\\.')}[\\s\\S]+node \\.\\/scripts\\/check-release-compatibility\\.ts ${candidateTarball.replaceAll('.', '\\.')}[\\s\\S]+node \\.\\/scripts\\/check-publish\\.ts ${candidateTarball.replaceAll('.', '\\.')}`,
      'u',
    ),
  )
  assert.equal(releaseJob.match(/node \.\/scripts\/check-package\.ts --tarball/g)?.length, 1)
  assert.equal(releaseJob.includes(`run: ${materialiseCandidate}`), true)
  assert.equal(
    releaseJob.indexOf(materialiseCandidate) < releaseJob.indexOf('node ./scripts/check-package.ts --tarball'),
    true,
  )
  assert.equal(releaseJob.match(/node \.\/scripts\/check-release-compatibility\.ts/g)?.length, 1)
  assert.equal(releaseJob.match(/node \.\/scripts\/check-publish\.ts/g)?.length, 1)
  assert.doesNotMatch(releaseJob, /bun run build|--retain-tarball|npm pack/u)

  assert.equal(workflow.match(/bun run build/g)?.length, 1)
  assert.equal(workflow.match(/node \.\/scripts\/check-package\.ts --retain-tarball/g)?.length, 1)
  assert.equal(workflow.match(/actions\/upload-artifact/g)?.length, 1)
  assert.equal(workflow.match(/actions\/download-artifact/g)?.length, 2)
  assert.equal(workflow.match(/node \.\/scripts\/check-generated-version\.ts/g)?.length, 2)
  assert.equal(workflow.match(/actions\/checkout/g)?.length, 4)
  assert.equal(workflow.match(/persist-credentials: false/g)?.length, 4)
  assert.doesNotMatch(workflow, /^ {4}permissions:/m)
  assert.doesNotMatch(workflow, /^\s+- run: (?:npm publish|bun run check:publish)(?:\s|$)/m)
  assert.doesNotMatch(workflow, /steps\.[\w-]+\.outputs|GITHUB_OUTPUT|npm pkg get/u)
  assert.doesNotMatch(workflow, /^\s+- run: bun run \.\/scripts\/check-generated-version\.ts$/m)
  assert.doesNotMatch(workflow, /^\s+- run: bun run check:generated$/m)

  assert.match(readme, /four verification lanes/)
  assert.match(readme, /pull requests and trusted pushes to `main`/)
  assert.match(readme, /SHA-256 digest/)
  assert.match(readme, /published npm oracle requires network access/)
  assert.match(contract, /exact candidate artifact/)
  assert.match(contract, /byte-identical/)
  assert.match(contract, /manual.*tarball-only publish/)
  assert.doesNotMatch(readme, /runner-local storage/)

  assert.equal(generatedVersionScript, 'bun run scripts/check-generated-version.ts')
  assert.equal(packageScript, 'node ./scripts/check-package.ts')
  assert.equal(publishScript, 'node ./scripts/check-publish.ts')
  assert.equal(publishCheck.includes("'--dry-run'"), true)
  assert.equal(publishCheck.includes("'--ignore-scripts'"), true)
})
