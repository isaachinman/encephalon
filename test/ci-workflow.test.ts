import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { test } from 'node:test'

const root = resolve(import.meta.dirname, '..')
const githubExpression = (source: string) => `\${{ ${source} }}`
const githubIdentifierCharacter = /[A-Za-z0-9_-]/u

const expressionContainsSecretsContext = (expression: string) => {
  let cursor = 0
  let quote: "'" | '"' | undefined
  let found = false

  while (cursor < expression.length && !found) {
    const character = expression[cursor]
    const nextCharacter = expression[cursor + 1]
    if (quote !== undefined) {
      if (character === '\\') {
        cursor += 2
      } else if (character === quote && nextCharacter === quote) {
        cursor += 2
      } else {
        if (character === quote) {
          quote = undefined
        }
        cursor += 1
      }
    } else if (character === "'" || character === '"') {
      quote = character
      cursor += 1
    } else {
      const previousCharacter = expression[cursor - 1]
      const afterToken = expression[cursor + 'secrets'.length]
      const isSecretsToken = expression.slice(cursor, cursor + 'secrets'.length).toLowerCase() === 'secrets'
      if (
        isSecretsToken &&
        previousCharacter !== '.' &&
        !githubIdentifierCharacter.test(previousCharacter ?? '') &&
        !githubIdentifierCharacter.test(afterToken ?? '')
      ) {
        found = true
      }
      cursor += 1
    }
  }

  return found
}

const extractGithubExpressions = (source: string) => {
  const expressions: string[] = []
  let searchStart = 0

  while (searchStart < source.length) {
    const expressionStart = source.indexOf('${{', searchStart)
    if (expressionStart < 0) {
      searchStart = source.length
    } else {
      let cursor = expressionStart + 3
      let expressionEnd = -1
      let quote: "'" | '"' | undefined
      while (cursor < source.length && expressionEnd < 0) {
        const character = source[cursor]
        const nextCharacter = source[cursor + 1]
        if (quote !== undefined) {
          if (character === '\\') {
            cursor += 2
          } else if (character === quote && nextCharacter === quote) {
            cursor += 2
          } else {
            if (character === quote) {
              quote = undefined
            }
            cursor += 1
          }
        } else if (character === "'" || character === '"') {
          quote = character
          cursor += 1
        } else if (character === '}' && nextCharacter === '}') {
          expressionEnd = cursor
        } else {
          cursor += 1
        }
      }

      assert.notEqual(expressionEnd, -1, 'Unterminated GitHub Actions expression.')
      expressions.push(source.slice(expressionStart + 3, expressionEnd))
      searchStart = expressionEnd + 2
    }
  }

  return expressions
}

const stripYamlScalarQuotes = (source: string) => {
  const trimmed = source.trim()
  const [firstCharacter] = trimmed
  const lastCharacter = trimmed.at(-1)
  return (firstCharacter === "'" && lastCharacter === "'") || (firstCharacter === '"' && lastCharacter === '"')
    ? trimmed.slice(1, -1)
    : trimmed
}

const stripYamlComment = (line: string) => {
  let commentStart = line.length
  let cursor = 0
  let quote: "'" | '"' | undefined

  while (cursor < line.length && commentStart === line.length) {
    const character = line[cursor]
    const nextCharacter = line[cursor + 1]
    if (quote === '"' && character === '\\') {
      cursor += 2
    } else if (quote === "'" && character === "'" && nextCharacter === "'") {
      cursor += 2
    } else if (quote !== undefined) {
      if (character === quote) {
        quote = undefined
      }
      cursor += 1
    } else if (character === "'" || character === '"') {
      quote = character
      cursor += 1
    } else if (character === '#' && (cursor === 0 || /\s/u.test(line[cursor - 1] ?? ''))) {
      commentStart = cursor
    } else {
      cursor += 1
    }
  }

  return line.slice(0, commentStart).trimEnd()
}

const partitionWorkflowSource = (source: string) => {
  const state = source.split('\n').reduce(
    (result, line) => {
      const trimmedLine = line.trimStart()
      const indentation = line.length - trimmedLine.length
      const continuesBlockScalar =
        result.blockScalarIndent !== undefined && (trimmedLine.length === 0 || indentation > result.blockScalarIndent)
      if (result.blockScalarIndent !== undefined && !continuesBlockScalar) {
        result.blockScalarIndent = undefined
      }

      const evaluableLine = continuesBlockScalar ? line : stripYamlComment(line)
      result.evaluableLines.push(evaluableLine)
      result.structuralLines.push(continuesBlockScalar ? '' : evaluableLine)
      if (result.blockScalarIndent === undefined && /:\s*[>|][+-]?[1-9]?[+-]?\s*$/u.test(evaluableLine)) {
        result.blockScalarIndent = indentation
      }
      return result
    },
    {
      blockScalarIndent: undefined as number | undefined,
      evaluableLines: [] as string[],
      structuralLines: [] as string[],
    },
  )
  return {
    evaluableSource: state.evaluableLines.join('\n'),
    structuralSource: state.structuralLines.join('\n'),
  }
}

