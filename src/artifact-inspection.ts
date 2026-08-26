import type { BigIntStats } from 'node:fs'
import { closeSync, constants, fstatSync, lstatSync, openSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  captureDirectoryWitness,
  type DirectoryWitness,
  DirectoryWitnessError,
  revalidateDirectoryWitness,
} from './directory-witness.ts'
import { sameStableEntryMetadata } from './filesystem-entry.ts'

export type ArtifactInspectionFault =
  | 'after-ancestor-capture'
  | 'after-ancestor-lstat'
  | 'after-artifact-fstat'
  | 'after-artifact-lstat'
  | 'after-artifact-open'
  | 'after-brain-lstat'
  | 'after-final-artifact-fstat'
  | 'before-ancestor-lstat'
  | 'before-final-directory-revalidation'

export type ArtifactInspectionHooks = {
  close?: ((descriptor: number) => void) | undefined
  fault?: ((point: ArtifactInspectionFault, artifact: string) => void) | undefined
  open?: ((path: string, flags: number) => number) | undefined
}

/** @internal */
export const artifactInspectionTestHooks: ArtifactInspectionHooks = {}

export type ArtifactObservation = Readonly<{
  metadata: BigIntStats
  path: string
}>

type ArtifactDirectoryEvidence = Readonly<{
  canonicalMetadata: BigIntStats
  canonicalPath: string
  path: string
  pathMetadata: BigIntStats
}>

type ArtifactInvalidReason =
  | 'ancestor-canonical-path'
  | 'ancestor-missing'
  | 'ancestor-type'
  | 'artifact-missing'
  | 'artifact-name'
  | 'artifact-type'
  | 'brain-missing'
  | 'brain-type'

type ArtifactInvalidEvidence = Readonly<{
  entryMetadata?: BigIntStats
  parent?: ArtifactDirectoryEvidence
  reason: ArtifactInvalidReason
}>

export type ArtifactInspectionResult =
  | Readonly<{
      error: ArtifactInvalidError
      evidence: ArtifactInvalidEvidence
      kind: 'invalid'
      path: string
    }>
  | Readonly<{ kind: 'stable'; observation: ArtifactObservation }>

type StableArtifactInspection = Extract<ArtifactInspectionResult, { kind: 'stable' }>

const artifactResultDirectories = new WeakMap<object, readonly ArtifactDirectoryEvidence[]>()
const invalidErrorDirectories = new WeakMap<ArtifactInvalidError, readonly ArtifactDirectoryEvidence[]>()

export class ArtifactInvalidError extends Error {
  readonly evidence: ArtifactInvalidEvidence

  constructor(
    message = 'Artifact must be an existing regular non-symlink file.',
    evidence: ArtifactInvalidEvidence = Object.freeze({ reason: 'artifact-missing' }),
  ) {
    super(message)
    this.name = 'ArtifactInvalidError'
    this.evidence = evidence
  }
}

export class ArtifactChangedError extends Error {
  constructor() {
    super('Artifact changed while it was being verified.')
    this.name = 'ArtifactChangedError'
  }
}

const noFollowFlag = typeof constants.O_NOFOLLOW === 'number' ? constants.O_NOFOLLOW : 0
const nonBlockFlag = typeof constants.O_NONBLOCK === 'number' ? constants.O_NONBLOCK : 0
const noControllingTerminalFlag = typeof constants.O_NOCTTY === 'number' ? constants.O_NOCTTY : 0
const artifactOpenFlags = constants.O_RDONLY | noFollowFlag | nonBlockFlag | noControllingTerminalFlag

const directoryEvidence = (witness: DirectoryWitness): ArtifactDirectoryEvidence =>
  Object.freeze({
    canonicalMetadata: Object.freeze(witness.canonicalMetadata),
    canonicalPath: witness.canonicalPath,
    path: witness.path,
    pathMetadata: Object.freeze(witness.pathMetadata),
  })

const directoryChainEvidence = (directories: readonly DirectoryWitness[]) =>
  Object.freeze(directories.map(directoryEvidence))

const retainResultDirectories = <Result extends ArtifactInspectionResult>(
  result: Result,
  directories: readonly DirectoryWitness[],
) => {
  artifactResultDirectories.set(result, directoryChainEvidence(directories))
  return result
}

