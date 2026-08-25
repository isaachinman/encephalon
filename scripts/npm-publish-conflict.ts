type NpmJsonError = {
  code?: unknown
  summary?: unknown
}

const conflictSummary = /^You cannot publish over the previously published versions(?::|\b)/
const conflictCodes = new Set(['EPUBLISHCONFLICT', 'E403'])

const readNpmJsonError = (text: string): NpmJsonError | undefined => {
  try {
    const payload = JSON.parse(text) as { error?: NpmJsonError }
    if (payload.error !== undefined && typeof payload.error === 'object' && payload.error !== null) {
      return payload.error
    }
  } catch {
    // npm may emit non-JSON diagnostics alongside --json; ignore parse failures.
  }
}

const isPublishConflictError = (error: NpmJsonError): boolean => {
  const summary = typeof error.summary === 'string' ? error.summary : undefined
  const code = typeof error.code === 'string' ? error.code : undefined
  const hasConflictSummary = summary !== undefined && conflictSummary.test(summary)
  const hasConflictCode = code !== undefined && conflictCodes.has(code)
  return hasConflictSummary && (hasConflictCode || code === undefined)
}

export const isPublishedVersionConflictOutput = (stdout: string, stderr: string): boolean => {
  const jsonErrors = [stdout, stderr]
    .map(readNpmJsonError)
    .filter((error): error is NpmJsonError => error !== undefined)
  const combined = `${stdout}\n${stderr}`
  const hasTextConflictCode = /(?:^|\r?\n)npm error code (EPUBLISHCONFLICT|E403)(?:\r?\n|$)/.test(combined)
  const hasTextConflictMessage = /You cannot publish over the previously published versions/.test(combined)
  return jsonErrors.some(isPublishConflictError) || (hasTextConflictCode && hasTextConflictMessage)
}
