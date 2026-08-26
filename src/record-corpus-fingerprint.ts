import { createHash, type Hash } from 'node:crypto'
import { ordinalStringCompare } from './order.ts'
import { projectParsedRecordFile } from './schema.ts'
import type { BrainRecord } from './types.ts'

type CanonicalJsonValue =
  | null
  | boolean
  | number
  | string
  | readonly CanonicalJsonValue[]
  | { readonly [key: string]: CanonicalJsonValue }

const RECORD_CORPUS_FINGERPRINT_DOMAIN = 'encephalon.record-corpus-fingerprint\0version=1\0'

const isCanonicalJsonArray = (value: CanonicalJsonValue): value is readonly CanonicalJsonValue[] => Array.isArray(value)

const updateCanonicalJson = (hash: Hash, value: CanonicalJsonValue): void => {
  if (value === null || typeof value !== 'object') {
    hash.update(JSON.stringify(value))
  } else if (isCanonicalJsonArray(value)) {
    hash.update('[')
    value.forEach((entry, index) => {
      if (index > 0) {
        hash.update(',')
      }
      updateCanonicalJson(hash, entry)
    })
    hash.update(']')
  } else {
    hash.update('{')
    Object.keys(value)
      .sort(ordinalStringCompare)
      .forEach((key, index) => {
        if (index > 0) {
          hash.update(',')
        }
        hash.update(JSON.stringify(key))
        hash.update(':')
        updateCanonicalJson(hash, value[key] as CanonicalJsonValue)
      })
    hash.update('}')
  }
}

const compareRecords = (first: BrainRecord, second: BrainRecord) =>
  ordinalStringCompare(first.path, second.path) || ordinalStringCompare(first.id, second.id)

export const recordCorpusFingerprint = (records: readonly BrainRecord[]) => {
  const hash = createHash('sha256')
  const sortedRecords = [...records].sort(compareRecords)
  hash.update(RECORD_CORPUS_FINGERPRINT_DOMAIN)
  hash.update('[')
  sortedRecords.forEach((record, index) => {
    if (index > 0) {
      hash.update(',')
    }
    updateCanonicalJson(hash, {
      ...projectParsedRecordFile(record),
      path: record.path,
    } as CanonicalJsonValue)
  })
  hash.update(']')
  return hash.digest('hex')
}
