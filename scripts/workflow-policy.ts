import {
  type BigIntStats,
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  opendirSync,
  openSync,
  readFileSync,
  realpathSync,
} from 'node:fs'
import { extname, relative, resolve, sep } from 'node:path'

export type WorkflowPolicyRule = 'credential-environment' | 'external-action-sha' | 'local-reference' | 'permission'

export type WorkflowPolicyFinding = Readonly<{
  file: string
  location: string
  rule: WorkflowPolicyRule
}>

type ParsedObject = Record<string, unknown>

// Scripts keep local witness/error semantics instead of importing runtime BrainError modules.
type DirectoryObservation =
  | Readonly<{ kind: 'directory'; stats: BigIntStats }>
  | Readonly<{ kind: 'invalid' }>
  | Readonly<{ kind: 'missing' }>

const fullCommitReference = /^[^\s@/]+\/[^\s@/]+(?:\/[^\s@/]+)*@[0-9a-f]{40}$/u
const localReference = /^\.\//u
const identifierStart = /[A-Za-z_]/u
const identifierCharacter = /[A-Za-z0-9_-]/u
const expressionOpening = '${{'
const expressionClosing = '}}'
const secretsIdentifier = 'secrets'
const workflowFilename = /\.ya?ml$/u
const protectedEnvironment = 'pullfrog-review'

const compareStrings = (left: string, right: string) => {
  let comparison = 0
  if (left < right) {
    comparison = -1
  } else if (left > right) {
    comparison = 1
  }
  return comparison
}

const compareFindings = (left: WorkflowPolicyFinding, right: WorkflowPolicyFinding) => {
  let comparison = compareStrings(left.file, right.file)
  if (comparison === 0) {
    comparison = compareStrings(left.location, right.location)
  }
  if (comparison === 0) {
    comparison = compareStrings(left.rule, right.rule)
  }
  return comparison
}

const isPlainObject = (value: unknown): value is ParsedObject => {
  let plain = false
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    const prototype = Object.getPrototypeOf(value)
    plain = prototype === Object.prototype || prototype === null
  }
  return plain
}

const objectLocation = (location: string, key: string) => {
  let childLocation = key
  if (location.length > 0) {
    childLocation = `${location}.${key}`
  }
  return childLocation
}

const relativeFile = (root: string, path: string) => relative(root, path).split(sep).join('/')

const comparablePath = (path: string) =>
  process.platform === 'win32' ? path.replaceAll('\\', '/').toLowerCase() : path

const samePath = (first: string, second: string) => comparablePath(first) === comparablePath(second)

const isContainedPath = (root: string, path: string) =>
  samePath(root, path) || comparablePath(path).startsWith(`${comparablePath(root)}/`)

const hasErrorCode = (value: unknown, code: string) => {
  let matches = false
  if (typeof value === 'object' && value !== null && 'code' in value) {
    matches = value.code === code
  }
  return matches
}

const readStats = (path: string) => {
  let stats: BigIntStats | undefined
  try {
    stats = lstatSync(path, { bigint: true })
  } catch {
    stats = undefined
  }
  return stats
}

const hasStableFileIdentity = (left: BigIntStats, right: BigIntStats) =>
  left.dev === right.dev &&
  left.ino === right.ino &&
  left.size === right.size &&
  left.mode === right.mode &&
  left.birthtimeNs === right.birthtimeNs &&
  left.mtimeNs === right.mtimeNs &&
  left.ctimeNs === right.ctimeNs

const readRealPath = (path: string) => {
  let nativePath: string | undefined
  try {
    nativePath = realpathSync.native(path)
  } catch {
    nativePath = undefined
  }
  return nativePath
}

const isSingleLinkRegularFile = (stats: BigIntStats) => stats.isFile() && stats.nlink === 1n

const isRegularNativeFile = (root: string, path: string) => {
  const stats = readStats(path)
  const nativePath = readRealPath(path)
  return (
    stats !== undefined &&
    isSingleLinkRegularFile(stats) &&
    stats.isSymbolicLink() === false &&
    nativePath !== undefined &&
    samePath(nativePath, path) &&
    isContainedPath(root, nativePath)
  )
}

