import { normalizeSearchText } from './search-text.ts'
import type { BrainRecord } from './types.ts'

export const MAX_SEARCH_PREVIEW_BYTES = 1024

export const summaryForRecord = (record: BrainRecord) => {
  if (record.payload !== null && !Array.isArray(record.payload) && typeof record.payload === 'object') {
    const { summary } = record.payload
    if (typeof summary === 'string' && summary.trim().length > 0) {
      return summary.trim()
    }
  }
  return null
}

export const searchDocumentForRecord = (record: BrainRecord, summary: string | null) =>
  normalizeSearchText(
    [record.kind, record.subject, record.source, summary, JSON.stringify(record.payload), record.searchText ?? '']
      .filter((value): value is string => typeof value === 'string' && value.length > 0)
      .join('\n'),
  )

export const searchPreviewForRecord = (record: BrainRecord, summary: string | null) => {
  const preview = normalizeSearchText(
    [record.kind, record.subject, record.source, summary]
      .filter((value): value is string => typeof value === 'string' && value.length > 0)
      .join('\n'),
  )
  const bytes = Buffer.from(preview, 'utf8')
  if (bytes.length > MAX_SEARCH_PREVIEW_BYTES) {
    // A contiguous prefix ending at an ASCII separator cannot split a UTF-8 character or FTS token.
    const prefix = bytes.subarray(0, MAX_SEARCH_PREVIEW_BYTES)
    const separator = Math.max(prefix.lastIndexOf(0x20), prefix.lastIndexOf(0x0a))
    return prefix.subarray(0, separator).toString('utf8')
  }
  return preview
}

/** Cache projections belong to the accepted record and are evaluated only when needed. */
export const recordProjection = (record: BrainRecord) => {
  let text: string | undefined
  let preview: string | undefined
  const summary = summaryForRecord(record)
  return Object.freeze({
    get preview() {
      preview ??= searchPreviewForRecord(record, summary)
      return preview
    },
    summary,
    get text() {
      text ??= searchDocumentForRecord(record, summary)
      return text
    },
  })
}
