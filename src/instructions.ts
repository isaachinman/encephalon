import {
  closeSync,
  constants,
  fstatSync,
  ftruncateSync,
  lstatSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
  writeSync,
} from "node:fs"
import { resolve } from "node:path"
import { EncephalonError, fail, wrapIo } from "./errors.ts"

const FILENAMES = ["AGENTS.md", "CLAUDE.md"] as const
const MARKER_PREFIX = "encephalon:managed-instructions:"
const START_PREFIX = "<!-- encephalon:managed-instructions:start "
const END_MARKER = "<!-- encephalon:managed-instructions:end -->"
const SKILL_PATH = "./node_modules/encephalon/skills/encephalon/SKILL.md"

type BlockMetadata = {
  formatVersion: 1
  originalFileExisted: boolean
  separatorBase64: string
  lineEnding: "LF" | "CRLF"
}

type FilePlan = {
  filename: (typeof FILENAMES)[number]
  action: "delete" | "none" | "write"
  content?: string
  originalContent: string
  originalFileExisted: boolean
}

const ALLOWED_SEPARATORS = new Set(["", "\n", "\n\n", "\r\n", "\r\n\r\n"])

const lstatIfExists = (path: string) => {
  try {
    return lstatSync(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
    throw error
  }
}

const encodeMetadata = (metadata: BlockMetadata) =>
  Buffer.from(JSON.stringify(metadata), "utf8").toString("base64url")

const decodeMetadata = (encoded: string): BlockMetadata => {
  try {
    const value = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as Partial<BlockMetadata>
    if (
      value.formatVersion === 1 &&
      typeof value.originalFileExisted === "boolean" &&
      typeof value.separatorBase64 === "string" &&
      (value.lineEnding === "LF" || value.lineEnding === "CRLF")
    ) {
      return value as BlockMetadata
    }
  } catch {
    // The stable validation error below deliberately omits parser internals.
  }
  return fail("VALIDATION_FAILED", "An Encephalon instruction block contains invalid metadata.")
}

const lineEndingFor = (content: string) => content.includes("\r\n") ? "\r\n" : "\n"

const blockFor = (metadata: BlockMetadata) => {
  const lineEnding = metadata.lineEnding === "CRLF" ? "\r\n" : "\n"
  return [
    `${START_PREFIX}${encodeMetadata(metadata)} -->`,
    "## Encephalon",
    "Read and follow the repository-memory skill before making repository assumptions or recording durable knowledge:",
    SKILL_PATH,
    END_MARKER,
    "",
  ].join(lineEnding)
}

const occurrences = (content: string, needle: string) => {
  const positions: number[] = []
  let offset = 0
  while (offset <= content.length) {
    const index = content.indexOf(needle, offset)
    if (index === -1) break
    positions.push(index)
    offset = index + needle.length
  }
  return positions
}

const inspectBlock = (content: string) => {
  const starts = occurrences(content, START_PREFIX)
  const ends = occurrences(content, END_MARKER)
  const markers = occurrences(content, MARKER_PREFIX)
  if (starts.length === 0 && ends.length === 0 && markers.length === 0) return undefined
  if (starts.length !== 1 || ends.length !== 1 || markers.length !== 2 || starts[0] === undefined || ends[0] === undefined || starts[0] >= ends[0]) {
    return fail("VALIDATION_FAILED", "An instruction file contains malformed, nested, duplicate, or unmatched Encephalon markers.")
  }
  const start = starts[0]
  const startEnd = content.indexOf(" -->", start + START_PREFIX.length)
  if (startEnd === -1 || startEnd > ends[0]) {
    return fail("VALIDATION_FAILED", "An Encephalon instruction block has a malformed opening marker.")
  }
  const encoded = content.slice(start + START_PREFIX.length, startEnd)
  const metadata = decodeMetadata(encoded)
  const expected = blockFor(metadata)
  if (content.slice(start, start + expected.length) !== expected) {
    return fail("VALIDATION_FAILED", "An Encephalon instruction block was modified and cannot be managed safely.")
  }
  const separator = Buffer.from(metadata.separatorBase64, "base64").toString("utf8")
  if (
    !ALLOWED_SEPARATORS.has(separator) ||
    Buffer.from(separator, "utf8").toString("base64") !== metadata.separatorBase64
  ) {
    return fail("VALIDATION_FAILED", "An Encephalon instruction block contains invalid separator metadata.")
  }
  if (start < separator.length || content.slice(start - separator.length, start) !== separator) {
    return fail("VALIDATION_FAILED", "An Encephalon instruction block separator does not match its metadata.")
  }
  return { start, end: start + expected.length, separator, metadata }
}

const additionPlan = (root: string, filename: (typeof FILENAMES)[number]): FilePlan => {
  const path = resolve(root, filename)
  const existingMetadata = lstatIfExists(path)
  const existed = existingMetadata !== undefined
  if (existingMetadata !== undefined) {
    const metadata = existingMetadata
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      return fail("VALIDATION_FAILED", `${filename} must be a regular non-symlink file.`)
    }
  }
  const content = existed ? readFileSync(path, "utf8") : ""
  if (content.includes("\0")) return fail("VALIDATION_FAILED", `${filename} contains a NUL byte.`)
  const installed = inspectBlock(content)
  if (installed !== undefined) return { filename, action: "none", originalContent: content, originalFileExisted: existed }
  const lineEnding = lineEndingFor(content)
  const separator = content.length === 0 ? "" : content.endsWith(lineEnding) ? lineEnding : `${lineEnding}${lineEnding}`
  const metadata: BlockMetadata = {
    formatVersion: 1,
    originalFileExisted: existed,
    separatorBase64: Buffer.from(separator, "utf8").toString("base64"),
    lineEnding: lineEnding === "\r\n" ? "CRLF" : "LF",
  }
  return { filename, action: "write", content: `${content}${separator}${blockFor(metadata)}`, originalContent: content, originalFileExisted: existed }
}