const isNativeDirectory = (root: string, path: string, stats: BigIntStats, nativePath: string | undefined) =>
  stats.isDirectory() &&
  !stats.isSymbolicLink() &&
  nativePath !== undefined &&
  samePath(nativePath, path) &&
  isContainedPath(root, path)

const observeNativeDirectory = (root: string, path: string): DirectoryObservation => {
  let observation: DirectoryObservation = { kind: 'invalid' }
  let stats: BigIntStats | undefined
  try {
    stats = lstatSync(path, { bigint: true })
  } catch (error) {
    if (hasErrorCode(error, 'ENOENT')) {
      observation = { kind: 'missing' }
    }
  }
  if (stats !== undefined) {
    try {
      const nativePath = realpathSync.native(path)
      if (isNativeDirectory(root, path, stats, nativePath)) {
        observation = { kind: 'directory', stats }
      }
    } catch {
      observation = { kind: 'invalid' }
    }
  }
  return observation
}

const isSameDirectoryGeneration = (initial: DirectoryObservation, final: DirectoryObservation) =>
  initial.kind === 'directory' && final.kind === 'directory' && hasStableFileIdentity(initial.stats, final.stats)

const readValidatedNativeFile = (root: string, path: string) => {
  let contents: string | undefined
  let descriptor: number | undefined
  let operationFailed = false
  try {
    const initialStats = lstatSync(path, { bigint: true })
    const initialNativePath = realpathSync.native(path)
    if (
      isSingleLinkRegularFile(initialStats) &&
      !initialStats.isSymbolicLink() &&
      samePath(initialNativePath, path) &&
      isContainedPath(root, initialNativePath)
    ) {
      const noFollow = constants.O_NOFOLLOW ?? 0
      descriptor = openSync(path, constants.O_RDONLY | noFollow)
      const beforeReadStats = fstatSync(descriptor, { bigint: true })
      if (isSingleLinkRegularFile(beforeReadStats) && hasStableFileIdentity(initialStats, beforeReadStats)) {
        const candidateContents = readFileSync(descriptor, 'utf8')
        const afterReadStats = fstatSync(descriptor, { bigint: true })
        const finalStats = lstatSync(path, { bigint: true })
        const finalNativePath = realpathSync.native(path)
        if (
          isSingleLinkRegularFile(afterReadStats) &&
          isSingleLinkRegularFile(finalStats) &&
          !finalStats.isSymbolicLink() &&
          samePath(finalNativePath, path) &&
          isContainedPath(root, finalNativePath) &&
          hasStableFileIdentity(beforeReadStats, afterReadStats) &&
          hasStableFileIdentity(afterReadStats, finalStats)
        ) {
          contents = candidateContents
        } else {
          operationFailed = true
        }
      } else {
        operationFailed = true
      }
    } else {
      operationFailed = true
    }
  } catch {
    operationFailed = true
  }

  let closeFailed = false
  if (descriptor !== undefined) {
    try {
      closeSync(descriptor)
    } catch {
      closeFailed = true
    }
  }
  if (operationFailed || closeFailed) {
    contents = undefined
  }
  return contents
}

const resolveLocalTarget = (root: string, reference: string) => {
  const candidate = resolve(root, reference)
  let target: string | undefined
  if (isContainedPath(root, candidate)) {
    const extension = extname(candidate)
    if (extension === '.yml' || extension === '.yaml') {
      if (isRegularNativeFile(root, candidate)) {
        target = candidate
      }
    } else {
      const directoryStats = readStats(candidate)
      const nativeDirectory = readRealPath(candidate)
      const nativeDirectoryIsValid =
        directoryStats?.isDirectory() === true &&
        directoryStats.isSymbolicLink() === false &&
        nativeDirectory !== undefined &&
        samePath(nativeDirectory, candidate) &&
        isContainedPath(root, nativeDirectory)
      if (nativeDirectoryIsValid) {
        const presentActionTargets = ['action.yml', 'action.yaml']
          .map(filename => resolve(candidate, filename))
          .filter(path => readStats(path) !== undefined)
        const [onlyActionTarget] = presentActionTargets
        if (
          presentActionTargets.length === 1 &&
          onlyActionTarget !== undefined &&
          isRegularNativeFile(root, onlyActionTarget)
        ) {
          target = onlyActionTarget
        }
      }
    }
  }
  return target
}

