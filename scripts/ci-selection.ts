export const selectCiChecks = (
  input: Readonly<{ event: string; labels?: readonly string[]; paths: readonly string[] }>,
) => {
  if (['pull_request', 'push', 'workflow_dispatch', 'schedule'].includes(input.event)) {
    const full =
      input.event === 'workflow_dispatch' ||
      input.event === 'schedule' ||
      input.labels?.includes('release') === true ||
      input.paths.length === 0
    const historyTools =
      full ||
      input.paths.some(
        path =>
          ['package.json', 'bun.lock', 'test/package.test.ts', 'test/ci-workflow.test.ts'].includes(path) ||
          path.startsWith('.github/') ||
          (path.startsWith('scripts/') && !path.startsWith('scripts/benchmark')),
      )
    const ordinary = (path: string) =>
      ['README.md', 'LICENSE', 'AGENTS.md', '.gitignore'].includes(path) ||
      path.startsWith('encephalon/') ||
      path.startsWith('test/') ||
      (path.startsWith('docs/') && path !== 'docs/contract.md')
    return {
      compatibility: input.event === 'push' || historyTools || full || input.paths.some(path => !ordinary(path)),
      historyTools,
    }
  }
  throw new Error('Unsupported CI event; historical compatibility selection cannot be determined.')
}
