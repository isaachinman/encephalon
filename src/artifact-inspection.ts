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

export type ArtifactInspectionResult =
  | Readonly<{ error: ArtifactInvalidError; kind: 'invalid'; path: string }>
  | Readonly<{ kind: 'stable'; observation: ArtifactObservation }>

type StableArtifactInspection = Extract<ArtifactInspectionResult, { kind: 'stable' }>

export class ArtifactInvalidError extends Error {
  constructor(message = 'Artifact must be an existing regular non-symlink file.') {
    super(message)
    this.name = 'ArtifactInvalidError'
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

const changed = (): never => {
  throw new ArtifactChangedError()
}

const invalid = (): never => {
  throw new ArtifactInvalidError()
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
  parent: DirectoryWitness,
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
      return invalid()
    }
    hooks.fault?.('after-ancestor-lstat', artifact)
    const witness = captureDirectoryWitness(path, { allowLink: false })
    hooks.fault?.('after-ancestor-capture', artifact)
    if (
      witness.canonicalPath !== resolve(parent.canonicalPath, segment) ||
      !sameStableEntryMetadata(metadata, witness.pathMetadata)
    ) {
      return changed()
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
        return invalid()
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
        return [...directories, captureAncestor(parent, segment, artifact, hooks)]
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
    return invalid()
  }
  const path = resolve(parent.canonicalPath, name)
  let pathMetadata: BigIntStats
  try {
    pathMetadata = lstatSync(path, { bigint: true })
  } catch (error) {
    if (isReplacementError(error)) {
      revalidateDirectories(directories)
      return invalid()
    }
    throw error
  }
  if (!pathMetadata.isFile() || pathMetadata.isSymbolicLink()) {
    revalidateDirectories(directories)
    return invalid()
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
    const immutableMetadata = Object.freeze(finalMetadata)
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
      return Object.freeze(
        artifacts.map(path => Object.freeze({ error: new ArtifactInvalidError(), kind: 'invalid' as const, path })),
      )
    }
    throw error
  }
  if (!brainMetadata.isDirectory() || brainMetadata.isSymbolicLink()) {
    return Object.freeze(
      artifacts.map(path => Object.freeze({ error: new ArtifactInvalidError(), kind: 'invalid' as const, path })),
    )
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
  const results = artifacts.map(artifact => {
    try {
      return inspectFinalFile(captureAncestors(brain, artifact, effectiveHooks), artifact, effectiveHooks)
    } catch (error) {
      if (error instanceof ArtifactInvalidError) {
        return Object.freeze({ error, kind: 'invalid' as const, path: artifact })
      }
      throw error
    }
  })
  revalidateDirectories([brain])
  return Object.freeze(results)
}
