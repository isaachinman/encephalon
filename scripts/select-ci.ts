import { execFileSync } from 'node:child_process'
import { appendFileSync, readFileSync } from 'node:fs'
import { selectCiChecks } from './ci-selection.ts'

const eventName = process.env.GITHUB_EVENT_NAME ?? ''
const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH ?? '', 'utf8')) as {
  before?: string
  pull_request?: { base: { sha: string }; head: { sha: string }; labels: { name: string }[] }
}
const git = (args: string[]) => execFileSync('git', args, { encoding: 'utf8', timeout: 10_000 })
const pullRequest = event.pull_request
const head = pullRequest === undefined ? (process.env.GITHUB_SHA ?? '') : pullRequest.head.sha
const base = pullRequest === undefined ? (event.before ?? git(['rev-parse', 'HEAD^']).trim()) : pullRequest.base.sha
if (!(/^[a-f0-9]{40}$/.test(head) && /^[a-f0-9]{40}$/.test(base)) || git(['rev-parse', 'HEAD']).trim() !== head) {
  throw new Error('CI requires full base and candidate commit identities matching the checkout.')
}
const paths = git(['diff', '--name-only', '--no-renames', '-z', base, head]).split('\0').filter(Boolean)
const labels = pullRequest === undefined ? [] : pullRequest.labels.map(label => label.name)
const selected = selectCiChecks({ event: eventName, labels, paths })
const allPlatforms = ['workflow_dispatch', 'schedule'].includes(eventName) || labels.includes('release')
const changedTests = (allPlatforms ? git(['ls-files', '-z']).split('\0') : paths).filter(path =>
  path.endsWith('.test.ts'),
)
const outputs = { base, head, ...selected, changedTests: JSON.stringify(changedTests) }
appendFileSync(
  process.env.GITHUB_OUTPUT ?? '',
  Object.entries(outputs)
    .map(([key, value]) => `${key}=${value}\n`)
    .join(''),
)
process.stdout.write(`${JSON.stringify({ ...outputs, paths })}\n`)
