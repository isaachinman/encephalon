declare const Bun: {
  Transpiler: new (input: { loader: 'ts'; target: 'node' }) => { transformSync: (source: string) => string }
  spawnSync: (input: { cmd: string[]; cwd: string; stderr: 'inherit' | 'pipe'; stdout: 'inherit' | 'pipe' }) => {
    exitCode: number | null
    stderr: Buffer
    stdout: Buffer
  }
}