const hasProtectedEnvironment = (value: unknown) => {
  let protected_ = value === protectedEnvironment
  if (isPlainObject(value)) {
    protected_ = value.name === protectedEnvironment
  }
  return protected_
}

const isIdentifierCharacter = (character: string | undefined) =>
  character !== undefined && identifierCharacter.test(character)

const isIdentifierStart = (character: string | undefined) => character !== undefined && identifierStart.test(character)

const stringContainsSecretExpression = (value: string) => {
  let containsSecret = false
  let expressionStart = value.indexOf(expressionOpening)
  while (!containsSecret && expressionStart >= 0) {
    let position = expressionStart + expressionOpening.length
    let inSingleQuotedLiteral = false
    let expressionClosed = false
    let expressionContainsSecret = false
    while (!expressionClosed && position < value.length) {
      const character = value[position]
      const nextCharacter = value[position + 1]
      if (inSingleQuotedLiteral) {
        if (character === "'" && nextCharacter === "'") {
          position += 2
        } else {
          if (character === "'") {
            inSingleQuotedLiteral = false
          }
          position += 1
        }
      } else if (character === "'") {
        inSingleQuotedLiteral = true
        position += 1
      } else if (character === '}' && nextCharacter === '}') {
        expressionClosed = true
        position += expressionClosing.length
      } else if (isIdentifierStart(character)) {
        let identifierEnd = position + 1
        while (isIdentifierCharacter(value[identifierEnd])) {
          identifierEnd += 1
        }
        let precedingPosition = position - 1
        while (precedingPosition >= 0 && /\s/u.test(value[precedingPosition] ?? '')) {
          precedingPosition -= 1
        }
        const isMemberProperty = value[precedingPosition] === '.'
        if (value.slice(position, identifierEnd).toLowerCase() === secretsIdentifier && !isMemberProperty) {
          expressionContainsSecret = true
        }
        position = identifierEnd
      } else {
        position += 1
      }
    }
    if (expressionClosed && expressionContainsSecret) {
      containsSecret = true
    } else {
      expressionStart = value.indexOf(expressionOpening, position)
    }
  }
  return containsSecret
}

const containsSecretExpression = (value: unknown): boolean => {
  let containsSecret = false
  if (typeof value === 'string') {
    containsSecret = stringContainsSecretExpression(value)
  } else if (Array.isArray(value)) {
    containsSecret = value.some(item => containsSecretExpression(item))
  } else if (isPlainObject(value)) {
    containsSecret = Object.values(value).some(item => containsSecretExpression(item))
  }
  return containsSecret
}

const effectiveIdTokenIsWrite = (workflowPermissions: unknown, jobPermissions: unknown) => {
  let effectivePermissions = workflowPermissions
  if (jobPermissions !== undefined) {
    effectivePermissions = jobPermissions
  }
  return (
    effectivePermissions === 'write-all' ||
    (isPlainObject(effectivePermissions) && effectivePermissions['id-token'] === 'write')
  )
}

const inspectWorkflowPermissions = (document: ParsedObject, file: string, findings: WorkflowPolicyFinding[]) => {
  const { permissions } = document
  const exactReadScope =
    isPlainObject(permissions) && Object.keys(permissions).length === 1 && permissions.contents === 'read'
  if (!exactReadScope) {
    if (isPlainObject(permissions)) {
      let reportedSpecificPermission = false
      if (permissions.contents !== 'read') {
        findings.push({ file, location: 'permissions.contents', rule: 'permission' })
        reportedSpecificPermission = true
      }
      for (const [permission, access] of Object.entries(permissions)) {
        if (permission !== 'contents' && access === 'write') {
          findings.push({ file, location: `permissions.${permission}`, rule: 'permission' })
          reportedSpecificPermission = true
        }
      }
      if (!reportedSpecificPermission) {
        findings.push({ file, location: 'permissions', rule: 'permission' })
      }
    } else {
      findings.push({ file, location: 'permissions', rule: 'permission' })
    }
  }
}

