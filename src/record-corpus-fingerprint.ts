import { createHash } from 'node:crypto'

const RECORD_CORPUS_FINGERPRINT_DOMAIN = 'encephalon.record-corpus-fingerprint\0version=2\0'

/** Entries are already in the verified corpus's ordinal path order. Digests bind exact file bytes. */
export const recordCorpusFingerprint = (entries: Iterable<Readonly<{ path: string; digest: string }>>) => {
  const hash = createHash('sha256')
  hash.update(RECORD_CORPUS_FINGERPRINT_DOMAIN)
  for (const { path, digest } of entries) {
    hash.update(JSON.stringify([path, digest]))
    hash.update('\n')
  }
  return hash.digest('hex')
}
