type NpmJsonError = {
  code?: unknown
  summary?: unknown
}

type NpmDiagnosticScan = {
  errors: NpmJsonError[]
  hasInvalidJson: boolean
  text: string
}

const conflictSummary = /^You cannot publish over the previously published versions(?::|\b)/
const conflictCodes = new Set(['EPUBLISHCONFLICT', 'E403'])
const jsonCandidateLimit = 16
const jsonCandidateLengthLimit = 64 * 1024

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const scanNpmDiagnostics = (rawText: string): NpmDiagnosticScan => {
  const text = rawText.replaceAll('\r\n', '\n').replaceAll('\r', '\n')
  const maskedText = text.split('')
  const errors: NpmJsonError[] = []
  let hasInvalidJson = false
  let candidateCount = 0
  let searchIndex = 0

  while (searchIndex < text.length && !hasInvalidJson) {
    const start = text.indexOf('{', searchIndex)
    if (start === -1) {
      searchIndex = text.length
    } else {
      const lineStart = text.lastIndexOf('\n', start - 1) + 1
      const startsJsonLine = /^[\t ]*$/.test(text.slice(lineStart, start))
      const followsJsonCandidate = candidateCount > 0 && /^[\t ]*$/.test(text.slice(searchIndex, start))
      if (startsJsonLine || followsJsonCandidate) {
        candidateCount += 1
        let cursor = start
        let depth = 0
        let end: number | undefined
        let escaped = false
        let inString = false

        while (cursor < text.length && cursor - start < jsonCandidateLengthLimit && end === undefined) {
          const character = text[cursor]
          if (inString) {
            if (escaped) {
              escaped = false
            } else if (character === '\\') {
              escaped = true
            } else if (character === '"') {
              inString = false
            }
          } else if (character === '"') {
            inString = true
          } else if (character === '{') {
            depth += 1
          } else if (character === '}') {
            depth -= 1
            if (depth === 0) {
              end = cursor + 1
            }
          }
          cursor += 1
        }

        if (candidateCount > jsonCandidateLimit || end === undefined) {
          hasInvalidJson = true
        } else {
          try {
            const payload = JSON.parse(text.slice(start, end)) as unknown
            if (isObject(payload) && isObject(payload.error)) {
              errors.push(payload.error)
            } else {
              hasInvalidJson = true
            }
          } catch {
            hasInvalidJson = true
          }

          if (!hasInvalidJson) {
            for (let index = start; index < end; index += 1) {
              if (maskedText[index] !== '\n') {
                maskedText[index] = ' '
              }
            }
            searchIndex = end
          }
        }
      } else {
        hasInvalidJson = true
      }
    }
  }

  return { errors, hasInvalidJson, text: maskedText.join('') }
}

const isPublishConflictError = (error: NpmJsonError): boolean => {
  const summary = typeof error.summary === 'string' ? error.summary : undefined
  const code = typeof error.code === 'string' ? error.code : undefined
  const hasConflictSummary = summary !== undefined && conflictSummary.test(summary)
  const hasConflictCode = code !== undefined && conflictCodes.has(code)
  return hasConflictSummary && (hasConflictCode || code === undefined)
}

const npmErrorLine = /^(?:npm error|npm ERR!)(?:\s|$)/
const npmErrorCodeLine = /^(?:npm error|npm ERR!)\s+code\s+(\S+)$/
const npmConflictLine = /^(?:npm error|npm ERR!)\s+You cannot publish over the previously published versions(?::|\b)/
const npmLogLine = /^(?:npm error|npm ERR!)\s+A complete log of this run can be found in:/
const explicitFailureLine = /^(?:error|fatal)(?::|\s|$)/i

export const isPublishedVersionConflictOutput = (stdout: string, stderr: string): boolean => {
  const scans = [stdout, stderr].map(scanNpmDiagnostics)
  const errors = scans.flatMap(scan => scan.errors)
  const text = scans.map(scan => scan.text).join('\n')
  const lines = text
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.length > 0)
  const textErrorCodes = lines
    .map(line => npmErrorCodeLine.exec(line)?.[1])
    .filter((code): code is string => code !== undefined)
  const hasTextConflictCode = textErrorCodes.some(code => conflictCodes.has(code))
  const hasTextConflictMessage = lines.some(line => conflictSummary.test(line) || npmConflictLine.test(line))
  const hasUnexpectedError = lines.some(line => {
    const code = npmErrorCodeLine.exec(line)?.[1]
    const isConflictCodeLine = code !== undefined && conflictCodes.has(code)
    const isUnexpectedNpmError =
      npmErrorLine.test(line) && !isConflictCodeLine && !npmConflictLine.test(line) && !npmLogLine.test(line)
    return isUnexpectedNpmError || explicitFailureLine.test(line)
  })
  const hasInvalidJson = scans.some(scan => scan.hasInvalidJson)
  const jsonErrorsAreConflicts = errors.every(isPublishConflictError)
  const hasConflictEvidence = errors.length > 0 || (hasTextConflictCode && hasTextConflictMessage)
  return !(hasInvalidJson || hasUnexpectedError) && jsonErrorsAreConflicts && hasConflictEvidence
}
