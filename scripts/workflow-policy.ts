import { lstatSync, readdirSync, readFileSync, realpathSync, type Stats } from 'node:fs'
import { extname, relative, resolve, sep } from 'node:path'

export type WorkflowPolicyRule = 'credential-environment' | 'external-action-sha' | 'local-reference' | 'permission'

export type WorkflowPolicyFinding = Readonly<{
  file: string
  location: string
  rule: WorkflowPolicyRule
}>

type ParsedObject = Record<string, unknown>

const fullCommitReference = /^[^\s@/]+\/[^\s@/]+(?:\/[^\s@/]+)*@[0-9a-f]{40}$/u
const localReference = /^\.\//u
const secretExpression = /\$\{\{\s*secrets\s*(?:\.|\[)/u
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

const isContainedPath = (root: string, path: string) => path === root || path.startsWith(`${root}${sep}`)

const hasErrorCode = (value: unknown, code: string) => {
  let matches = false
  if (typeof value === 'object' && value !== null && 'code' in value) {
    matches = value.code === code
  }
  return matches
}

const readStats = (path: string) => {
  let stats: Stats | undefined
  try {
    stats = lstatSync(path)
  } catch {
    stats = undefined
  }
  return stats
}

const readRealPath = (path: string) => {
  let nativePath: string | undefined
  try {
    nativePath = realpathSync.native(path)
  } catch {
    nativePath = undefined
  }
  return nativePath
}

const isRegularNativeFile = (root: string, path: string) => {
  const stats = readStats(path)
  const nativePath = readRealPath(path)
  return (
    stats?.isFile() === true &&
    stats.isSymbolicLink() === false &&
    nativePath === path &&
    isContainedPath(root, nativePath)
  )
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
      const isNativeDirectory =
        directoryStats?.isDirectory() === true &&
        directoryStats.isSymbolicLink() === false &&
        nativeDirectory === candidate &&
        isContainedPath(root, nativeDirectory)
      if (isNativeDirectory) {
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

const containsSecretExpression = (value: unknown): boolean => {
  let containsSecret = false
  if (typeof value === 'string') {
    containsSecret = secretExpression.test(value)
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
  if (permissions === 'write-all') {
    findings.push({ file, location: `jobs.${jobName}.permissions`, rule: 'permission' })
  } else if (isPlainObject(permissions)) {
    for (const [permission, access] of Object.entries(permissions)) {
      if (permission === 'contents' && access !== 'read') {
        findings.push({ file, location: `jobs.${jobName}.permissions.contents`, rule: 'permission' })
      } else if (permission !== 'contents' && access === 'write') {
        const allowsPullfrogOidc =
          permission === 'id-token' &&
          file === '.github/workflows/pullfrog.yml' &&
          jobName === 'pullfrog' &&
          hasProtectedEnvironment(job.environment)
        if (!allowsPullfrogOidc) {
          findings.push({ file, location: `jobs.${jobName}.permissions.${permission}`, rule: 'permission' })
        }
      }
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
  const nativeRoot = realpathSync.native(resolve(root))
  const findings: WorkflowPolicyFinding[] = []
  const parsedPaths = new Set<string>()

  const inspectFile = (path: string, rootWorkflow: boolean) => {
    if (!parsedPaths.has(path)) {
      parsedPaths.add(path)
      const file = relativeFile(nativeRoot, path)
      let document: ParsedObject | undefined
      try {
        const parsed = Bun.YAML.parse(readFileSync(path, 'utf8'))
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

  const workflowsDirectory = resolve(nativeRoot, '.github', 'workflows')
  let workflowPaths: string[] = []
  try {
    workflowPaths = readdirSync(workflowsDirectory, { withFileTypes: true })
      .filter(entry => entry.isFile() && workflowFilename.test(entry.name))
      .map(entry => resolve(workflowsDirectory, entry.name))
      .sort(compareStrings)
  } catch (error) {
    if (!hasErrorCode(error, 'ENOENT')) {
      findings.push({ file: '.github/workflows', location: '$', rule: 'local-reference' })
    }
  }
  for (const path of workflowPaths) {
    inspectFile(path, true)
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