const invalidEvidence = (
  reason: ArtifactInvalidReason,
  parent?: DirectoryWitness,
  entryMetadata?: BigIntStats,
): ArtifactInvalidEvidence =>
  Object.freeze({
    ...(entryMetadata === undefined ? {} : { entryMetadata: Object.freeze(entryMetadata) }),
    ...(parent === undefined ? {} : { parent: directoryEvidence(parent) }),
    reason,
  })

const sameDirectoryEvidence = (first: ArtifactDirectoryEvidence, second: ArtifactDirectoryEvidence) =>
  first.path === second.path &&
  first.canonicalPath === second.canonicalPath &&
  sameStableEntryMetadata(first.pathMetadata, second.pathMetadata) &&
  sameStableEntryMetadata(first.canonicalMetadata, second.canonicalMetadata)

const sameOptionalDirectoryEvidence = (
  first: ArtifactDirectoryEvidence | undefined,
  second: ArtifactDirectoryEvidence | undefined,
) => (first === undefined ? second === undefined : second !== undefined && sameDirectoryEvidence(first, second))

const sameOptionalMetadata = (first: BigIntStats | undefined, second: BigIntStats | undefined) =>
  first === undefined ? second === undefined : second !== undefined && sameStableEntryMetadata(first, second)

const sameDirectoryChain = (
  first: readonly ArtifactDirectoryEvidence[] | undefined,
  second: readonly ArtifactDirectoryEvidence[] | undefined,
) => {
  const firstDirectories = first ?? []
  const secondDirectories = second ?? []
  return (
    firstDirectories.length === secondDirectories.length &&
    firstDirectories.every((directory, index) => {
      const secondDirectory = secondDirectories[index]
      return secondDirectory !== undefined && sameDirectoryEvidence(directory, secondDirectory)
    })
  )
}

const sameInvalidEvidence = (first: ArtifactInvalidEvidence, second: ArtifactInvalidEvidence) =>
  first.reason === second.reason &&
  sameOptionalDirectoryEvidence(first.parent, second.parent) &&
  sameOptionalMetadata(first.entryMetadata, second.entryMetadata)

const artifactInspectionPath = (result: ArtifactInspectionResult) =>
  result.kind === 'stable' ? result.observation.path : result.path

export const sameArtifactInspectionResult = (first: ArtifactInspectionResult, second: ArtifactInspectionResult) =>
  artifactInspectionPath(first) === artifactInspectionPath(second) &&
  sameDirectoryChain(artifactResultDirectories.get(first), artifactResultDirectories.get(second)) &&
  (first.kind === 'stable'
    ? second.kind === 'stable' && sameStableEntryMetadata(first.observation.metadata, second.observation.metadata)
    : second.kind === 'invalid' &&
      first.error.name === second.error.name &&
      first.error.message === second.error.message &&
      sameInvalidEvidence(first.evidence, second.evidence))

const changed = (): never => {
  throw new ArtifactChangedError()
}

const invalid = (evidence: ArtifactInvalidEvidence, directories: readonly DirectoryWitness[] = []): never => {
  const error = new ArtifactInvalidError(undefined, evidence)
  invalidErrorDirectories.set(error, directoryChainEvidence(directories))
  throw error
}

const invalidResult = (
  path: string,
  evidence: ArtifactInvalidEvidence,
  directories: readonly DirectoryWitness[] = [],
) => {
  const error = new ArtifactInvalidError(undefined, evidence)
  const result = Object.freeze({ error, evidence, kind: 'invalid' as const, path })
  return retainResultDirectories(result, directories)
}

const isReplacementError = (error: unknown) => {
  const { code } = error as NodeJS.ErrnoException
  return code === 'ELOOP' || code === 'ENOENT' || code === 'ENOTDIR'
}

const revalidateDirectories = (directories: readonly DirectoryWitness[]) => {
  try {
    directories.reduce<undefined>((_, directory) => revalidateDirectoryWitness(directory), undefined)
  } catch (error) {
    if (error instanceof DirectoryWitnessError || isReplacementError(error)) {
      return changed()
    }
    throw error
  }
}

