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

test('CI gates one candidate behind source checks and retains complete selected verification', () => {
  const workflow = readFileSync(resolve(root, '.github/workflows/ci.yml'), 'utf8')
  const jobSource = workflow.split('\njobs:\n')[1] ?? ''
  const jobs = Object.fromEntries(
    [...jobSource.matchAll(/^ {2}([a-z-]+):\n([\s\S]*?)(?=^ {2}[a-z-]+:\n|$(?![\s\S]))/gm)].map(
      match => [match[1] ?? '', match[2] ?? ''] as const,
    ),
  )
  assert.match(workflow, /permissions:\n {2}contents: read\n/)
  assert.equal(workflowContainsSecretsContext(workflow), false)
  assert.doesNotMatch(
    workflow,
    /NODE_AUTH_TOKEN|NPM_TOKEN|registry-url|pull_request_target|continue-on-error|run: npm publish/,
  )
  assert.match(workflow, /types: \[opened, reopened, synchronize, labeled, unlabeled\]/)
  assert.match(workflow, /workflow_dispatch:/)
  assert.match(workflow, /schedule:/)
  assert.match(workflow, /cancel-in-progress: true/)
  for (const action of workflow.matchAll(/uses: ([^\s]+)/g)) {
    assert.match(action[1] ?? '', /^[^@]+@[a-f0-9]{40}$/)
  }
  for (const [name, job] of Object.entries(jobs)) {
    assert.match(job, /timeout-minutes: [1-9]\n/, name)
    assert.doesNotMatch(job, /permissions:/, name)
    if (job.includes('bun install')) {
      assert.ok(job.indexOf('check-generated-version.ts') < job.indexOf('setup-bun@'), name)
      assert.match(job, /bun install --frozen-lockfile --ignore-scripts/)
    }
    if (job.includes('actions/checkout@')) {
      assert.match(job, /persist-credentials: false/)
      assert.match(job, /ref: \$\{\{ github.event.pull_request.head.sha \|\| github.sha \}\}/)
    }
  }
  assert.equal([...workflow.matchAll(/run: bun run build/g)].length, 1)
  assert.equal([...workflow.matchAll(/--retain-tarball/g)].length, 1)
  assert.match(jobs.package ?? '', /needs: \[source, tooling, selection\]/)
  assert.match(jobs.source ?? '', /node: 24.15.0/)
  assert.match(jobs.source ?? '', /node: 26/)
  assert.match(jobs.source ?? '', /run: bun run test/)
  assert.match(jobs.source ?? '', /existsSync\("dist"\)/)
  assert.match(jobs.tooling ?? '', /bun run typecheck/)
  assert.match(jobs.tooling ?? '', /bun run lint/)
  assert.match(jobs.tooling ?? '', /bun run test:tooling/)
  assert.match(jobs.platform ?? '', /os: windows-latest/)
  assert.match(jobs.platform ?? '', /os: macos-latest/)
  assert.match(jobs.platform ?? '', /group: platform-core/)
  assert.match(jobs.platform ?? '', /group: cache/)
  assert.match(jobs.platform ?? '', /CI_CHANGED_TESTS:/)
  assert.match(jobs.history ?? '', /if: needs.selection.outputs.historyTools == 'true'/)
  assert.match(jobs.history ?? '', /bun run test:history/)
  assert.match(jobs['release-checks'] ?? '', /needs: \[package, selection\]/)
  assert.match(jobs['release-checks'] ?? '', /if: needs.selection.outputs.compatibility == 'true'/)
  assert.match(jobs['release-checks'] ?? '', /check-release-compatibility.ts "\$CANDIDATE_TARBALL"/)
  assert.match(jobs['release-checks'] ?? '', /check-publish.ts "\$CANDIDATE_TARBALL"/)
  for (const name of ['candidate', 'release-checks', 'benchmark-smoke']) {
    const job = jobs[name] ?? ''
    assert.match(job, /artifact-ids: \$\{\{ needs.package.outputs.artifact \}\}/)
    assert.match(job, /CANDIDATE_SHA256: \$\{\{ needs.package.outputs.sha256 \}\}/)
    assert.match(job, /check-package-metadata.ts --restore/)
    assert.doesNotMatch(job, /bun run build|--retain-tarball|npm pack|npm install/)
  }
  assert.match(jobs.package ?? '', /artifact: \$\{\{ steps.artifact.outputs.artifact-id \}\}/)
  assert.match(jobs.package ?? '', /check-worktree-clean.ts --allow-package-artifacts/)
  assert.doesNotMatch(workflow, /encephalon-0\.3\.0\.tgz/)
  assert.match(jobs.performance ?? '', /runs-on: ubuntu-24.04-arm/)
  assert.match(jobs.performance ?? '', /node scripts\/benchmark-compare.ts.*20.*matrix.shard/)
  assert.match(
    jobs.performance ?? '',
    /shard: \[large-gather, large-payload, large-maximum, large-preparation, large-reads, large-validation\]/,
  )
  assert.match(jobs.verify ?? '', /node scripts\/benchmark-aggregate.ts/)
  assert.match(jobs.verify ?? '', /context: \[ubuntu-latest, macos-latest, windows-latest, ubuntu-current\]/)
  assert.match(jobs.release ?? '', /needs: \[candidate, release-checks, verify, history, selection, package\]/)
  assert.match(
    jobs.release ?? '',
    /history.result !== \(selection.outputs.historyTools === "true" \? "success" : "skipped"\)/,
  )
  for (const name of ['verify', 'release']) {
    assert.match(jobs[name] ?? '', /if: always\(\)/)
    assert.match(jobs[name] ?? '', /every\(job => job.result === "success"\)/)
  }
})

test('trusted retention only copies an artifact from a successfully completed main CI run', () => {
  const workflow = readFileSync(resolve(root, '.github/workflows/promote-candidate.yml'), 'utf8')
  assert.match(workflow, /workflow_run:/)
  assert.match(workflow, /types: \[completed\]/)
  assert.match(workflow, /conclusion == 'success'/)
  assert.match(workflow, /head_branch == 'main'/)
  assert.match(workflow, /head_repository.full_name == github.repository/)
  assert.match(workflow, /path == '.github\/workflows\/ci.yml'/)
  assert.match(workflow, /\["push", "schedule", "workflow_dispatch"\]/)
  assert.match(workflow, /name: verified-candidate-\$\{\{ github.event.workflow_run.run_attempt \}\}/)
  assert.match(workflow, /run-id: \$\{\{ github.event.workflow_run.id \}\}/)
  assert.match(workflow, /name: trusted-main-\$\{\{ github.event.workflow_run.head_sha \}\}/)
  assert.doesNotMatch(workflow, /checkout|\brun:|secrets|write|pull_request_target/)
  for (const action of workflow.matchAll(/uses: ([^\s]+)/g)) {
    assert.match(action[1] ?? '', /^[^@]+@[a-f0-9]{40}$/)
  }
})
