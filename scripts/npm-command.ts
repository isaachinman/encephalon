import { win32 } from 'node:path'

type NpmCommandOptions = {
  nodeExecutable?: string
  platform?: NodeJS.Platform
}

export const npmCommand = (arguments_: readonly string[], options: NpmCommandOptions = {}): string[] => {
  const platform = options.platform ?? process.platform
  const nodeExecutable = options.nodeExecutable ?? process.execPath
  if (platform === 'win32') {
    const npmCli = win32.resolve(win32.dirname(nodeExecutable), 'node_modules', 'npm', 'bin', 'npm-cli.js')
    return [nodeExecutable, npmCli, ...arguments_]
  }
  return ['npm', ...arguments_]
}
