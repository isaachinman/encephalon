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

test('parallel CI retains complete verification and exact-package release gates', () => {
  const workflow = readFileSync(resolve(root, '.github/workflows/ci.yml'), 'utf8')
  const jobs = Object.fromEntries(
    [...workflow.matchAll(/^ {2}([a-z-]+):\n([\s\S]*?)(?=^ {2}[a-z-]+:\n|$(?![\s\S]))/gm)].map(match => [
      match[1],
      match[2] ?? '',
    ]),
  )
  assert.match(workflow, /permissions:\n {2}contents: read\n/)
  assert.equal(workflowContainsSecretsContext(workflow), false)
  assert.doesNotMatch(workflow, /NODE_AUTH_TOKEN|NPM_TOKEN|registry-url|pull_request_target|continue-on-error/)
  assert.match(workflow, /types: \[opened, reopened, synchronize\]/)
  assert.match(workflow, /cancel-in-progress: true/)
  for (const name of [
    'correctness',
    'compatibility',
    'performance',
    'verify',
    'package',
    'candidate',
    'release-checks',
    'release',
  ]) {
    const job = jobs[name]
    assert.ok(job, name)
    assert.match(job, /timeout-minutes: [1-9]\n/)
    assert.doesNotMatch(job, /permissions:/)
    if (job.includes('actions/checkout@')) {
      assert.match(job, /persist-credentials: false/)
      assert.match(job, /ref: \$\{\{ github.event.pull_request.head.sha \|\| github.sha \}\}/)
    }
  }
  const correctness = jobs.correctness ?? ''
  assert.match(correctness, /context: ubuntu-latest/)
  assert.match(correctness, /context: macos-latest/)
  assert.match(correctness, /context: windows-latest/)
  assert.match(correctness, /context: ubuntu-current/)
  assert.match(correctness, /bun run typecheck/)
  assert.match(correctness, /bun run lint/)
  assert.match(correctness, /bun run benchmark:check/)
  assert.match(correctness, /node scripts\/test-ci.ts.*windows-latest.*main.*all/)
  assert.match(jobs.compatibility ?? '', /group: \[compatibility-a, compatibility-b, compatibility-c\]/)
  assert.match(jobs.compatibility ?? '', /runs-on: windows-latest/)
  const performance = jobs.performance ?? ''
  assert.match(performance, /runs-on: ubuntu-latest/)
  assert.match(performance, /fetch-depth: 0/)
  assert.match(performance, /node scripts\/benchmark-compare.ts.*20.*matrix.shard/)
  assert.match(performance, /name: performance-\$\{\{ github.run_attempt \}\}-\$\{\{ matrix.shard \}\}/)
  assert.match(jobs.verify ?? '', /needs: \[correctness, compatibility, performance\]/)
  assert.match(jobs.verify ?? '', /node scripts\/benchmark-aggregate.ts/)
  assert.match(jobs.verify ?? '', /pattern: performance-\$\{\{ github.run_attempt \}\}-\*/)
  for (const name of ['verify', 'release']) {
    assert.match(jobs[name] ?? '', /if: always\(\)/)
    assert.match(jobs[name] ?? '', /every\(job => job.result === "success"\)/)
  }
  const packageJob = jobs.package ?? ''
  assert.doesNotMatch(packageJob, /needs:|bun run test/)
  assert.match(packageJob, /bun run build/)
  assert.match(packageJob, /check-package.ts --retain-tarball package-artifacts/)
  assert.match(packageJob, /check-worktree-clean.ts --allow-package-artifacts/)
  assert.match(packageJob, /name: encephalon-npm-package/)
  for (const name of ['candidate', 'release-checks']) {
    const job = jobs[name] ?? ''
    assert.match(job, /needs: package/)
    assert.match(job, /actions\/download-artifact@/)
    assert.match(job, /name: encephalon-npm-package/)
    assert.match(job, /check-package-metadata.ts/)
    assert.match(job, /check-package.ts --tarball package-artifacts\/encephalon-0.3.0.tgz/)
    assert.doesNotMatch(job, /--retain-tarball|npm pack|npm install/)
  }
  assert.match(jobs.candidate ?? '', /- 24.15.0/)
  assert.match(jobs.candidate ?? '', /- 26/)
  assert.match(jobs['release-checks'] ?? '', /check-release-compatibility.ts package-artifacts\/encephalon-0.3.0.tgz/)
  assert.match(jobs['release-checks'] ?? '', /check-publish.ts package-artifacts\/encephalon-0.3.0.tgz/)
  assert.match(jobs.release ?? '', /needs: \[candidate, release-checks, verify\]/)
  assert.doesNotMatch(workflow, /run: npm publish/)
})