const inspectJobPermissions = (job: ParsedObject, jobName: string, file: string, findings: WorkflowPolicyFinding[]) => {
  const { permissions } = job
  if (permissions !== undefined) {
    const permissionLocation = `jobs.${jobName}.permissions`
    if (isPlainObject(permissions)) {
      const permissionNames = Object.keys(permissions)
      const exactReadScope = permissionNames.length === 1 && permissions.contents === 'read'
      const allowsPullfrogOidc =
        file === '.github/workflows/pullfrog.yml' && jobName === 'pullfrog' && hasProtectedEnvironment(job.environment)
      const exactPullfrogOidcScope =
        allowsPullfrogOidc &&
        permissionNames.length === 2 &&
        permissions.contents === 'read' &&
        permissions['id-token'] === 'write'
      if (!(exactReadScope || exactPullfrogOidcScope)) {
        if (permissionNames.length === 0) {
          findings.push({ file, location: permissionLocation, rule: 'permission' })
        } else {
          if (permissions.contents !== 'read') {
            findings.push({ file, location: `${permissionLocation}.contents`, rule: 'permission' })
          }
          for (const permission of permissionNames) {
            const isAllowedOidcPermission =
              allowsPullfrogOidc && permission === 'id-token' && permissions[permission] === 'write'
            if (permission !== 'contents' && !isAllowedOidcPermission) {
              findings.push({ file, location: `${permissionLocation}.${permission}`, rule: 'permission' })
            }
          }
        }
      }
    } else {
      findings.push({ file, location: permissionLocation, rule: 'permission' })
    }
  }
}

const inspectWorkflowJobs = (document: ParsedObject, file: string, findings: WorkflowPolicyFinding[]) => {
  const { jobs } = document
  if (isPlainObject(jobs)) {
    const workflowEnvironmentContainsSecret = containsSecretExpression(document.env)
    for (const [jobName, value] of Object.entries(jobs)) {
      if (isPlainObject(value)) {
        inspectJobPermissions(value, jobName, file, findings)
        const credentialBearing =
          workflowEnvironmentContainsSecret ||
          containsSecretExpression(value) ||
          value.secrets === 'inherit' ||
          effectiveIdTokenIsWrite(document.permissions, value.permissions)
        if (credentialBearing && !hasProtectedEnvironment(value.environment)) {
          findings.push({ file, location: `jobs.${jobName}.environment`, rule: 'credential-environment' })
        }
      }
    }
  }
}