const captureAncestor = (
  directories: readonly DirectoryWitness[],
  segment: string,
  artifact: string,
  hooks: ArtifactInspectionHooks,
) => {
  const parent = directories.at(-1)
  if (parent === undefined) {
    return changed()
  }
  const path = resolve(parent.canonicalPath, segment)
  try {
    revalidateDirectoryWitness(parent)
    hooks.fault?.('before-ancestor-lstat', artifact)
    const metadata = lstatSync(path, { bigint: true })
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      revalidateDirectoryWitness(parent)
      return invalid(invalidEvidence('ancestor-type', parent, metadata), directories)
    }
    hooks.fault?.('after-ancestor-lstat', artifact)
    const witness = captureDirectoryWitness(path, { allowLink: false })
    hooks.fault?.('after-ancestor-capture', artifact)
    if (!sameStableEntryMetadata(metadata, witness.pathMetadata)) {
      return changed()
    }
    if (witness.canonicalPath !== path) {
      revalidateDirectories([parent, witness])
      return invalid(invalidEvidence('ancestor-canonical-path', parent, witness.pathMetadata), [
        ...directories,
        witness,
      ])
    }
    revalidateDirectoryWitness(parent)
    return witness
  } catch (error) {
    if (error instanceof ArtifactInvalidError) {
      throw error
    }
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      try {
        revalidateDirectoryWitness(parent)
        return invalid(invalidEvidence('ancestor-missing', parent), directories)
      } catch (revalidationError) {
        if (revalidationError instanceof DirectoryWitnessError || isReplacementError(revalidationError)) {
          return changed()
        }
        throw revalidationError
      }
    }
    if (error instanceof DirectoryWitnessError || isReplacementError(error)) {
      return changed()
    }
    throw error
  }
}

const captureAncestors = (brain: DirectoryWitness, artifact: string, hooks: ArtifactInspectionHooks) =>
  artifact
    .split('/')
    .slice(0, -1)
    .reduce<DirectoryWitness[]>(
      (directories, segment) => {
        const parent = directories.at(-1)
        if (parent === undefined) {
          return changed()
        }
        return [...directories, captureAncestor(directories, segment, artifact, hooks)]
      },
      [brain],
    )

const inspectFinalFile = (
  directories: readonly DirectoryWitness[],
  artifact: string,
  hooks: ArtifactInspectionHooks,
): StableArtifactInspection => {
  const parent = directories.at(-1)
  if (parent === undefined) {
    return changed()
  }
  const name = artifact.split('/').at(-1)
  if (name === undefined || name.length === 0) {
    return invalid(invalidEvidence('artifact-name', parent), directories)
  }
  const path = resolve(parent.canonicalPath, name)
  let pathMetadata: BigIntStats
  try {
    pathMetadata = lstatSync(path, { bigint: true })
  } catch (error) {
    if (isReplacementError(error)) {
      revalidateDirectories(directories)
      return invalid(invalidEvidence('artifact-missing', parent), directories)
    }
    throw error
  }
  if (!pathMetadata.isFile() || pathMetadata.isSymbolicLink()) {
    revalidateDirectories(directories)
    return invalid(invalidEvidence('artifact-type', parent, pathMetadata), directories)
  }
  hooks.fault?.('after-artifact-lstat', artifact)

  let descriptor: number
  try {
    descriptor = (hooks.open ?? openSync)(path, artifactOpenFlags)
  } catch (error) {
    if (isReplacementError(error)) {
      return changed()
    }
    let current: BigIntStats
    try {
      current = lstatSync(path, { bigint: true })
    } catch (revalidationError) {
      if (isReplacementError(revalidationError)) {
        return changed()
      }
      throw error
    }
    if (!current.isFile() || current.isSymbolicLink() || !sameStableEntryMetadata(pathMetadata, current)) {
      return changed()
    }
    revalidateDirectories(directories)
    throw error
  }
  let observation: ArtifactObservation | undefined
  let primaryError: unknown
  try {
    hooks.fault?.('after-artifact-open', artifact)
    const metadata = fstatSync(descriptor, { bigint: true })
    if (!(metadata.isFile() && sameStableEntryMetadata(pathMetadata, metadata))) {
      return changed()
    }
    hooks.fault?.('after-artifact-fstat', artifact)
    const finalMetadata = fstatSync(descriptor, { bigint: true })
    hooks.fault?.('after-final-artifact-fstat', artifact)
    const finalPathMetadata = lstatSync(path, { bigint: true })
    if (
      !finalPathMetadata.isFile() ||
      finalPathMetadata.isSymbolicLink() ||
      !sameStableEntryMetadata(metadata, finalMetadata) ||
      !sameStableEntryMetadata(finalMetadata, finalPathMetadata)
    ) {
      return changed()
    }
    hooks.fault?.('before-final-directory-revalidation', artifact)
    revalidateDirectories(directories)
    const acceptedMetadata = fstatSync(descriptor, { bigint: true })
    const acceptedPathMetadata = lstatSync(path, { bigint: true })
    if (
      !acceptedPathMetadata.isFile() ||
      acceptedPathMetadata.isSymbolicLink() ||
      !sameStableEntryMetadata(finalMetadata, acceptedMetadata) ||
      !sameStableEntryMetadata(acceptedMetadata, acceptedPathMetadata)
    ) {
      return changed()
    }
    const immutableMetadata = Object.freeze(acceptedMetadata)
    observation = Object.freeze({
      metadata: immutableMetadata,
      path: artifact,
    })
  } catch (error) {
    if (isReplacementError(error)) {
      primaryError = new ArtifactChangedError()
    } else {
      primaryError = error
    }
  }
  let closeError: unknown
  try {
    ;(hooks.close ?? closeSync)(descriptor)
  } catch (error) {
    closeError = error
  }
  if (primaryError !== undefined) {
    throw primaryError
  }
  if (closeError !== undefined) {
    throw closeError
  }
  if (observation === undefined) {
    return changed()
  }
  return retainResultDirectories(Object.freeze({ kind: 'stable' as const, observation }), directories)
}

