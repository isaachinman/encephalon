import {
  type BigIntStats,
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  opendirSync,
  openSync,
  readSync,
  realpathSync,
} from 'node:fs'
import { extname, relative, resolve, sep } from 'node:path'
import { sameStableEntryMetadata } from '../src/filesystem-entry.ts'
import { ordinalStringCompare } from '../src/order.ts'

export type WorkflowPolicyRule =
  | 'credential-environment'
  | 'credential-forwarding'
  | 'external-reference-sha'
  | 'local-reference'
  | 'permission'
  | 'source-integrity'

export type WorkflowPolicyFinding = Readonly<{
  file: string
  location: string
  rule: WorkflowPolicyRule
}>

type ParsedObject = Record<string, unknown>

type ExecutableReference = Readonly<{
  kind: 'action' | 'workflow'
  location: string
  reference: string
}>

type ExecutableSource = Readonly<{
  kind: ExecutableReference['kind']
  path: string
  visitKey: string
}>

type WorkflowPolicyLimits = Readonly<{
  maximumAggregateSourceBytes: number
  maximumSecretTreeNodes: number
  maximumSourceBytes: number
  maximumSourceVisits: number
  maximumWorkflowDirectoryEntries: number
}>

/** @internal */
export type DescriptorIoObservation =
  | Readonly<{ allocatedBytes: number; kind: 'allocation' }>
  | Readonly<{ bytesRead: number; kind: 'read'; requestedBytes: number }>

type WorkflowPolicyOptions = Readonly<{
  afterActionCandidateRevalidation?: (path: string, index: number) => void
  afterFinalDirectoryRealpath?: (path: string) => void
  afterFinalFileRealpath?: (path: string) => void
  beforeFinalRevalidation?: () => void
  limits?: Partial<WorkflowPolicyLimits>
  onSourceDescriptorIo?: (path: string, observation: DescriptorIoObservation) => void
  onSourceVisit?: (phase: 'enter' | 'exit', path: string, kind: ExecutableReference['kind']) => void
}>

type ValidatedNativeFileOptions = Readonly<{
  afterFinalRealpath?: (path: string) => void
  maximumBytes?: number
  onDescriptorIo?: (observation: DescriptorIoObservation) => void
}>

type FileWitness = Readonly<{
  metadata: BigIntStats
  path: string
}>

type ValidatedNativeFile = Readonly<{
  bytes: number
  contents: string
  witness: FileWitness
}>

type ValidatedNativeFileResult =
  | Readonly<{ file: ValidatedNativeFile; kind: 'file' }>
  | Readonly<{ kind: 'invalid' }>
  | Readonly<{ kind: 'source-limit' }>

type SourceFileObservation =
  | Readonly<{ kind: 'file'; metadata: BigIntStats }>
  | Readonly<{ kind: 'invalid' }>
  | Readonly<{ kind: 'missing' }>

type ActionManifestWitness = Readonly<{
  observation: Exclude<SourceFileObservation, Readonly<{ kind: 'invalid' }>>
  path: string
}>

type ActionDirectoryWitness = Readonly<{
  candidates: readonly ActionManifestWitness[]
  metadata: BigIntStats
  path: string
  target: string
}>

type LocalTargetResult =
  | Readonly<{ kind: 'local-reference' }>
  | Readonly<{ kind: 'resolved'; actionDirectoryWitness?: ActionDirectoryWitness; path: string }>
  | Readonly<{ kind: 'source-integrity' }>

type WorkflowDiscoveryWitness =
  | Readonly<{ kind: 'github-missing'; root: FileSystemDirectoryWitness }>
  | Readonly<{
      github: FileSystemDirectoryWitness
      kind: 'workflows-missing'
      root: FileSystemDirectoryWitness
    }>
  | Readonly<{
      github: FileSystemDirectoryWitness
      kind: 'workflows-present'
      root: FileSystemDirectoryWitness
      workflows: FileSystemDirectoryWitness
    }>

type FileSystemDirectoryWitness = Readonly<{
  metadata: BigIntStats
  path: string
}>

// Policy keeps local directory-observation/failure semantics instead of importing runtime witness/error modules.
type DirectoryObservation =
  | Readonly<{ kind: 'directory'; stats: BigIntStats }>
  | Readonly<{ kind: 'invalid' }>
  | Readonly<{ kind: 'missing' }>

