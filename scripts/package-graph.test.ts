import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { test } from 'node:test'
import { assertPublicDeclarations, reviewedRuntimePaths } from './package-graph.ts'

test('follows shared and lazy package edges while rejecting missing, escaping and external imports', () => {
  const root = mkdtempSync(resolve(tmpdir(), 'encephalon-package-graph-'))
  try {
    mkdirSync(resolve(root, 'dist'))
    writeFileSync(resolve(root, 'dist/index.mjs'), "export { value } from './shared-abc123.mjs'\n")
    writeFileSync(resolve(root, 'dist/shared-abc123.mjs'), 'export const value = 1\n')
    writeFileSync(resolve(root, 'dist/unused-abc123.mjs'), 'throw new Error("orphan")\n')
    writeFileSync(resolve(root, 'dist/cli.mjs'), "import 'node:util'; await import('./shared-abc123.mjs')\n")
    assert.deepEqual(reviewedRuntimePaths(root), ['dist/cli.mjs', 'dist/index.mjs', 'dist/shared-abc123.mjs'])
    for (const specifier of ['./missing-abc123.mjs', '../outside.mjs', 'external-package']) {
      writeFileSync(resolve(root, 'dist/cli.mjs'), `await import(${JSON.stringify(specifier)})\n`)
      assert.throws(() => reviewedRuntimePaths(root))
    }
  } finally {
    rmSync(root, { force: true, recursive: true })
  }
})

test('requires a standalone declaration facade containing only public root names', () => {
  const root = mkdtempSync(resolve(tmpdir(), 'encephalon-declaration-graph-'))
  try {
    mkdirSync(resolve(root, 'src'))
    mkdirSync(resolve(root, 'dist'))
    writeFileSync(resolve(root, 'src/index.ts'), "export type { Public } from './types.ts'\n")
    const facade = 'type Public = { name: string }; export type { Public };\n'
    writeFileSync(resolve(root, 'dist/index.d.ts'), facade)
    assertPublicDeclarations(root)
    for (const extra of [
      'type Private = string;',
      "type Private = import('./private.js').Private;",
      'declare namespace Private { type State = string; }',
    ]) {
      writeFileSync(resolve(root, 'dist/index.d.ts'), facade + extra)
      assert.throws(() => assertPublicDeclarations(root), /declaration facade/)
    }
    writeFileSync(resolve(root, 'src/index.ts'), "export { Public } from './public.ts'\n")
    const publicClass = 'declare class Public {}\nexport { Public };\n'
    writeFileSync(resolve(root, 'dist/index.d.ts'), publicClass)
    assertPublicDeclarations(root)
    writeFileSync(resolve(root, 'dist/index.d.ts'), publicClass.replace('declare class', 'export default class'))
    assert.throws(() => assertPublicDeclarations(root), /declaration facade/)
  } finally {
    rmSync(root, { force: true, recursive: true })
  }
})
