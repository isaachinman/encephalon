import { fail, failBudget } from './errors.ts'
import { OPERATION_BUDGETS } from './operation-budgets.ts'

const MAX_QUERY_BYTES = OPERATION_BUDGETS.queryBytes.maximum
const MAX_QUERY_TERMS = OPERATION_BUDGETS.queryTerms.maximum
const LITERAL_TERM_PATTERN = /[\p{L}\p{N}](?:[\p{L}\p{N}\p{M}]|_+(?=[\p{L}\p{N}]))*/gu

/** @internal */
export const MAX_NFC_UTF8_EXPANSION_FACTOR = 3

/** @internal */
export const normalizeSearchText = (value: string) => value.normalize('NFC')

/** @internal */
export const literalMatchQuery = (query: unknown) => {
  if (typeof query !== 'string') {
    return fail('INVALID_ARGUMENT', 'query must be a string.', {
      field: 'query',
    })
  }
  if (Buffer.byteLength(query, 'utf8') > MAX_QUERY_BYTES) {
    return failBudget('queryBytes', `query must contain at most ${MAX_QUERY_BYTES} UTF-8 bytes.`)
  }
  const terms = normalizeSearchText(query).match(LITERAL_TERM_PATTERN) ?? []
  if (terms.length > MAX_QUERY_TERMS) {
    return failBudget('queryTerms', `query may contain at most ${MAX_QUERY_TERMS} literal terms.`)
  }
  return terms.map(term => `"${term.replaceAll('"', '""')}"`).join(' AND ')
}
