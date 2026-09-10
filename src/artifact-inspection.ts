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
  | 'before-closing-revalidation'
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

type ArtifactDirectory = DirectoryWitness & Readonly<{ parent?: ArtifactDirectory }>

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
  path: string
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

export type ArtifactInspection = Readonly<{
  assertCurrent: () => void
  results: readonly ArtifactInspectionResult[]
}>

export class ArtifactInvalidError extends Error {
  readonly evidence: ArtifactInvalidEvidence

  constructor(evidence: ArtifactInvalidEvidence) {
    super('Artifact must be an existing regular non-symlink file.')
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

const invalidEvidence = (
  reason: ArtifactInvalidReason,
  path: string,
  entryMetadata?: BigIntStats,
): ArtifactInvalidEvidence =>
  Object.freeze({
    ...(entryMetadata === undefined ? {} : { entryMetadata: Object.freeze(entryMetadata) }),
    path,
    reason,
  })

const changed = (): never => {
  throw new ArtifactChangedError()
}

const invalid = (evidence: ArtifactInvalidEvidence): never => {
  throw new ArtifactInvalidError(evidence)
}

const invalidResult = (path: string, evidence: ArtifactInvalidEvidence) => {
  const error = new ArtifactInvalidError(evidence)
  const result = Object.freeze({ error, evidence, kind: 'invalid' as const, path })
  return result
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

const revalidateAncestorChain = (directory: ArtifactDirectory): undefined => {
  if (directory.parent !== undefined) {
    revalidateAncestorChain(directory.parent)
  }
  revalidateDirectories([directory])
}

const captureAncestor = (
  parent: ArtifactDirectory,
  segment: string,
  artifact: string,
  hooks: ArtifactInspectionHooks,
) => {
  const path = resolve(parent.canonicalPath, segment)
  try {
    revalidateDirectoryWitness(parent)
    hooks.fault?.('before-ancestor-lstat', artifact)
    const metadata = lstatSync(path, { bigint: true })
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      revalidateDirectoryWitness(parent)
      return invalid(invalidEvidence('ancestor-type', path, metadata))
    }
    hooks.fault?.('after-ancestor-lstat', artifact)
    const witness = captureDirectoryWitness(path, { allowLink: false })
    hooks.fault?.('after-ancestor-capture', artifact)
    if (!sameStableEntryMetadata(metadata, witness.pathMetadata)) {
      return changed()
    }
    if (witness.canonicalPath !== path) {
      revalidateDirectories([parent, witness])
      return Object.freeze({ ...witness, parent })
    }
    revalidateDirectoryWitness(parent)
    return Object.freeze({ ...witness, parent })
  } catch (error) {
    if (error instanceof ArtifactInvalidError) {
      throw error
    }
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      try {
        revalidateDirectoryWitness(parent)
        return invalid(invalidEvidence('ancestor-missing', path))
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

const captureAncestors = (
  brain: ArtifactDirectory,
  artifact: string,
  ancestors: Map<string, ArtifactDirectory | ArtifactInvalidError>,
  hooks: ArtifactInspectionHooks,
) =>
  artifact
    .split('/')
    .slice(0, -1)
    .reduce<ArtifactDirectory>((parent, segment) => {
      const path = resolve(parent.canonicalPath, segment)
      let witness = ancestors.get(path)
      if (witness === undefined) {
        try {
          witness = captureAncestor(parent, segment, artifact, hooks)
        } catch (error) {
          if (error instanceof ArtifactInvalidError) {
            witness = error
          } else {
            throw error
          }
        }
        ancestors.set(path, witness)
      }
      if (witness instanceof ArtifactInvalidError) {
        throw witness
      }
      if (witness.canonicalPath !== path) {
        return invalid(invalidEvidence('ancestor-canonical-path', path, witness.pathMetadata))
      }
      return witness
    }, brain)

const inspectFinalFile = (
  parent: ArtifactDirectory,
  artifact: string,
  hooks: ArtifactInspectionHooks,
): StableArtifactInspection => {
  const name = artifact.split('/').at(-1)
  if (name === undefined || name.length === 0) {
    return invalid(invalidEvidence('artifact-name', parent.canonicalPath, parent.canonicalMetadata))
  }
  const path = resolve(parent.canonicalPath, name)
  let pathMetadata: BigIntStats
  try {
    pathMetadata = lstatSync(path, { bigint: true })
  } catch (error) {
    if (isReplacementError(error)) {
      revalidateDirectories([parent])
      return invalid(invalidEvidence('artifact-missing', path))
    }
    throw error
  }
  if (!pathMetadata.isFile() || pathMetadata.isSymbolicLink()) {
    revalidateDirectories([parent])
    return invalid(invalidEvidence('artifact-type', path, pathMetadata))
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
    revalidateAncestorChain(parent)
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
    revalidateDirectories([parent])
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
  return Object.freeze({ kind: 'stable' as const, observation })
}

const assertEntryCurrent = (path: string, expected?: BigIntStats) => {
  let current: BigIntStats | undefined
  try {
    current = lstatSync(path, { bigint: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      if (isReplacementError(error)) {
        return changed()
      }
      throw error
    }
  }
  const same =
    expected === undefined ? current === undefined : current !== undefined && sameStableEntryMetadata(expected, current)
  if (!same) {
    changed()
  }
}

export const inspectArtifactFiles = (
  brainDirectory: string,
  artifacts: readonly string[],
  hooks: ArtifactInspectionHooks = {},
): ArtifactInspection => {
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
      const evidence = invalidEvidence('brain-missing', brainDirectory)
      return Object.freeze({
        assertCurrent: () => assertEntryCurrent(brainDirectory),
        results: Object.freeze(artifacts.map(path => invalidResult(path, evidence))),
      })
    }
    throw error
  }
  if (!brainMetadata.isDirectory() || brainMetadata.isSymbolicLink()) {
    const evidence = invalidEvidence('brain-type', brainDirectory, brainMetadata)
    return Object.freeze({
      assertCurrent: () => assertEntryCurrent(brainDirectory, brainMetadata),
      results: Object.freeze(artifacts.map(path => invalidResult(path, evidence))),
    })
  }
  effectiveHooks.fault?.('after-brain-lstat', '')
  let brain: ArtifactDirectory
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
  const ancestors = new Map<string, ArtifactDirectory | ArtifactInvalidError>([[brainDirectory, brain]])
  const entries = new Map<string, BigIntStats | undefined>()
  const retainEntry = (path: string, metadata: BigIntStats | undefined) => {
    if (entries.has(path)) {
      const previous = entries.get(path)
      const same =
        previous === undefined
          ? metadata === undefined
          : metadata !== undefined && sameStableEntryMetadata(previous, metadata)
      if (!same) {
        changed()
      }
    } else {
      entries.set(path, metadata)
    }
  }
  const inspectArtifact = (artifact: string) => {
    try {
      const parent = captureAncestors(brain, artifact, ancestors, effectiveHooks)
      const result = inspectFinalFile(parent, artifact, effectiveHooks)
      retainEntry(resolve(parent.canonicalPath, artifact.split('/').at(-1) ?? ''), result.observation.metadata)
      return result
    } catch (error) {
      if (error instanceof ArtifactInvalidError) {
        const result = Object.freeze({
          error,
          evidence: error.evidence,
          kind: 'invalid' as const,
          path: artifact,
        })
        retainEntry(error.evidence.path, error.evidence.entryMetadata)
        return result
      }
      throw error
    }
  }
  const uniqueResults = new Map([...new Set(artifacts)].map(path => [path, inspectArtifact(path)]))
  const directories = [...ancestors.values()].filter(
    (value): value is ArtifactDirectory => !(value instanceof ArtifactInvalidError),
  )
  const closingDirectories = directories.toReversed()
  const assertCurrent = () => {
    ;(hooks.fault ?? artifactInspectionTestHooks.fault)?.('before-closing-revalidation', '')
    revalidateDirectories(directories)
    entries.forEach((metadata, path) => {
      assertEntryCurrent(path, metadata)
    })
    revalidateDirectories(closingDirectories)
  }
  return Object.freeze({
    assertCurrent,
    results: Object.freeze(artifacts.map(path => uniqueResults.get(path) ?? changed())),
  })
}
