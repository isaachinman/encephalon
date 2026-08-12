import type { BigIntStats } from 'node:fs'

export const sameEntryIdentity = (first: BigIntStats, second: BigIntStats) =>
  first.dev === second.dev && first.ino === second.ino

export const sameStableEntryMetadata = (first: BigIntStats, second: BigIntStats) =>
  sameEntryIdentity(first, second) &&
  first.size === second.size &&
  first.mode === second.mode &&
  first.birthtimeNs === second.birthtimeNs &&
  first.mtimeNs === second.mtimeNs &&
  first.ctimeNs === second.ctimeNs
