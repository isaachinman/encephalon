declare const Bun: {
  build: (input: {
    entrypoints: string[]
    format: 'esm'
    minify: boolean
    naming: string
    outdir: string
    sourcemap: 'none'
    splitting: boolean
    target: 'node'
  }) => Promise<{
    logs: unknown[]
    success: boolean
  }>
  spawnSync: (input: { cmd: string[]; cwd: string; stderr: 'inherit' | 'pipe'; stdout: 'inherit' | 'pipe' }) => {
    exitCode: number | null
    stderr: Buffer
    stdout: Buffer
  }
}
