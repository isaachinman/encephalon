import assert from 'node:assert/strict'
import { test } from 'node:test'
import { recordCorpusFingerprint } from '../src/record-corpus-fingerprint.ts'

test('fingerprints a versioned, framed stream of exact path and raw digest witnesses', () => {
  const entry = {
    digest: 'a8e2a128a058c227df83b59527a611d6dcbec44e4182c6e254b6af47ee590807',
    path: 'encephalon/decision/one.json',
  }
  assert.equal(recordCorpusFingerprint([entry]), 'c8d1df3d88c3f9dc1c7d1fa2d36a3530ee9d7593d066aeeffa110a7dbab6fe41')
  assert.notEqual(
    recordCorpusFingerprint([{ ...entry, path: 'encephalon/decision/two.json' }]),
    recordCorpusFingerprint([entry]),
  )
  assert.notEqual(recordCorpusFingerprint([{ ...entry, digest: '0'.repeat(64) }]), recordCorpusFingerprint([entry]))
  assert.notEqual(recordCorpusFingerprint([]), recordCorpusFingerprint([entry]))
})
