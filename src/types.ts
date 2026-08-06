export type JsonPrimitive = null | boolean | number | string

export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue }

export type BrainRecordFile = {
  id: string
  kind: string
  subject: string
  source: string
  createdAt: string
  confidence?: number
  supersedes?: string[]
  artifacts?: string[]
  payload: JsonValue
  searchText?: string
}

export type BrainRecord = BrainRecordFile & {
  path: string
}

export type RootInput = {
  root?: string
}

export type PrepareResult = {
  hydrated: boolean
  recordsIndexed: number
}

export type HydrateResult = {
  recordsIndexed: number
}

export type AddRecordInput = RootInput & {
  id?: string
  kind: string
  subject: string
  source: string
  confidence?: number
  supersedes?: string[]
  artifacts?: string[]
  payload: JsonValue
  searchText?: string
}

export type InitEncephalonInput = RootInput & {
  refreshBaseline?: boolean
  remove?: boolean
}

export type InitEncephalonResult = {
  recordsCreated: BrainRecord[]
  skippedConflicts: Array<{
    kind: string
    subject: string
    activeRecordIds: string[]
  }>
  instructionFiles: Array<{
    file: 'AGENTS.md' | 'CLAUDE.md'
    action: 'removed' | 'updated'
  }>
  nextAction: string
}

export type ValidationIssue = {
  code: string
  message: string
  path?: string
  recordId?: string
}

export type ValidateResult = {
  valid: boolean
  recordsChecked: number
  errors: ValidationIssue[]
}

export type ListRecordsInput = RootInput & {
  kind?: string
  subject?: string
  includeSuperseded?: boolean
  limit?: number
}

export type ShowRecordInput = RootInput & {
  id: string
  activeOnly?: boolean
}

export type SearchRecordsInput = RootInput & {
  query: string
  kind?: string
  includeSuperseded?: boolean
  limit?: number
}

export type CompactBrainRecord = {
  id: string
  kind: string
  subject: string
  path: string
  summary: string | null
  rank: number
  snippet: string
}

export type GatherInput = RootInput & {
  searches?: string[]
  shows?: string[]
  kind?: string
  includeSuperseded?: boolean
  limit?: number
  hydrate?: boolean
}

export type GatherResult = {
  hydrated: HydrateResult | null
  searches: Array<{
    query: string
    kind: string | null
    results: CompactBrainRecord[]
  }>
  records: Array<{ id: string; record: BrainRecord | null }>
}

export type EncephalonErrorCode =
  | 'UNSUPPORTED_RUNTIME'
  | 'REPOSITORY_NOT_FOUND'
  | 'INVALID_REPOSITORY'
  | 'ROOT_INSTALL_REQUIRED'
  | 'INVALID_ARGUMENT'
  | 'VALIDATION_FAILED'
  | 'RECORD_EXISTS'
  | 'CACHE_BUSY'
  | 'CACHE_SCOPE_MISMATCH'
  | 'REPOSITORY_CHANGED'
  | 'IO_ERROR'
  | 'INTERNAL_ERROR'
