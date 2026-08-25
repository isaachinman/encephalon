import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, test } from 'node:test'
import { PACKAGE_VERSION } from '../src/generated/version.ts'

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
      const match = trimmedLine.match(/^(?<listPrefix>-\s+)?(?:"if"|'if'|if)\s*:\s*(?<expression>.+)$/u)
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

describe('package contract', () => {
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
      'env:\n  NOTE: repository secrets are unavailable to pull requests\n',
      '# secrets.NPM_TOKEN must never be used here\nenv:\n  SAFE: true\n',
      `# ${githubExpression('secrets.NPM_TOKEN')} is documentation only\nenv:\n  SAFE: true\n`,
      'steps:\n  - run: echo "do not use secrets.NPM_TOKEN here"\n',
      `steps:\n  - run: echo 'do not use secrets["NPM_TOKEN"] here'\n`,
    ]) {
      assert.equal(workflowContainsSecretsContext(workflow), false, workflow)
    }
  })

  test('declares a zero-runtime-dependency Node ESM package', () => {
    const packageJson = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as Record<string, unknown>

    assert.equal(packageJson.name, 'encephalon')
    assert.equal(packageJson.version, PACKAGE_VERSION)
    assert.equal(packageJson.type, 'module')
    assert.deepEqual(packageJson.engines, { node: '>=24.15.0' })
    assert.deepEqual(packageJson.bin, { encephalon: 'dist/cli.mjs' })
    assert.equal(packageJson.dependencies, undefined)

    const scripts = packageJson.scripts as Record<string, unknown> | undefined
    assert.equal(scripts?.install, undefined)
    assert.equal(scripts?.preinstall, undefined)
    assert.equal(scripts?.postinstall, undefined)
    assert.equal(scripts?.prepare, undefined)
  })

  test('has a side-effect-free TypeScript API entrypoint', () => {
    assert.equal(existsSync(resolve(root, 'src/index.ts')), true)
    const declarations = ['index.d.ts', 'baseline.d.ts', 'cache.d.ts', 'canonical-layout.d.ts', 'records.d.ts']
      .map(file => readFileSync(resolve(root, 'dist', file), 'utf8'))
      .join('\n')
    assert.doesNotMatch(
      declarations,
      /BaselineWork|RecordWork|WorkObserver|afterGatherSearchEvaluation|cacheReadTestHooks|onEntry|onWork|scanBaselineWithHooks|validateRecordsResolved/,
    )
  })

  test('keeps generated runtime version metadata in sync with the manifest', () => {
    const generated = readFileSync(resolve(root, 'src', 'generated', 'version.ts'), 'utf8')
    const packageJson = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as { version?: unknown }

    assert.equal(PACKAGE_VERSION, packageJson.version)
    assert.equal(generated.includes(`PACKAGE_VERSION = ${JSON.stringify(PACKAGE_VERSION)}`), true)
  })

  test('ships the generic repository-memory skill', () => {
    const skill = readFileSync(resolve(root, 'skills', 'encephalon', 'SKILL.md'), 'utf8')
    assert.equal(skill.includes('npx --no-install encephalon search'), true)
    assert.equal(skill.includes('--supersedes'), true)
    assert.equal(skill.includes('npx --no-install encephalon validate'), true)
    assert.equal(skill.includes('Do not stage, commit, push'), true)
  })

  test('marks the old implementation plan historical and maintains a concise contract', () => {
    const implementationPlan = readFileSync(resolve(root, 'docs', 'implementation-plan.md'), 'utf8')
    const contract = readFileSync(resolve(root, 'docs', 'contract.md'), 'utf8')
    const performance = readFileSync(resolve(root, 'docs', 'performance.md'), 'utf8')
    const operationBudgetsDesign = readFileSync(
      resolve(root, 'docs', 'superpowers', 'specs', '2026-08-13-operation-budgets-design.md'),
      'utf8',
    )
    const boundedCacheValidationDesign = readFileSync(
      resolve(root, 'docs', 'superpowers', 'specs', '2026-08-16-bounded-cache-validation-design.md'),
      'utf8',
    )
    const semanticCacheSchemaDesign = readFileSync(
      resolve(root, 'docs', 'superpowers', 'specs', '2026-08-17-sqlite-schema-semantics-design.md'),
      'utf8',
    )
    const ftsTextIntegrityDesign = readFileSync(
      resolve(root, 'docs', 'superpowers', 'specs', '2026-08-17-fts-text-integrity-design.md'),
      'utf8',
    )
    const responseByteBudgetsDesign = readFileSync(
      resolve(root, 'docs', 'superpowers', 'specs', '2026-08-17-response-byte-budgets-design.md'),
      'utf8',
    )
    const unicodeLiteralSearchDesign = readFileSync(
      resolve(root, 'docs', 'superpowers', 'specs', '2026-08-18-unicode-literal-search-design.md'),
      'utf8',
    )
    const singlePassCacheReadDesign = readFileSync(
      resolve(root, 'docs', 'superpowers', 'specs', '2026-08-18-single-pass-cache-read-design.md'),
      'utf8',
    )
    const gatherDeduplicationDesign = readFileSync(
      resolve(root, 'docs', 'superpowers', 'specs', '2026-08-18-gather-deduplication-design.md'),
      'utf8',
    )
    const validatedMutationCacheDesign = readFileSync(
      resolve(root, 'docs', 'superpowers', 'specs', '2026-08-22-validated-mutation-cache-design.md'),
      'utf8',
    )

    assert.match(implementationPlan, /Status: historical design input; not the maintained normative contract/)
    assert.match(implementationPlan, /\[`docs\/contract\.md`]\(\.\/contract\.md\)/)
    assert.doesNotMatch(implementationPlan, /createdAt is assigned only after the repository operation lock is held/)
    assert.match(contract, /## Public API and CLI/)
    assert.match(contract, /## Operation Budgets/)
    assert.match(contract, /## Unicode Literal Search/)
    assert.match(contract, /## Canonical Storage/)
    assert.match(contract, /## Partial Initialisation Progress/)
    assert.match(contract, /## Cache Compatibility/)
    assert.match(contract, /## Bounded Disposable Cache Validation/)
    assert.match(contract, /## Gather Deduplication/)
    assert.match(contract, /Cache schema compatibility requires the exact owned ordinary-table semantics/)
    assert.match(contract, /## Package and Release Gates/)
    assert.match(contract, /## Historical Plan Divergence Checklist/)
    assert.match(
      contract,
      /Stable response-budget names are `fullResponseBytes`, `compactResponseBytes`, and `gatherResponseBytes`\./,
    )
    assert.match(
      contract,
      /MAR-2554 bounded full, compact, and gather read responses: `b43daf795de35d34602d1018ad509f68e494fe3d`\./,
    )
    assert.match(
      contract,
      /Last reviewed: 2026-08-25 for code and behavioural-test snapshot `f7e5cb7da3e7853bab6afad8b941ced5a72bc86f`\./,
    )
    assert.match(contract, /Each successful public cache read validates its cache generation exactly once/)
    assert.match(
      contract,
      /MAR-2552 single-pass cache reads and identity-bound recovery: `9b5821d59999215f975d613edf4a9c252fb6258d`\./,
    )
    assert.match(
      singlePassCacheReadDesign,
      /The exact code and behavioural-test snapshot implementing this design is `9b5821d59999215f975d613edf4a9c252fb6258d`\./,
    )
    assert.match(
      gatherDeduplicationDesign,
      /The exact implementation and behavioural-test snapshot is `36091c7e886b67b5c5bc355e6bcdb078f9a74f85`\./,
    )
    assert.match(
      validatedMutationCacheDesign,
      /The exact implementation and behavioural-test snapshot is `30104a049f72ba2e87f51af95d5da11b55045cc3`\./,
    )
    assert.match(
      contract,
      /MAR-2560 snapshot-local exact-key gather deduplication: `36091c7e886b67b5c5bc355e6bcdb078f9a74f85`\./,
    )
    assert.match(
      contract,
      /MAR-2565 validated mutation cache construction, deterministic disk fallback, and unchanged public error semantics: `30104a049f72ba2e87f51af95d5da11b55045cc3`\./,
    )
    assert.match(contract, /## Performance Evidence/)
    assert.match(contract, /implementing the MAR-2566 benchmark guarantees above/)
    assert.match(contract, /MAR-2568 behavioural hot-scan work bounds: `de66f6ab7e10696fc878e380dd5417d194d60fe8`\./)
    assert.match(performance, /## Validated mutation snapshot comparison/)
    assert.match(performance, /Correctness tests enforce deterministic output and bounded work counts/)
    assert.match(
      contract,
      /MAR-2566 isolated operation performance samples, additive phase boundaries, schema-version 2 distributions and strict budgets: `eae98315e53ce568c62f6854a8542b285b7f9e4f`\./,
    )
    assert.match(
      contract,
      /MAR-2548 restart-safe partial initialisation progress and convergence: `f388a67819e2bebcabcaa5051bab6fe8985dd4ab`\./,
    )
    assert.match(
      contract,
      /MAR-2563 operation-locked record timestamp assignment, locked canonical authority, and cross-process ordering: `2874874096bb7d327e084d7e17d5243564244c43`\./,
    )
    assert.match(
      contract,
      /MAR-2549 bounded disposable cache validation and exact-generation recovery: `fa5c1688c274b4f0f8fdc94ea102ed6cb1f0a4dd`\./,
    )
    assert.match(contract, /Historical plan's wall-clock-only `createdAt` policy/)
    assert.match(
      operationBudgetsDesign,
      /The exact reviewed code and behavioural-test snapshot implementing this design is `1e913807c20a332dc49a004be672205fbeabfe15`\./,
    )
    assert.match(
      boundedCacheValidationDesign,
      /The exact reviewed code and behavioural-test snapshot implementing this design is `fa5c1688c274b4f0f8fdc94ea102ed6cb1f0a4dd`\./,
    )
    assert.match(
      semanticCacheSchemaDesign,
      /The exact reviewed code and behavioural-test snapshot implementing this design is `f539720542a3302dd849002652e958da4a6063bf`\./,
    )
    assert.match(
      ftsTextIntegrityDesign,
      /The exact reviewed code and behavioural-test snapshot implementing this design is `2a68ce4dc839481a91b9afd6fb44a13ace13cb26`\./,
    )
    assert.match(
      responseByteBudgetsDesign,
      /The exact reviewed code and behavioural-test snapshot implementing this design is `b43daf795de35d34602d1018ad509f68e494fe3d`\./,
    )
    assert.match(
      unicodeLiteralSearchDesign,
      /The exact implementation and behavioural-test snapshot is `aa1a2596f4ca5be42b8896beedc802040eb57161`\./,
    )
    assert.match(
      readFileSync(resolve(root, 'CHANGELOG.md'), 'utf8'),
      /creation timestamps under the repository operation lock/,
    )
    assert.doesNotMatch(readFileSync(resolve(root, 'dist', 'api-input.d.ts'), 'utf8'), /ValidatedAddRecordInput/)
    assert.doesNotMatch(readFileSync(resolve(root, 'dist', 'errors.d.ts'), 'utf8'), /failBudget|operation-budgets/)
    assert.doesNotMatch(
      readFileSync(resolve(root, 'dist', 'cache-location.d.ts'), 'utf8'),
      /CacheDatabaseCreationConflict/,
    )
    assert.doesNotMatch(
      readFileSync(resolve(root, 'dist', 'operation-budgets.d.ts'), 'utf8'),
      /OPERATION_BUDGETS|OperationBudgetKey/,
    )
  })

  test('keeps installed command guidance aligned with root-install verification', () => {
    const readme = readFileSync(resolve(root, 'README.md'), 'utf8')
    const skill = readFileSync(resolve(root, 'skills', 'encephalon', 'SKILL.md'), 'utf8')
    const contract = readFileSync(resolve(root, 'docs', 'contract.md'), 'utf8')

    assert.match(readme, /npx --no-install encephalon init/)
    assert.match(skill, /npx --no-install encephalon search/)
    assert.match(skill, /npx --no-install encephalon validate/)
    assert.match(contract, /npx --no-install encephalon/)
    assert.doesNotMatch(skill, /node \.\/node_modules\/encephalon\/dist\/cli\.mjs/)
  })

  test('runs pull-request and current-Node package checks with a trusted release gate', () => {
    const workflow = readFileSync(resolve(root, '.github', 'workflows', 'ci.yml'), 'utf8')
    const readme = readFileSync(resolve(root, 'README.md'), 'utf8')
    const publishCheck = readFileSync(resolve(root, 'scripts', 'check-publish.ts'), 'utf8')
    const packageJson = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as {
      scripts?: Record<string, unknown>
    }
    const generatedVersionScript = String(packageJson.scripts?.['check:generated'])
    const publishScript = String(packageJson.scripts?.['check:publish'])
    const eventsStart = workflow.indexOf('\non:\n') + 1
    const permissionsStart = workflow.indexOf('\npermissions:\n', eventsStart)
    const concurrencyStart = workflow.indexOf('\nconcurrency:\n', permissionsStart)
    const jobsStart = workflow.indexOf('\njobs:\n')
    const releaseStart = workflow.indexOf('\n  release:\n', jobsStart)
    const trustedUploadStart = workflow.indexOf('\n  upload:\n', releaseStart)
    const workflowConfiguration = workflow.slice(0, jobsStart)
    const verificationJob = workflow.slice(jobsStart, releaseStart)
    const releaseJob = workflow.slice(releaseStart, trustedUploadStart)
    const trustedUploadJob = workflow.slice(trustedUploadStart)
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
    const trustedUploadStepsStart = trustedUploadJob.indexOf('    steps:\n')
    const trustedUploadHeader = trustedUploadJob.slice(0, trustedUploadStepsStart)
    const trustedUploadSteps = trustedUploadJob.slice(trustedUploadStepsStart)
    const uploadActionStart = trustedUploadJob.indexOf(
      '      - name: Upload trusted release-equivalent package artifact\n',
    )
    const uploadStep = trustedUploadJob.slice(uploadActionStart)

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
      /concurrency:\n\s+group: \$\{\{ github\.workflow \}\}-\$\{\{ github\.event\.pull_request\.number \|\| github\.ref \}\}\n\s+cancel-in-progress: true/,
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
      verificationSteps.replace(
        '    steps:\n',
        '    steps:\n      - uses: ./.github/actions/repair-generated-source\n',
      ),
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
        'bun run check:package',
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
        'bun run check:package',
      ],
    )
    assert.equal(releaseSteps.match(/^\s+(?:- )?run:/gm)?.length, 7)
    assert.equal(releaseSteps.match(/^\s{8}if:/gm)?.length ?? 0, 0)
    assert.doesNotMatch(releaseSteps, /^\s{8}continue-on-error:/m)
    assert.match(
      releaseJob,
      /- name: Create release-equivalent package artifact\n\s+shell: bash\n\s+run: \|\n\s+mkdir -p package-artifacts\n\s+npm pack --dry-run=false --ignore-scripts --json --pack-destination package-artifacts > package-artifacts\/npm-pack\.json/,
    )
    assert.equal(releaseJob.match(/npm pack --dry-run=false/g)?.length, 1)
    assert.match(releaseJob, /- name: Check npm publish dry run\n\s+run: bun run check:publish/)
    assert.equal(releaseJob.match(/bun run check:publish/g)?.length, 1)
    assert.equal(releaseJob.match(/actions\/upload-artifact/g)?.length ?? 0, 0)
    assert.equal(
      [
        'node ./scripts/check-generated-version.ts',
        'bun run build',
        'git diff --exit-code',
        'bun run check:package',
        'npm pack',
        'bun run check:publish',
      ]
        .map(step => releaseJob.indexOf(step))
        .every(
          (position, index, positions) =>
            position >= 0 && (index === 0 || position > (positions[index - 1] ?? Number.POSITIVE_INFINITY)),
        ),
      true,
    )

    assert.equal(
      trustedUploadHeader,
      `
  upload:
    name: Upload trusted release-equivalent package artifact
    if: success() && github.event_name == 'push' && github.ref == 'refs/heads/main'
    needs:
      - verify
      - release
    runs-on: ubuntu-latest
`,
    )
    assert.doesNotMatch(trustedUploadJob, /^ {4}(?:continue-on-error|permissions):/m)
    const trustedUploadPrefix =
      /^ {4}steps:\n {6}- uses: actions\/checkout@\S+\n {8}with:\n {10}persist-credentials: false\n {6}- uses: actions\/setup-node@\S+\n {8}with:\n {10}node-version: 24\.15\.0\n {6}- run: node \.\/scripts\/check-generated-version\.ts\n {6}- uses: oven-sh\/setup-bun@v2\n {8}with:\n {10}bun-version: 1\.3\.1\n {6}- run: bun install --frozen-lockfile\n/u
    assert.match(trustedUploadSteps, trustedUploadPrefix)
    assert.doesNotMatch(
      trustedUploadSteps.replace('    steps:\n', '    steps:\n      - run: bun run repair-generated-source\n'),
      trustedUploadPrefix,
    )
    assert.deepEqual(
      [...trustedUploadSteps.matchAll(/^\s{6}- run: (.+)$/gm)].map(match => match[1]),
      [
        'node ./scripts/check-generated-version.ts',
        'bun install --frozen-lockfile',
        'bun run build',
        'git diff --exit-code',
      ],
    )
    assert.equal(trustedUploadSteps.match(/^\s+(?:- )?run:/gm)?.length, 5)
    assert.equal(trustedUploadJob.match(/npm pack --dry-run=false/g)?.length, 1)
    assert.equal(trustedUploadJob.match(/actions\/upload-artifact/g)?.length, 1)
    assert.equal(
      uploadStep
        .split('\n')
        .filter(line => !line.includes('uses: actions/upload-artifact@'))
        .slice(1)
        .join('\n'),
      `        with:
          name: encephalon-npm-package
          path: package-artifacts/*
          if-no-files-found: error
          retention-days: 7
`,
    )
    assert.equal(
      [
        'node ./scripts/check-generated-version.ts',
        'bun run build',
        'git diff --exit-code',
        'npm pack',
        'actions/upload-artifact',
      ]
        .map(step => trustedUploadJob.indexOf(step))
        .every(
          (position, index, positions) =>
            position >= 0 && (index === 0 || position > (positions[index - 1] ?? Number.POSITIVE_INFINITY)),
        ),
      true,
    )

    assert.equal(workflow.match(/node \.\/scripts\/check-generated-version\.ts/g)?.length, 3)
    assert.doesNotMatch(workflow, /^\s+- run: bun run \.\/scripts\/check-generated-version\.ts$/m)
    assert.doesNotMatch(workflow, /^\s+- run: bun run check:generated$/m)
    assert.equal(workflow.match(/^\s+- run: git diff --exit-code$/gmu)?.length, 3)
    assert.match(readme, /four verification lanes/)
    assert.match(readme, /trusted pushes to `main`/)
    assert.match(readme, /release-equivalent package gate/)
    assert.equal(generatedVersionScript, 'bun run scripts/check-generated-version.ts')
    assert.equal(publishScript, 'bun run scripts/check-publish.ts')
    assert.equal(publishCheck.includes("'--dry-run'"), true)
    assert.equal(publishCheck.includes("'--ignore-scripts'"), true)
    assert.equal(publishCheck.includes('You cannot publish over the previously published versions'), true)
  })
})
