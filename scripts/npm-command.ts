import { existsSync } from 'node:fs'
import { win32 } from 'node:path'

type NpmCommandOptions = {
  nodeExecutable?: string
  npmExecPath?: string
  pathExists?: (path: string) => boolean
  platform?: NodeJS.Platform
}

const isCanonicalNpmCliPath = (path: string) => {
  const binDirectory = win32.dirname(path)
  const npmDirectory = win32.dirname(binDirectory)
  const nodeModulesDirectory = win32.dirname(npmDirectory)
  return (
    win32.isAbsolute(path) &&
    win32.basename(path).toLowerCase() === 'npm-cli.js' &&
    win32.basename(binDirectory).toLowerCase() === 'bin' &&
    win32.basename(npmDirectory).toLowerCase() === 'npm' &&
    win32.basename(nodeModulesDirectory).toLowerCase() === 'node_modules'
  )
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

    const npmExecPath = options.npmExecPath ?? process.env.npm_execpath
    if (npmExecPath !== undefined && isCanonicalNpmCliPath(npmExecPath) && pathExists(npmExecPath)) {
      return [nodeExecutable, npmExecPath, ...arguments_]
    }

    const siblingNpmExecutable = win32.resolve(win32.dirname(nodeExecutable), 'npm.exe')
    if (pathExists(siblingNpmExecutable)) {
      return [siblingNpmExecutable, ...arguments_]
    }
    throw new Error(
      'Unable to resolve npm for the active Windows Node runtime. Install npm beside node.exe or run this check through npm.',
    )
  }
  return ['npm', ...arguments_]
}
