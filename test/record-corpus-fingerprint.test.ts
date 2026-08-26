import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { recordCorpusFingerprint } from '../src/record-corpus-fingerprint.ts'
import type { BrainRecord } from '../src/types.ts'

const record = (overrides: Partial<BrainRecord> = {}): BrainRecord => ({
  createdAt: '2026-01-01T00:00:00.000Z',
  id: 'one',
  kind: 'decision',
  path: 'encephalon/decision/one.json',
  payload: Object.fromEntries([
    ['z', 1],
    ['a', 'é'],
  ]),
  source: 'test',
  subject: 'fingerprint.one',
  ...overrides,
})

describe('record corpus fingerprint', () => {
  test('uses the versioned canonical format', () => {
    assert.equal(
      recordCorpusFingerprint([record()]),
      'ebc32274a1eaea17d7a7dc76e4b003c73f829aa56b9eb834590914db0c894022',
    )
  })

  test('orders records by ordinal path then id and recursively orders object keys', () => {
    const reverseOrderedPayload = {
      outer: Object.fromEntries([
        ['z', 1],
        ['a', 2],
      ]),
    }
    const first = record({
      id: 'z',
      path: 'encephalon/decision/shared.json',
      payload: reverseOrderedPayload,
      subject: 'fingerprint.z',
    })
    const second = record({
      id: 'a',
      path: 'encephalon/decision/shared.json',
      payload: reverseOrderedPayload,
      subject: 'fingerprint.a',
    })
    const alternateFirst = { ...first, payload: { outer: { a: 2, z: 1 } } }
    const alternateSecond = { ...second, payload: { outer: { a: 2, z: 1 } } }

    assert.equal(recordCorpusFingerprint([first, second]), recordCorpusFingerprint([alternateSecond, alternateFirst]))
  })

  test('fingerprints the complete projected record including optional-field presence', () => {
    const complete = record({
      artifacts: ['_artifacts/decision/one/evidence.txt'],
      confidence: 0.75,
      searchText: 'fingerprint evidence',
      supersedes: ['earlier'],
    })
    const changedRecords: BrainRecord[] = [
      { ...complete, path: 'encephalon/decision/elsewhere.json' },
      { ...complete, id: 'two' },
      { ...complete, kind: 'architecture' },
      { ...complete, subject: 'fingerprint.changed' },
      { ...complete, source: 'agent' },
      { ...complete, createdAt: '2026-01-01T00:00:00.001Z' },
      { ...complete, payload: { a: 'é', z: 2 } },
      { ...complete, artifacts: ['_artifacts/decision/one/other.txt'] },
      { ...complete, confidence: 0.5 },
      { ...complete, searchText: 'different evidence' },
      { ...complete, supersedes: ['other'] },
      record(),
    ]
    const expected = recordCorpusFingerprint([complete])

    for (const changed of changedRecords) {
      assert.notEqual(recordCorpusFingerprint([changed]), expected)
    }
  })

  test('preserves exact Unicode without normalisation', () => {
    const composed = record({ payload: { text: 'café' } })
    const decomposed = record({ payload: { text: 'cafe\u0301' } })

    assert.notEqual(recordCorpusFingerprint([composed]), recordCorpusFingerprint([decomposed]))
  })
})