export const inspectArtifactFiles = (
  brainDirectory: string,
  artifacts: readonly string[],
  hooks: ArtifactInspectionHooks = {},
): readonly ArtifactInspectionResult[] => {
  const effectiveHooks: ArtifactInspectionHooks = {
    close: hooks.close ?? artifactInspectionTestHooks.close,
    fault: hooks.fault ?? artifactInspectionTestHooks.fault,
    open: hooks.open ?? artifactInspectionTestHooks.open,
  }
  let brainMetadata: BigIntStats
  try {
    brainMetadata = lstatSync(brainDirectory, { bigint: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      const evidence = invalidEvidence('brain-missing')
      return Object.freeze(artifacts.map(path => invalidResult(path, evidence)))
    }
    throw error
  }
  if (!brainMetadata.isDirectory() || brainMetadata.isSymbolicLink()) {
    const evidence = invalidEvidence('brain-type', undefined, brainMetadata)
    return Object.freeze(artifacts.map(path => invalidResult(path, evidence)))
  }
  effectiveHooks.fault?.('after-brain-lstat', '')
  let brain: DirectoryWitness
  try {
    brain = captureDirectoryWitness(brainDirectory, { allowLink: false })
    if (!sameStableEntryMetadata(brainMetadata, brain.pathMetadata)) {
      return changed()
    }
  } catch (error) {
    if (error instanceof DirectoryWitnessError || isReplacementError(error)) {
      return changed()
    }
    throw error
  }
  const inspectArtifact = (artifact: string) => {
    try {
      return inspectFinalFile(captureAncestors(brain, artifact, effectiveHooks), artifact, effectiveHooks)
    } catch (error) {
      if (error instanceof ArtifactInvalidError) {
        const result = Object.freeze({
          error,
          evidence: error.evidence,
          kind: 'invalid' as const,
          path: artifact,
        })
        const directories = invalidErrorDirectories.get(error)
        if (directories !== undefined) {
          artifactResultDirectories.set(result, directories)
        }
        return result
      }
      throw error
    }
  }
  const results = artifacts.map(inspectArtifact)
  results.reduce<undefined>((verified, result) => {
    const path = result.kind === 'stable' ? result.observation.path : result.path
    const verification = inspectArtifact(path)
    if (!sameArtifactInspectionResult(result, verification)) {
      changed()
    }
    return verified
  }, undefined)
  revalidateDirectories([brain])
  return Object.freeze(results)
}
