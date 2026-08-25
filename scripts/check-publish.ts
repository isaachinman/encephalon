import { spawnSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const npmArguments = ['publish', '--dry-run', '--ignore-scripts', '--access', 'public', '--json']
const usesWindowsNpm = process.platform === 'win32'
const executable = usesWindowsNpm ? (process.env.ComSpec ?? 'cmd.exe') : 'npm'
const arguments_ = usesWindowsNpm ? ['/d', '/s', '/c', 'npm.cmd', ...npmArguments] : npmArguments

const result = spawnSync(executable, arguments_, {
  cwd: root,
  encoding: 'utf8',
})
if (result.error !== undefined) {
  throw result.error
}
const exitCode = result.status ?? 1
const stdout = result.stdout ?? ''
const stderr = result.stderr ?? ''

process.stdout.write(stdout)
process.stderr.write(stderr)

if (exitCode === 0) {
  process.exit(0)
}

type NpmJsonError = {
  code?: unknown
  summary?: unknown
}

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

const conflictSummary = /^You cannot publish over the previously published versions(?::|\b)/
const conflictCodes = new Set(['EPUBLISHCONFLICT', 'E403'])

const isPublishConflictError = (error: NpmJsonError): boolean => {
  const summary = typeof error.summary === 'string' ? error.summary : undefined
  const code = typeof error.code === 'string' ? error.code : undefined
  const hasConflictSummary = summary !== undefined && conflictSummary.test(summary)
  const hasConflictCode = code !== undefined && conflictCodes.has(code)
  return hasConflictSummary && (hasConflictCode || code === undefined)
}

const jsonErrors = [stdout, stderr].map(readNpmJsonError).filter((error): error is NpmJsonError => error !== undefined)
const combined = `${stdout}\n${stderr}`
const hasTextConflictCode = /(?:^|\n)npm error code (EPUBLISHCONFLICT|E403)(?:\n|$)/.test(combined)
const hasTextConflictMessage = /You cannot publish over the previously published versions/.test(combined)

if (jsonErrors.some(isPublishConflictError) || (hasTextConflictCode && hasTextConflictMessage)) {
  process.exit(0)
}

throw new Error(`npm publish dry-run failed with exit code ${exitCode}.`)
