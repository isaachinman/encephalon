const command = ['npm', 'publish', '--dry-run', '--ignore-scripts', '--access', 'public', '--json']

const result = Bun.spawnSync({
  cmd: command,
  stderr: 'pipe',
  stdout: 'pipe',
})
const stdout = result.stdout.toString()
const stderr = result.stderr.toString()

process.stdout.write(stdout)
process.stderr.write(stderr)

if (result.exitCode === 0) {
  process.exit(0)
}

const output = `${stdout}\n${stderr}`
if (output.includes('You cannot publish over the previously published versions')) {
  process.exit(0)
}

throw new Error(`npm publish dry-run failed with exit code ${result.exitCode}.`)