const fullCommitReference = /^[^\s@/]+\/[^\s@/]+(?:\/[^\s@/]+)*@[0-9a-f]{40}$/u
const localReference = /^(?:\.|\$)\//u
const identifierStart = /[A-Za-z_]/u
const identifierCharacter = /[A-Za-z0-9_-]/u
const expressionOpening = '${{'
const expressionClosing = '}}'
const secretsIdentifier = 'secrets'
const workflowFilename = /\.ya?ml$/u
const protectedEnvironment = 'pullfrog-review'
const actionManifestFilenames = ['action.yml', 'action.yaml'] as const
// Current checked-in policy sources are two workflows totalling 3,720 bytes; these limits leave broad local-wrapper headroom.
const workflowPolicyLimits: WorkflowPolicyLimits = {
  maximumAggregateSourceBytes: 4 * 1024 * 1024,
  maximumSecretTreeNodes: 16_384,
  maximumSourceBytes: 256 * 1024,
  maximumSourceVisits: 512,
  maximumWorkflowDirectoryEntries: 256,
}
const sourceIntegrityFinding = {
  file: '.github/workflows',
  location: '$',
  rule: 'source-integrity',
} as const satisfies WorkflowPolicyFinding
const workflowPolicyGuidance: Record<WorkflowPolicyRule, string> = {
  'credential-environment': 'target the exact pullfrog-review environment',
  'credential-forwarding': 'remove secrets from the external reusable-workflow call',
  'external-reference-sha': 'pin the external reference to a lowercase 40-character commit SHA',
  'local-reference': 'use an existing repository-contained target allowed for this local reference',
  permission: 'use the exact least-authority permission map allowed at this location',
  'source-integrity': 'restore stable, unambiguous regular workflow and action sources',
}

