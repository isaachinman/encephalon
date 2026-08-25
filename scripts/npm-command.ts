import { existsSync } from 'node:fs'
import { win32 } from 'node:path'

type NpmCommandOptions = {
  nodeExecutable?: string
  pathEnvironment?: string
  pathExists?: (path: string) => boolean
  platform?: NodeJS.Platform
}

export const npmCommand = (arguments_: readonly string[], options: NpmCommandOptions = {}): string[] => {
  const platform = options.platform ?? process.platform
  const nodeExecutable = options.nodeExecutable ?? process.execPath
  if (platform === 'win32') {
    const pathExists = options.pathExists ?? existsSync
    const bundledNpmCli = win32.resolve(win32.dirname(nodeExecutable), 'node_modules', 'npm', 'bin', 'npm-cli.js')
    if (pathExists(bundledNpmCli)) {
      return [nodeExecutable, bundledNpmCli, ...arguments_]
    }

    const pathCommand = (options.pathEnvironment ?? process.env.PATH ?? process.env.Path ?? '')
      .split(win32.delimiter)
      .map(entry => entry.trim())
      .map(entry => (entry.startsWith('"') && entry.endsWith('"') ? entry.slice(1, -1) : entry))
      .filter(entry => entry.length > 0)
      .flatMap(entry => {
        const npmCli = win32.resolve(entry, 'node_modules', 'npm', 'bin', 'npm-cli.js')
        const npmExecutable = win32.resolve(entry, 'npm.exe')
        if (pathExists(npmCli)) {
          return [[nodeExecutable, npmCli, ...arguments_]]
        }
        if (pathExists(npmExecutable)) {
          return [[npmExecutable, ...arguments_]]
        }
        return []
      })
      .at(0)
    if (pathCommand !== undefined) {
      return pathCommand
    }
    throw new Error('Unable to resolve npm for the active Windows Node runtime.')
  }
  return ['npm', ...arguments_]
}