const removalPlan = (root: string, filename: (typeof FILENAMES)[number]): FilePlan => {
  const path = resolve(root, filename)
  const fileMetadata = lstatIfExists(path)
  if (fileMetadata === undefined) return { filename, action: "none", originalContent: "", originalFileExisted: false }
  if (!fileMetadata.isFile() || fileMetadata.isSymbolicLink()) {
    return fail("VALIDATION_FAILED", `${filename} must be a regular non-symlink file.`)
  }
  const content = readFileSync(path, "utf8")
  if (content.includes("\0")) return fail("VALIDATION_FAILED", `${filename} contains a NUL byte.`)
  const installed = inspectBlock(content)
  if (installed === undefined) return { filename, action: "none", originalContent: content, originalFileExisted: true }
  const contentWithoutBlock = `${content.slice(0, installed.start - installed.separator.length)}${content.slice(installed.end)}`
  if (!installed.metadata.originalFileExisted && contentWithoutBlock.length === 0) {
    return { filename, action: "delete", originalContent: content, originalFileExisted: true }
  }
  return { filename, action: "write", content: contentWithoutBlock, originalContent: content, originalFileExisted: true }
}

const noFollowFlag = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0

const readRegularFile = (path: string) => {
  const descriptor = openSync(path, constants.O_RDONLY | noFollowFlag)
  try {
    if (!fstatSync(descriptor).isFile()) {
      return fail("VALIDATION_FAILED", "Managed instruction paths must remain regular files.")
    }
    return readFileSync(descriptor, "utf8")
  } finally {
    closeSync(descriptor)
  }
}

const assertPlanIsCurrent = (root: string, plan: FilePlan) => {
  const path = resolve(root, plan.filename)
  const metadata = lstatIfExists(path)
  const exists = metadata !== undefined
  if (exists !== plan.originalFileExisted) {
    return fail("REPOSITORY_CHANGED", `${plan.filename} changed after it was preflighted.`)
  }
  if (metadata?.isSymbolicLink() === true || (metadata !== undefined && !metadata.isFile())) {
    return fail("VALIDATION_FAILED", `${plan.filename} must remain a regular non-symlink file.`)
  }
  if (exists && readRegularFile(path) !== plan.originalContent) {
    return fail("REPOSITORY_CHANGED", `${plan.filename} changed after it was preflighted.`)
  }
}

const writePlan = (path: string, plan: FilePlan) => {
  const content = plan.content ?? ""
  if (!plan.originalFileExisted) {
    try {
      writeFileSync(path, content, { encoding: "utf8", flag: "wx" })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        return fail("REPOSITORY_CHANGED", `${plan.filename} changed after it was preflighted.`)
      }
      throw error
    }
    return
  }
  const descriptor = openSync(path, constants.O_RDWR | noFollowFlag)
  try {
    if (!fstatSync(descriptor).isFile() || readFileSync(descriptor, "utf8") !== plan.originalContent) {
      return fail("REPOSITORY_CHANGED", `${plan.filename} changed after it was preflighted.`)
    }
    const bytes = Buffer.from(content, "utf8")
    ftruncateSync(descriptor, 0)
    let offset = 0
    while (offset < bytes.length) {
      const written = writeSync(descriptor, bytes, offset, bytes.length - offset, offset)
      if (written <= 0) throw new Error(`Unable to write ${plan.filename}.`)
      offset += written
    }
  } finally {
    closeSync(descriptor)
  }
}

export const planInstructionChanges = (root: string, remove: boolean) => {
  try {
    return FILENAMES.map((filename) => remove ? removalPlan(root, filename) : additionPlan(root, filename))
  } catch (error) {
    if (error instanceof EncephalonError) throw error
    return wrapIo("Unable to preflight repository instruction files.", error)
  }
}

export const applyInstructionChanges = (root: string, plans: FilePlan[]) => {
  try {
    plans.filter((plan) => plan.action !== "none").forEach((plan) => assertPlanIsCurrent(root, plan))
    plans.forEach((plan) => {
      const path = resolve(root, plan.filename)
      if (plan.action === "delete") rmSync(path)
      if (plan.action === "write") writePlan(path, plan)
    })
    return plans.filter((plan) => plan.action !== "none").map((plan) => ({
      file: plan.filename,
      action: plan.action === "delete" ? "removed" as const : "updated" as const,
    }))
  } catch (error) {
    if (error instanceof EncephalonError) throw error
    return wrapIo("Unable to update repository instruction files.", error)
  }
}