const compareFindings = (left: WorkflowPolicyFinding, right: WorkflowPolicyFinding) => {
  let comparison = ordinalStringCompare(left.file, right.file)
  if (comparison === 0) {
    comparison = ordinalStringCompare(left.location, right.location)
  }
  if (comparison === 0) {
    comparison = ordinalStringCompare(left.rule, right.rule)
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

const relativeFile = (root: string, path: string) => relative(root, path).split(sep).join('/')

const comparablePath = (path: string) =>
  process.platform === 'win32' ? path.replaceAll('\\', '/').toLowerCase() : path

const samePath = (first: string, second: string) => comparablePath(first) === comparablePath(second)

/** @internal */
export const isContainedComparablePath = (root: string, path: string) => {
  const descendantPrefix = root.endsWith('/') ? root : `${root}/`
  return root === path || path.startsWith(descendantPrefix)
}

const isContainedPath = (root: string, path: string) =>
  isContainedComparablePath(comparablePath(root), comparablePath(path))

const hasErrorCode = (value: unknown, code: string) => {
  let matches = false
  if (typeof value === 'object' && value !== null && 'code' in value) {
    matches = value.code === code
  }
  return matches
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

const isSingleLinkRegularFile = (stats: BigIntStats) => stats.isFile() && stats.nlink === 1n

const observeNativeFile = (
  root: string,
  path: string,
  afterRealpath?: (path: string) => void,
): SourceFileObservation => {
  let observation: SourceFileObservation = { kind: 'invalid' }
  let initialMetadata: BigIntStats | undefined
  try {
    initialMetadata = lstatSync(path, { bigint: true })
  } catch (error) {
    if (hasErrorCode(error, 'ENOENT')) {
      observation = { kind: 'missing' }
    }
  }
  if (initialMetadata !== undefined) {
    const nativePath = readRealPath(path)
    if (nativePath !== undefined) {
      afterRealpath?.(path)
      let finalMetadata: BigIntStats | undefined
      try {
        finalMetadata = lstatSync(path, { bigint: true })
      } catch {
        finalMetadata = undefined
      }
      if (
        finalMetadata !== undefined &&
        isSingleLinkRegularFile(initialMetadata) &&
        !initialMetadata.isSymbolicLink() &&
        isSingleLinkRegularFile(finalMetadata) &&
        !finalMetadata.isSymbolicLink() &&
        sameStableEntryMetadata(initialMetadata, finalMetadata) &&
        samePath(nativePath, path) &&
        isContainedPath(root, nativePath)
      ) {
        observation = { kind: 'file', metadata: finalMetadata }
      }
    }
  }
  return observation
}

const isNativeDirectory = (root: string, path: string, stats: BigIntStats, nativePath: string | undefined) =>
  stats.isDirectory() &&
  !stats.isSymbolicLink() &&
  nativePath !== undefined &&
  samePath(nativePath, path) &&
  isContainedPath(root, path)

const observeNativeDirectory = (
  root: string,
  path: string,
  afterRealpath?: (path: string) => void,
): DirectoryObservation => {
  let observation: DirectoryObservation = { kind: 'invalid' }
  let initialStats: BigIntStats | undefined
  try {
    initialStats = lstatSync(path, { bigint: true })
  } catch (error) {
    if (hasErrorCode(error, 'ENOENT')) {
      observation = { kind: 'missing' }
    }
  }
  if (initialStats !== undefined) {
    try {
      const nativePath = realpathSync.native(path)
      afterRealpath?.(path)
      const finalStats = lstatSync(path, { bigint: true })
      if (
        isNativeDirectory(root, path, initialStats, nativePath) &&
        isNativeDirectory(root, path, finalStats, nativePath) &&
        sameStableEntryMetadata(initialStats, finalStats)
      ) {
        observation = { kind: 'directory', stats: finalStats }
      }
    } catch {
      observation = { kind: 'invalid' }
    }
  }
  return observation
}

const isSameDirectoryGeneration = (initial: DirectoryObservation, final: DirectoryObservation) =>
  initial.kind === 'directory' && final.kind === 'directory' && sameStableEntryMetadata(initial.stats, final.stats)

const readBoundedDescriptor = (
  descriptor: number,
  sourceBytes: number,
  onDescriptorIo?: (observation: DescriptorIoObservation) => void,
) => {
  onDescriptorIo?.({ allocatedBytes: sourceBytes, kind: 'allocation' })
  const bytes = Buffer.alloc(sourceBytes)
  let bytesRead = 0
  let complete = true
  while (complete && bytesRead < sourceBytes) {
    const requestedBytes = sourceBytes - bytesRead
    const count = readSync(descriptor, bytes, bytesRead, requestedBytes, null)
    onDescriptorIo?.({ bytesRead: count, kind: 'read', requestedBytes })
    if (count === 0) {
      complete = false
    } else {
      bytesRead += count
    }
  }
  let contents: Readonly<{ bytes: number; value: string }> | undefined
  if (complete) {
    contents = { bytes: bytesRead, value: bytes.toString('utf8') }
  }
  return contents
}

/** @internal */
export const readValidatedNativeFile = (
  root: string,
  path: string,
  options: ValidatedNativeFileOptions = {},
): ValidatedNativeFileResult => {
  const maximumBytes = options.maximumBytes ?? workflowPolicyLimits.maximumSourceBytes
  let validatedFile: ValidatedNativeFile | undefined
  let descriptor: number | undefined
  let operationFailed = false
  let sourceLimitExceeded = false
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
      if (isSingleLinkRegularFile(beforeReadStats) && sameStableEntryMetadata(initialStats, beforeReadStats)) {
        if (beforeReadStats.size <= BigInt(maximumBytes)) {
          const candidateContents = readBoundedDescriptor(
            descriptor,
            Number(beforeReadStats.size),
            options.onDescriptorIo,
          )
          if (candidateContents === undefined) {
            operationFailed = true
          } else {
            const afterReadStats = fstatSync(descriptor, { bigint: true })
            const beforeFinalRealpathStats = lstatSync(path, { bigint: true })
            const finalNativePath = realpathSync.native(path)
            options.afterFinalRealpath?.(path)
            const finalStats = lstatSync(path, { bigint: true })
            if (
              isSingleLinkRegularFile(afterReadStats) &&
              isSingleLinkRegularFile(beforeFinalRealpathStats) &&
              isSingleLinkRegularFile(finalStats) &&
              !finalStats.isSymbolicLink() &&
              samePath(finalNativePath, path) &&
              isContainedPath(root, finalNativePath) &&
              sameStableEntryMetadata(beforeReadStats, afterReadStats) &&
              sameStableEntryMetadata(afterReadStats, beforeFinalRealpathStats) &&
              sameStableEntryMetadata(beforeFinalRealpathStats, finalStats)
            ) {
              validatedFile = {
                bytes: candidateContents.bytes,
                contents: candidateContents.value,
                witness: { metadata: finalStats, path },
              }
            } else {
              operationFailed = true
            }
          }
        } else {
          sourceLimitExceeded = true
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
  let result: ValidatedNativeFileResult = { kind: 'invalid' }
  if (!(operationFailed || closeFailed)) {
    if (sourceLimitExceeded) {
      result = { kind: 'source-limit' }
    } else if (validatedFile !== undefined) {
      result = { file: validatedFile, kind: 'file' }
    }
  }
  return result
}

const captureActionDirectoryTarget = (root: string, path: string): LocalTargetResult => {
  const initialDirectory = observeNativeDirectory(root, path)
  let result: LocalTargetResult = { kind: 'source-integrity' }
  if (initialDirectory.kind === 'missing') {
    result = { kind: 'local-reference' }
  } else if (initialDirectory.kind === 'directory') {
    const candidates = actionManifestFilenames.map(filename => {
      const candidatePath = resolve(path, filename)
      return { observation: observeNativeFile(root, candidatePath), path: candidatePath }
    })
    const finalDirectory = observeNativeDirectory(root, path)
    if (isSameDirectoryGeneration(initialDirectory, finalDirectory)) {
      const invalidCandidate = candidates.some(candidate => candidate.observation.kind === 'invalid')
      const presentCandidates = candidates.filter(
        (
          candidate,
        ): candidate is Readonly<{
          observation: Readonly<{ kind: 'file'; metadata: BigIntStats }>
          path: string
        }> => candidate.observation.kind === 'file',
      )
      if (invalidCandidate || presentCandidates.length > 1) {
        result = { kind: 'source-integrity' }
      } else if (presentCandidates.length === 0) {
        result = { kind: 'local-reference' }
      } else {
        const [presentCandidate] = presentCandidates
        if (presentCandidate !== undefined && finalDirectory.kind === 'directory') {
          result = {
            actionDirectoryWitness: {
              candidates: candidates as readonly ActionManifestWitness[],
              metadata: finalDirectory.stats,
              path,
              target: presentCandidate.path,
            },
            kind: 'resolved',
            path: presentCandidate.path,
          }
        }
      }
    }
  }
  return result
}

const resolveLocalTarget = (root: string, reference: string, kind: ExecutableReference['kind']): LocalTargetResult => {
  const repositoryRelativeReference = reference.startsWith('$/') ? `./${reference.slice(2)}` : reference
  const candidate = resolve(root, repositoryRelativeReference)
  let result: LocalTargetResult = { kind: 'local-reference' }
  if (isContainedPath(root, candidate)) {
    if (kind === 'workflow' && (extname(candidate) === '.yml' || extname(candidate) === '.yaml')) {
      const observation = observeNativeFile(root, candidate)
      if (observation.kind === 'file') {
        result = { kind: 'resolved', path: candidate }
      } else if (observation.kind === 'invalid') {
        result = { kind: 'source-integrity' }
      }
    } else if (kind === 'action') {
      result = captureActionDirectoryTarget(root, candidate)
    }
  }
  return result
}

const sameAcceptedFileObservation = (
  expected: ActionManifestWitness['observation'],
  current: SourceFileObservation,
) => {
  let matches = expected.kind === 'missing' && current.kind === 'missing'
  if (expected.kind === 'file' && current.kind === 'file') {
    matches = sameStableEntryMetadata(expected.metadata, current.metadata)
  }
  return matches
}

const sameActionDirectoryWitness = (left: ActionDirectoryWitness, right: ActionDirectoryWitness) =>
  samePath(left.path, right.path) &&
  samePath(left.target, right.target) &&
  sameStableEntryMetadata(left.metadata, right.metadata) &&
  left.candidates.length === right.candidates.length &&
  left.candidates.every((candidate, index) => {
    const otherCandidate = right.candidates[index]
    return (
      otherCandidate !== undefined &&
      samePath(candidate.path, otherCandidate.path) &&
      sameAcceptedFileObservation(candidate.observation, otherCandidate.observation)
    )
  })

const revalidateFileWitness = (root: string, witness: FileWitness, afterRealpath?: (path: string) => void) => {
  const current = observeNativeFile(root, witness.path, afterRealpath)
  return current.kind === 'file' && sameStableEntryMetadata(witness.metadata, current.metadata)
}

const revalidateActionDirectoryWitness = (
  root: string,
  witness: ActionDirectoryWitness,
  options: WorkflowPolicyOptions,
) => {
  const initialDirectory = observeNativeDirectory(root, witness.path, options.afterFinalDirectoryRealpath)
  const candidatesMatch = witness.candidates.every((candidate, index) => {
    const current = observeNativeFile(root, candidate.path, options.afterFinalFileRealpath)
    options.afterActionCandidateRevalidation?.(witness.path, index)
    return sameAcceptedFileObservation(candidate.observation, current)
  })
  const finalDirectory = observeNativeDirectory(root, witness.path, options.afterFinalDirectoryRealpath)
  return (
    candidatesMatch &&
    initialDirectory.kind === 'directory' &&
    finalDirectory.kind === 'directory' &&
    sameStableEntryMetadata(witness.metadata, initialDirectory.stats) &&
    sameStableEntryMetadata(initialDirectory.stats, finalDirectory.stats)
  )
}

const directoryWitness = (path: string, observation: DirectoryObservation) => {
  let witness: FileSystemDirectoryWitness | undefined
  if (observation.kind === 'directory') {
    witness = { metadata: observation.stats, path }
  }
  return witness
}

const revalidateDirectoryWitness = (
  root: string,
  witness: FileSystemDirectoryWitness,
  afterRealpath?: (path: string) => void,
) => {
  const current = observeNativeDirectory(root, witness.path, afterRealpath)
  return current.kind === 'directory' && sameStableEntryMetadata(witness.metadata, current.stats)
}

const revalidateWorkflowDiscovery = (
  root: string,
  witness: WorkflowDiscoveryWitness,
  afterRealpath?: (path: string) => void,
) => {
  let accepted = revalidateDirectoryWitness(root, witness.root, afterRealpath)
  if (witness.kind === 'github-missing') {
    accepted = accepted && observeNativeDirectory(root, resolve(root, '.github'), afterRealpath).kind === 'missing'
  } else {
    accepted = accepted && revalidateDirectoryWitness(root, witness.github, afterRealpath)
    if (witness.kind === 'workflows-missing') {
      accepted =
        accepted && observeNativeDirectory(root, resolve(root, '.github/workflows'), afterRealpath).kind === 'missing'
    } else {
      accepted = accepted && revalidateDirectoryWitness(root, witness.workflows, afterRealpath)
    }
  }
  return accepted
}

const stepReferences = (value: unknown, location: string): readonly ExecutableReference[] => {
  let references: readonly ExecutableReference[] = []
  if (Array.isArray(value)) {
    references = value.flatMap((step, index) => {
      let stepReference: readonly ExecutableReference[] = []
      if (isPlainObject(step) && typeof step.uses === 'string') {
        stepReference = [
          {
            kind: 'action',
            location: `${location}[${String(index)}].uses`,
            reference: step.uses,
          },
        ]
      }
      return stepReference
    })
  }
  return references
}

const executableReferences = (
  document: ParsedObject,
  kind: ExecutableReference['kind'],
): readonly ExecutableReference[] => {
  let references: readonly ExecutableReference[] = []
  if (kind === 'workflow' && isPlainObject(document.jobs)) {
    references = Object.entries(document.jobs).flatMap(([jobName, job]) => {
      let jobReferences: readonly ExecutableReference[] = []
      if (isPlainObject(job)) {
        const reusableWorkflow =
          typeof job.uses === 'string'
            ? [
                {
                  kind: 'workflow' as const,
                  location: `jobs.${jobName}.uses`,
                  reference: job.uses,
                },
              ]
            : []
        jobReferences = [...reusableWorkflow, ...stepReferences(job.steps, `jobs.${jobName}.steps`)]
      }
      return jobReferences
    })
  } else if (kind === 'action' && isPlainObject(document.runs)) {
    references = stepReferences(document.runs.steps, 'runs.steps')
  }
  return references
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

type SecretTreeBudget = {
  maximum: number
  nodes: number
}

type SecretTreeFrame = Readonly<{ kind: 'enter'; value: unknown }> | Readonly<{ kind: 'exit'; value: object }>

const containsSecretExpression = (value: unknown, budget: SecretTreeBudget) => {
  const active = new WeakSet<object>()
  const visited = new WeakSet<object>()
  const stack: SecretTreeFrame[] = [{ kind: 'enter', value }]
  let pendingNodes = 1
  let accepted = true
  let containsSecret = false
  while (accepted && stack.length > 0) {
    const frame = stack.pop()
    if (frame?.kind === 'exit') {
      active.delete(frame.value)
    } else if (frame?.kind === 'enter') {
      pendingNodes -= 1
      budget.nodes += 1
      if (budget.nodes > budget.maximum) {
        accepted = false
      } else if (typeof frame.value === 'string') {
        containsSecret = stringContainsSecretExpression(frame.value) || containsSecret
      } else if (Array.isArray(frame.value) || isPlainObject(frame.value)) {
        const object = frame.value
        if (active.has(object)) {
          accepted = false
        } else if (!visited.has(object)) {
          visited.add(object)
          active.add(object)
          stack.push({ kind: 'exit', value: object })
          const children = Array.isArray(object) ? object : Object.values(object)
          if (children.length > budget.maximum - budget.nodes - pendingNodes) {
            accepted = false
          } else {
            pendingNodes += children.length
            for (let index = children.length - 1; index >= 0; index -= 1) {
              stack.push({ kind: 'enter', value: children[index] })
            }
          }
        }
      }
    }
  }
  return { accepted, containsSecret }
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

const inspectExternalReusableWorkflowPermissions = (
  job: ParsedObject,
  jobName: string,
  file: string,
  findings: WorkflowPolicyFinding[],
) => {
  const exactEmptyPermissions = isPlainObject(job.permissions) && Object.keys(job.permissions).length === 0
  if (!exactEmptyPermissions) {
    findings.push({ file, location: `jobs.${jobName}.permissions`, rule: 'permission' })
  }
}

const inspectWorkflowJobs = (
  document: ParsedObject,
  file: string,
  findings: WorkflowPolicyFinding[],
  secretTreeBudget: SecretTreeBudget,
) => {
  const { jobs } = document
  let accepted = true
  let workflowEnvironmentContainsSecret = false
  if (document.env !== undefined) {
    const { accepted: environmentAccepted, containsSecret } = containsSecretExpression(document.env, secretTreeBudget)
    accepted = environmentAccepted
    workflowEnvironmentContainsSecret = containsSecret
  }
  if (accepted && isPlainObject(jobs)) {
    for (const [jobName, value] of Object.entries(jobs)) {
      if (accepted && isPlainObject(value)) {
        const reusableWorkflowReference = value.uses
        if (typeof reusableWorkflowReference === 'string') {
          if (localReference.test(reusableWorkflowReference)) {
            inspectJobPermissions(value, jobName, file, findings)
          } else {
            inspectExternalReusableWorkflowPermissions(value, jobName, file, findings)
            if (value.secrets !== undefined) {
              findings.push({ file, location: `jobs.${jobName}.secrets`, rule: 'credential-forwarding' })
            }
          }
        } else {
          inspectJobPermissions(value, jobName, file, findings)
          const { accepted: jobAccepted, containsSecret } = containsSecretExpression(value, secretTreeBudget)
          accepted = jobAccepted
          const credentialBearing =
            workflowEnvironmentContainsSecret ||
            containsSecret ||
            effectiveIdTokenIsWrite(document.permissions, value.permissions)
          if (accepted && credentialBearing && !hasProtectedEnvironment(value.environment)) {
            findings.push({ file, location: `jobs.${jobName}.environment`, rule: 'credential-environment' })
          }
        }
      }
    }
  }
  return accepted
}

export const inspectWorkflowPolicy = (
  root: string,
  options: WorkflowPolicyOptions = {},
): readonly WorkflowPolicyFinding[] => {
  const limits = { ...workflowPolicyLimits, ...options.limits }
  const nativeRoot = readRealPath(resolve(root))
  let policyFindings: readonly WorkflowPolicyFinding[] = [sourceIntegrityFinding]
  if (nativeRoot === undefined) {
    policyFindings = [sourceIntegrityFinding]
  } else {
    const findings: WorkflowPolicyFinding[] = []
    const roleVisits = new Set<string>()
    const fileWitnesses = new Map<string, FileWitness>()
    const actionDirectoryWitnesses = new Map<string, ActionDirectoryWitness>()
    const sourceQueue: ExecutableSource[] = []
    const secretTreeBudget: SecretTreeBudget = { maximum: limits.maximumSecretTreeNodes, nodes: 0 }
    let aggregateSourceBytes = 0
    let traversalIntegrityAccepted = true

    const scheduleFile = (path: string, kind: ExecutableReference['kind']) => {
      const visitKey = `${kind}\0${comparablePath(path)}`
      if (!roleVisits.has(visitKey)) {
        if (roleVisits.size < limits.maximumSourceVisits) {
          roleVisits.add(visitKey)
          sourceQueue.push({ kind, path, visitKey })
        } else {
          traversalIntegrityAccepted = false
        }
      }
    }

    const inspectFile = (source: ExecutableSource) => {
      const file = relativeFile(nativeRoot, source.path)
      let document: ParsedObject | undefined
      let validatedFile: ValidatedNativeFile | undefined
      const remainingAggregateSourceBytes = Math.max(0, limits.maximumAggregateSourceBytes - aggregateSourceBytes)
      const sourceAllowance = Math.max(0, Math.min(limits.maximumSourceBytes, remainingAggregateSourceBytes))
      const readResult = readValidatedNativeFile(nativeRoot, source.path, {
        maximumBytes: sourceAllowance,
        onDescriptorIo: observation => {
          options.onSourceDescriptorIo?.(source.path, observation)
        },
      })
      if (readResult.kind === 'source-limit') {
        traversalIntegrityAccepted = false
      } else if (readResult.kind === 'file') {
        aggregateSourceBytes += readResult.file.bytes
        if (aggregateSourceBytes <= limits.maximumAggregateSourceBytes) {
          validatedFile = readResult.file
          fileWitnesses.set(source.visitKey, validatedFile.witness)
        } else {
          traversalIntegrityAccepted = false
        }
      }

      if (traversalIntegrityAccepted && validatedFile !== undefined) {
        try {
          const parsed = Bun.YAML.parse(validatedFile.contents)
          if (isPlainObject(parsed)) {
            document = parsed
          }
        } catch {
          document = undefined
        }
      }

      if (traversalIntegrityAccepted) {
        if (document === undefined) {
          findings.push({ file, location: '$', rule: 'source-integrity' })
        } else {
          if (source.kind === 'workflow') {
            inspectWorkflowPermissions(document, file, findings)
            traversalIntegrityAccepted = inspectWorkflowJobs(document, file, findings, secretTreeBudget)
          }

          if (traversalIntegrityAccepted) {
            for (const reference of executableReferences(document, source.kind)) {
              if (traversalIntegrityAccepted) {
                if (localReference.test(reference.reference)) {
                  const workspaceRelativeAction = reference.kind === 'action' && reference.reference.startsWith('./')
                  const target = workspaceRelativeAction
                    ? ({ kind: 'local-reference' } as const)
                    : resolveLocalTarget(nativeRoot, reference.reference, reference.kind)
                  if (target.kind === 'local-reference') {
                    findings.push({ file, location: reference.location, rule: 'local-reference' })
                  } else if (target.kind === 'source-integrity') {
                    findings.push({ file, location: reference.location, rule: 'source-integrity' })
                  } else {
                    if (target.actionDirectoryWitness !== undefined) {
                      const directoryKey = comparablePath(target.actionDirectoryWitness.path)
                      const existingWitness = actionDirectoryWitnesses.get(directoryKey)
                      if (existingWitness === undefined) {
                        actionDirectoryWitnesses.set(directoryKey, target.actionDirectoryWitness)
                      } else if (!sameActionDirectoryWitness(existingWitness, target.actionDirectoryWitness)) {
                        traversalIntegrityAccepted = false
                      }
                    }
                    if (traversalIntegrityAccepted) {
                      scheduleFile(target.path, reference.kind)
                    }
                  }
                } else if (!fullCommitReference.test(reference.reference)) {
                  findings.push({ file, location: reference.location, rule: 'external-reference-sha' })
                }
              }
            }
          }
        }
      }
    }

    const githubDirectory = resolve(nativeRoot, '.github')
    const workflowsDirectory = resolve(githubDirectory, 'workflows')
    const initialRoot = observeNativeDirectory(nativeRoot, nativeRoot)
    const initialGithubDirectory = observeNativeDirectory(nativeRoot, githubDirectory)
    let discoveryWitness: WorkflowDiscoveryWitness | undefined

    if (initialRoot.kind === 'directory') {
      if (initialGithubDirectory.kind === 'missing') {
        const secondGithubDirectory = observeNativeDirectory(nativeRoot, githubDirectory)
        const finalRoot = observeNativeDirectory(nativeRoot, nativeRoot)
        const rootWitness = directoryWitness(nativeRoot, finalRoot)
        if (
          secondGithubDirectory.kind === 'missing' &&
          isSameDirectoryGeneration(initialRoot, finalRoot) &&
          rootWitness !== undefined
        ) {
          discoveryWitness = { kind: 'github-missing', root: rootWitness }
        }
      } else if (initialGithubDirectory.kind === 'directory') {
        const initialWorkflowsDirectory = observeNativeDirectory(nativeRoot, workflowsDirectory)
        if (initialWorkflowsDirectory.kind === 'missing') {
          const secondWorkflowsDirectory = observeNativeDirectory(nativeRoot, workflowsDirectory)
          const finalGithubDirectory = observeNativeDirectory(nativeRoot, githubDirectory)
          const finalRoot = observeNativeDirectory(nativeRoot, nativeRoot)
          const rootWitness = directoryWitness(nativeRoot, finalRoot)
          const githubWitness = directoryWitness(githubDirectory, finalGithubDirectory)
          if (
            secondWorkflowsDirectory.kind === 'missing' &&
            isSameDirectoryGeneration(initialRoot, finalRoot) &&
            isSameDirectoryGeneration(initialGithubDirectory, finalGithubDirectory) &&
            rootWitness !== undefined &&
            githubWitness !== undefined
          ) {
            discoveryWitness = { github: githubWitness, kind: 'workflows-missing', root: rootWitness }
          }
        } else if (initialWorkflowsDirectory.kind === 'directory') {
          let directory: ReturnType<typeof opendirSync> | undefined
          let operationFailed = false
          let candidateWitness: WorkflowDiscoveryWitness | undefined
          try {
            directory = opendirSync(workflowsDirectory)
            const workflowPaths: string[] = []
            let workflowDirectoryEntries = 0
            let entry = directory.readSync()
            while (entry !== null && !operationFailed) {
              workflowDirectoryEntries += 1
              if (workflowDirectoryEntries <= limits.maximumWorkflowDirectoryEntries) {
                if (workflowFilename.test(entry.name)) {
                  workflowPaths.push(resolve(workflowsDirectory, entry.name))
                }
                entry = directory.readSync()
              } else {
                operationFailed = true
              }
            }

            if (!operationFailed) {
              workflowPaths.sort(ordinalStringCompare)
              for (const path of workflowPaths) {
                if (traversalIntegrityAccepted) {
                  scheduleFile(path, 'workflow')
                }
              }
              let sourceIndex = 0
              while (traversalIntegrityAccepted && sourceIndex < sourceQueue.length) {
                const source = sourceQueue[sourceIndex]
                sourceIndex += 1
                if (source !== undefined) {
                  options.onSourceVisit?.('enter', source.path, source.kind)
                  try {
                    inspectFile(source)
                  } finally {
                    options.onSourceVisit?.('exit', source.path, source.kind)
                  }
                }
              }
            }

            const finalWorkflowsDirectory = observeNativeDirectory(nativeRoot, workflowsDirectory)
            const finalGithubDirectory = observeNativeDirectory(nativeRoot, githubDirectory)
            const finalRoot = observeNativeDirectory(nativeRoot, nativeRoot)
            const rootWitness = directoryWitness(nativeRoot, finalRoot)
            const githubWitness = directoryWitness(githubDirectory, finalGithubDirectory)
            const workflowsWitness = directoryWitness(workflowsDirectory, finalWorkflowsDirectory)
            if (
              isSameDirectoryGeneration(initialRoot, finalRoot) &&
              isSameDirectoryGeneration(initialWorkflowsDirectory, finalWorkflowsDirectory) &&
              isSameDirectoryGeneration(initialGithubDirectory, finalGithubDirectory) &&
              rootWitness !== undefined &&
              githubWitness !== undefined &&
              workflowsWitness !== undefined
            ) {
              candidateWitness = {
                github: githubWitness,
                kind: 'workflows-present',
                root: rootWitness,
                workflows: workflowsWitness,
              }
            } else {
              operationFailed = true
            }
          } catch {
            operationFailed = true
          }

          let closeFailed = false
          if (directory !== undefined) {
            try {
              directory.closeSync()
            } catch {
              closeFailed = true
            }
          }
          if (!(operationFailed || closeFailed)) {
            discoveryWitness = candidateWitness
          }
        }
      }
    }

    let finalIntegrityAccepted = discoveryWitness !== undefined && traversalIntegrityAccepted
    if (finalIntegrityAccepted && discoveryWitness !== undefined) {
      try {
        options.beforeFinalRevalidation?.()
        finalIntegrityAccepted =
          revalidateWorkflowDiscovery(nativeRoot, discoveryWitness, options.afterFinalDirectoryRealpath) &&
          Array.from(fileWitnesses.values()).every(witness =>
            revalidateFileWitness(nativeRoot, witness, options.afterFinalFileRealpath),
          ) &&
          Array.from(actionDirectoryWitnesses.values()).every(witness =>
            revalidateActionDirectoryWitness(nativeRoot, witness, options),
          )
      } catch {
        finalIntegrityAccepted = false
      }
    }

    if (finalIntegrityAccepted) {
      policyFindings = findings.sort(compareFindings)
    }
  }
  return policyFindings
}

export const formatWorkflowPolicyFindings = (findings: readonly WorkflowPolicyFinding[]) => {
  let output = ''
  if (findings.length > 0) {
    output = `${findings
      .map(finding => `${finding.file}:${finding.location}: ${finding.rule}: ${workflowPolicyGuidance[finding.rule]}`)
      .join('\n')}\n`
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
