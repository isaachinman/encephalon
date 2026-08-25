import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { win32 } from 'node:path'

type NpmCommandOptions = {
  commandInterpreter?: string
  environment?: NodeJS.ProcessEnv
  nodeExecutable?: string
  npmExecPath?: string
  pathExists?: (path: string) => boolean
  platform?: NodeJS.Platform
}

export type NpmCommand = {
  arguments: string[]
  environment?: NodeJS.ProcessEnv
  executable: string
  windowsVerbatimArguments?: boolean
}

type NpmSpawnOptions = NpmCommandOptions & {
  cwd: string
}

const NPM_COMMAND_ENVIRONMENT_KEY = 'ENCEPHALON_NPM_COMMAND'
const npmArgumentEnvironmentKey = (index: number) => `ENCEPHALON_NPM_ARGUMENT_${index}`

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

const environmentValue = (environment: NodeJS.ProcessEnv, expectedKey: string) =>
  environment[expectedKey] ??
  Object.entries(environment).find(([key]) => key.toLowerCase() === expectedKey.toLowerCase())?.[1]

const batchEnvironment = (values: readonly string[], environment: NodeJS.ProcessEnv) => {
  const keys = [NPM_COMMAND_ENVIRONMENT_KEY, ...values.slice(1).map((_, index) => npmArgumentEnvironmentKey(index))]
  if (values.some(value => /[\0\r\n"]/u.test(value))) {
    throw new Error('Unsafe Windows npm.cmd argument: values must not contain quotes or line breaks.')
  }
  const reservedKeys = new Set(keys.map(key => key.toLowerCase()))
  const inheritedEntries = Object.entries(environment).filter(([key]) => !reservedKeys.has(key.toLowerCase()))
  return Object.fromEntries([...inheritedEntries, ...keys.map((key, index) => [key, values[index]])])
}

const batchCommandLine = (argumentCount: number) => {
  const keys = [
    NPM_COMMAND_ENVIRONMENT_KEY,
    ...Array.from({ length: argumentCount }, (_, index) => npmArgumentEnvironmentKey(index)),
  ]
  return `"${keys.map(key => `"%${key}%"`).join(' ')}"`
}

export const npmCommand = (arguments_: readonly string[], options: NpmCommandOptions = {}): NpmCommand => {
  const platform = options.platform ?? process.platform
  const nodeExecutable = options.nodeExecutable ?? process.execPath
  if (platform === 'win32') {
    const pathExists = options.pathExists ?? existsSync
    const bundledNpmCli = win32.resolve(win32.dirname(nodeExecutable), 'node_modules', 'npm', 'bin', 'npm-cli.js')
    if (pathExists(bundledNpmCli)) {
      return { arguments: [bundledNpmCli, ...arguments_], executable: nodeExecutable }
    }

    const npmExecPath = options.npmExecPath ?? process.env.npm_execpath
    if (npmExecPath !== undefined && isCanonicalNpmCliPath(npmExecPath) && pathExists(npmExecPath)) {
      return { arguments: [npmExecPath, ...arguments_], executable: nodeExecutable }
    }

    const siblingNpmExecutable = win32.resolve(win32.dirname(nodeExecutable), 'npm.exe')
    if (pathExists(siblingNpmExecutable)) {
      return { arguments: [...arguments_], executable: siblingNpmExecutable }
    }

    const siblingNpmBatch = win32.resolve(win32.dirname(nodeExecutable), 'npm.cmd')
    if (pathExists(siblingNpmBatch)) {
      const environment = options.environment ?? process.env
      const commandInterpreter = options.commandInterpreter ?? environmentValue(environment, 'ComSpec')
      if (
        commandInterpreter !== undefined &&
        win32.isAbsolute(commandInterpreter) &&
        win32.basename(commandInterpreter).toLowerCase() === 'cmd.exe' &&
        pathExists(commandInterpreter)
      ) {
        return {
          arguments: ['/d', '/s', '/v:off', '/c', batchCommandLine(arguments_.length)],
          environment: batchEnvironment([siblingNpmBatch, ...arguments_], environment),
          executable: commandInterpreter,
          windowsVerbatimArguments: true,
        }
      }
      throw new Error('Unable to resolve an absolute Windows cmd.exe through ComSpec for the active Node runtime.')
    }
    throw new Error(
      'Unable to resolve npm for the active Windows Node runtime. Install npm beside node.exe or run this check through npm.',
    )
  }
  return { arguments: [...arguments_], executable: 'npm' }
}

export const spawnNpmCommand = (arguments_: readonly string[], options: NpmSpawnOptions) => {
  const command = npmCommand(arguments_, options)
  return spawnSync(command.executable, command.arguments, {
    cwd: options.cwd,
    encoding: 'utf8',
    env: command.environment,
    shell: false,
    windowsVerbatimArguments: command.windowsVerbatimArguments,
  })
}
