import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { createOwnedStagingName, MAX_STAGING_DIRECTORY_ENTRIES, parseOwnedStagingName } from '../src/staging.ts'

describe('owned staging names', () => {
  test('accepts only the exact writer filename grammar and fixes the recovery bound', () => {
    assert.equal(MAX_STAGING_DIRECTORY_ENTRIES, 1000)
    assert.deepEqual(parseOwnedStagingName('record-123-550e8400-e29b-41d4-a716-446655440000.tmp'), {
      pid: 123,
      uuid: '550e8400-e29b-41d4-a716-446655440000',
    })
    assert.deepEqual(parseOwnedStagingName('record-9007199254740991-550e8400-e29b-41d4-a716-446655440000.tmp'), {
      pid: Number.MAX_SAFE_INTEGER,
      uuid: '550e8400-e29b-41d4-a716-446655440000',
    })

    for (const name of [
      'record-0-550e8400-e29b-41d4-a716-446655440000.tmp',
      'record-0123-550e8400-e29b-41d4-a716-446655440000.tmp',
      'record-123-550E8400-e29b-41d4-a716-446655440000.tmp',
      'record-123-550e8400-e29b-51d4-a716-446655440000.tmp',
      'record-123-550e8400-e29b-41d4-7716-446655440000.tmp',
      'record-123-550e8400-e29b-41d4-a716-446655440000.tmp.extra',
      '../record-123-550e8400-e29b-41d4-a716-446655440000.tmp',
      'record-9007199254740992-550e8400-e29b-41d4-a716-446655440000.tmp',
      'record-999999999999999999999999999999-550e8400-e29b-41d4-a716-446655440000.tmp',
    ]) {
      assert.equal(parseOwnedStagingName(name), undefined, name)
    }
  })

  test('creates the exact owned filename consumed by the parser', () => {
    assert.equal(
      createOwnedStagingName(123, '550e8400-e29b-41d4-a716-446655440000'),
      'record-123-550e8400-e29b-41d4-a716-446655440000.tmp',
    )
  })
})