const extractImplicitConditions = (source: string) => {
  const state = source.split('\n').reduce(
    (result, line) => {
      const trimmedLine = line.trimStart()
      const indentation = line.length - trimmedLine.length
      if (trimmedLine.length === 0) {
        return result
      }
      if (result.active !== undefined && indentation > result.active.keyIndentation) {
        return {
          ...result,
          active: {
            ...result.active,
            expression: `${result.active.expression} ${trimmedLine}`,
          },
        }
      }

      const expressions =
        result.active === undefined
          ? result.expressions
          : [...result.expressions, stripYamlScalarQuotes(result.active.expression)]
      const match = trimmedLine.match(/^(?<listPrefix>-\s+)?(?:"if"|'if'|if)\s*:\s*(?<expression>.*)$/u)
      return {
        active:
          match === null
            ? undefined
            : {
                expression: match.groups?.expression ?? '',
                keyIndentation: indentation + (match.groups?.listPrefix?.length ?? 0),
              },
        expressions,
      }
    },
    {
      active: undefined as { expression: string; keyIndentation: number } | undefined,
      expressions: [] as string[],
    },
  )
  return state.active === undefined
    ? state.expressions
    : [...state.expressions, stripYamlScalarQuotes(state.active.expression)]
}

const workflowContainsSecretsContext = (workflow: string) => {
  const { evaluableSource, structuralSource } = partitionWorkflowSource(workflow)
  const encodedYamlScalar = /\\(?:U[\dA-Fa-f]{8}|u[\dA-Fa-f]{4}|x[\dA-Fa-f]{2})|\\\s*$/mu
  // Resolving anchors or flow mappings safely would require the excluded YAML parser, so ambiguous forms fail closed.
  const yamlAnchorOrAlias = /(?:^|\s|:|,|\{|\[|\?)[&*][^\s&*,[\]{}]+/mu
  const flowStyleCondition = /[,{]\s*["']?if["']?\s*:/u
  const implicitConditions = extractImplicitConditions(structuralSource)
  return (
    encodedYamlScalar.test(structuralSource) ||
    yamlAnchorOrAlias.test(structuralSource) ||
    flowStyleCondition.test(structuralSource) ||
    extractGithubExpressions(evaluableSource).some(expressionContainsSecretsContext) ||
    implicitConditions.some(expression => /^[>|]/u.test(expression) || expressionContainsSecretsContext(expression))
  )
}

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
    "jobs:\n  verify:\n    if: secrets.RUN_VERIFY == 'true'\n",
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
      'bun run build',
      'git diff --exit-code',
      'node ./scripts/check-package.ts',
    ],
  )
  assert.equal(verificationSteps.match(/^\s+(?:- )?run:/gm)?.length, 9)
  assert.equal(verificationSteps.match(/^\s{6}- if:/gm)?.length, 1)
  assert.doesNotMatch(verificationSteps, /^\s{8}continue-on-error:/m)

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
    /^ {4}steps:\n {6}- uses: actions\/checkout@\S+\n {8}with:\n {10}persist-credentials: false\n {6}- uses: actions\/setup-node@\S+\n {8}with:\n {10}node-version: 24\.15\.0\n {6}- run: node \.\/scripts\/check-generated-version\.ts\n {6}- uses: oven-sh\/setup-bun@v2\n {8}with:\n {10}bun-version: 1\.3\.1\n {6}- run: bun install --frozen-lockfile\n/u
  assert.match(releaseSteps, trustedReleasePrefix)
  assert.doesNotMatch(
    releaseSteps.replace('    steps:\n', '    steps:\n      - run: bun run repair-generated-source\n'),
    trustedReleasePrefix,
  )
  assert.deepEqual(
    [...releaseSteps.matchAll(/^\s{6}- run: (.+)$/gm)].map(match => match[1]),
    [
      'node ./scripts/check-generated-version.ts',
      'bun install --frozen-lockfile',
      'bun run build',
      'git diff --exit-code',
      'git diff --exit-code',
    ],
  )
  assert.equal(releaseSteps.match(/^\s+(?:- )?run:/gm)?.length, 7)
  assert.equal(releaseSteps.match(/^\s{8}if:/gm)?.length, 1)
  assert.doesNotMatch(releaseSteps, /^\s{8}continue-on-error:/m)
  assert.equal(releaseJob.match(/npm pack --dry-run=false/g)?.length ?? 0, 0)
  assert.match(releaseJob, /- name: Check npm publish dry run\n\s+run: node \.\/scripts\/check-publish\.ts/)
  assert.match(
    releaseJob,
    /- name: Check and retain release-equivalent package artifact\n\s+id: package\n\s+shell: bash\n\s+run: \|\n\s+retained_tarball=\$\(node \.\/scripts\/check-package\.ts --retain-tarball package-artifacts\)\n\s+echo "tarball=\$retained_tarball" >> "\$GITHUB_OUTPUT"/,
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
      'git diff --exit-code',
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
    releaseJob.lastIndexOf('git diff --exit-code') >
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
  assert.equal(workflow.match(/^\s+- run: git diff --exit-code$/gmu)?.length, 3)
  assert.match(readme, /four verification lanes/)
  assert.match(readme, /trusted pushes to `main`/)
  assert.match(readme, /release-equivalent package gate/)
  assert.equal(generatedVersionScript, 'bun run scripts/check-generated-version.ts')
  assert.equal(packageScript, 'node ./scripts/check-package.ts')
  assert.equal(publishScript, 'node ./scripts/check-publish.ts')
  assert.equal(publishCheck.includes("'--dry-run'"), true)
  assert.equal(publishCheck.includes("'--ignore-scripts'"), true)
  assert.equal(publishCheck.includes('You cannot publish over the previously published versions'), true)
})