export const inspectWorkflowPolicy = (root: string): readonly WorkflowPolicyFinding[] => {
  const nativeRoot = readRealPath(resolve(root))
  if (nativeRoot === undefined) {
    return [{ file: '.github/workflows', location: '$', rule: 'local-reference' }]
  }
  const findings: WorkflowPolicyFinding[] = []
  const parsedPaths = new Set<string>()

  const inspectFile = (path: string, rootWorkflow: boolean) => {
    const parsedPath = comparablePath(path)
    if (!parsedPaths.has(parsedPath)) {
      parsedPaths.add(parsedPath)
      const file = relativeFile(nativeRoot, path)
      let document: ParsedObject | undefined
      try {
        const contents = readValidatedNativeFile(nativeRoot, path)
        const parsed = contents === undefined ? undefined : Bun.YAML.parse(contents)
        if (isPlainObject(parsed)) {
          document = parsed
        }
      } catch {
        document = undefined
      }

      if (document === undefined) {
        findings.push({ file, location: '$', rule: 'local-reference' })
      } else {
        if (rootWorkflow || isPlainObject(document.jobs)) {
          inspectWorkflowPermissions(document, file, findings)
          inspectWorkflowJobs(document, file, findings)
        }

        const inspectValue = (value: unknown, location: string) => {
          if (Array.isArray(value)) {
            for (const [index, child] of value.entries()) {
              inspectValue(child, `${location}[${String(index)}]`)
            }
          } else if (isPlainObject(value)) {
            for (const [key, child] of Object.entries(value)) {
              const childLocation = objectLocation(location, key)
              if (key === 'uses' && typeof child === 'string') {
                if (localReference.test(child)) {
                  const target = resolveLocalTarget(nativeRoot, child)
                  if (target === undefined) {
                    findings.push({ file, location: childLocation, rule: 'local-reference' })
                  } else {
                    inspectFile(target, false)
                  }
                } else if (!fullCommitReference.test(child)) {
                  findings.push({ file, location: childLocation, rule: 'external-action-sha' })
                }
              }
              inspectValue(child, childLocation)
            }
          }
        }

        inspectValue(document, '')
      }
    }
  }

  const githubDirectory = resolve(nativeRoot, '.github')
  const workflowsDirectory = resolve(githubDirectory, 'workflows')
  const initialRoot = observeNativeDirectory(nativeRoot, nativeRoot)
  const initialGithubDirectory = observeNativeDirectory(nativeRoot, githubDirectory)
  const generationFindings: WorkflowPolicyFinding[] = []
  let discoveryAccepted = false

  if (initialRoot.kind === 'directory') {
    if (initialGithubDirectory.kind === 'missing') {
      const secondGithubDirectory = observeNativeDirectory(nativeRoot, githubDirectory)
      const finalRoot = observeNativeDirectory(nativeRoot, nativeRoot)
      discoveryAccepted = secondGithubDirectory.kind === 'missing' && isSameDirectoryGeneration(initialRoot, finalRoot)
    } else if (initialGithubDirectory.kind === 'directory') {
      const initialWorkflowsDirectory = observeNativeDirectory(nativeRoot, workflowsDirectory)
      if (initialWorkflowsDirectory.kind === 'missing') {
        const secondWorkflowsDirectory = observeNativeDirectory(nativeRoot, workflowsDirectory)
        const finalGithubDirectory = observeNativeDirectory(nativeRoot, githubDirectory)
        discoveryAccepted =
          secondWorkflowsDirectory.kind === 'missing' &&
          isSameDirectoryGeneration(initialGithubDirectory, finalGithubDirectory)
      } else if (initialWorkflowsDirectory.kind === 'directory') {
        let directory: ReturnType<typeof opendirSync> | undefined
        let operationFailed = false
        const generationFindingStart = findings.length
        try {
          directory = opendirSync(workflowsDirectory)
          const workflowPaths: string[] = []
          let entry = directory.readSync()
          while (entry !== null) {
            if (workflowFilename.test(entry.name)) {
              workflowPaths.push(resolve(workflowsDirectory, entry.name))
            }
            entry = directory.readSync()
          }
          workflowPaths.sort(compareStrings)
          for (const path of workflowPaths) {
            inspectFile(path, true)
          }

          const finalWorkflowsDirectory = observeNativeDirectory(nativeRoot, workflowsDirectory)
          const finalGithubDirectory = observeNativeDirectory(nativeRoot, githubDirectory)
          if (
            isSameDirectoryGeneration(initialWorkflowsDirectory, finalWorkflowsDirectory) &&
            isSameDirectoryGeneration(initialGithubDirectory, finalGithubDirectory)
          ) {
            discoveryAccepted = true
          } else {
            operationFailed = true
          }
        } catch {
          operationFailed = true
        }
        generationFindings.push(...findings.splice(generationFindingStart))

        let closeFailed = false
        if (directory !== undefined) {
          try {
            directory.closeSync()
          } catch {
            closeFailed = true
          }
        }
        if (operationFailed || closeFailed) {
          discoveryAccepted = false
        }
      }
    }
  }

  if (discoveryAccepted) {
    findings.push(...generationFindings)
  } else {
    findings.push({ file: '.github/workflows', location: '$', rule: 'local-reference' })
  }

  return findings.sort(compareFindings)
}

export const formatWorkflowPolicyFindings = (findings: readonly WorkflowPolicyFinding[]) => {
  let output = ''
  if (findings.length > 0) {
    output = `${findings.map(finding => `${finding.file}:${finding.location}: ${finding.rule}`).join('\n')}\n`
  }
  return output
}

if (import.meta.main) {
  const findings = inspectWorkflowPolicy(process.cwd())
  if (findings.length > 0) {
    process.stderr.write(formatWorkflowPolicyFindings(findings))
    process.exitCode = 1
  }
}
