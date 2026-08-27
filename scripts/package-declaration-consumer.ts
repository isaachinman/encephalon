export const PACKAGE_DECLARATION_CONSUMER_SOURCE = `import {
  EncephalonError,
  addRecord,
  gatherRecords,
  hydrate,
  initEncephalon,
  listRecords,
  prepare,
  searchCompactRecords,
  searchRecords,
  showRecord,
  validateRecords,
  type AddRecordInput,
  type BrainRecord,
  type BrainRecordFile,
  type CompactBrainRecord,
  type EncephalonErrorCode,
  type GatherInput,
  type GatherResult,
  type HydrateResult,
  type InitEncephalonInput,
  type InitEncephalonResult,
  type JsonPrimitive,
  type JsonValue,
  type ListRecordsInput,
  type PrepareResult,
  type RootInput,
  type SearchRecordsInput,
  type ShowRecordInput,
  type ValidateResult,
  type ValidationIssue,
} from 'encephalon'

const root: RootInput = { root: '/repository' }
const primitive: JsonPrimitive = 'value'
const value: JsonValue = { nested: [primitive, null, true, 1] }
const file: BrainRecordFile = {
  id: 'record',
  kind: 'decision',
  subject: 'declaration.contract',
  source: 'package-check',
  createdAt: '2026-08-27T00:00:00.000Z',
  confidence: 1,
  supersedes: ['predecessor'],
  artifacts: ['README.md'],
  payload: value,
  searchText: 'declaration contract',
}
const record: BrainRecord = { ...file, path: 'encephalon/decision/record.json' }
const compact: CompactBrainRecord = {
  id: record.id,
  kind: record.kind,
  subject: record.subject,
  path: record.path,
  summary: null,
  rank: 1,
  snippet: record.searchText ?? '',
}
const addInput: AddRecordInput = {
  ...root,
  id: file.id,
  kind: file.kind,
  subject: file.subject,
  source: file.source,
  confidence: file.confidence,
  supersedes: file.supersedes,
  artifacts: file.artifacts,
  payload: file.payload,
  searchText: file.searchText,
}
const initInput: InitEncephalonInput = { ...root, refreshBaseline: true, remove: false }
const listInput: ListRecordsInput = {
  ...root,
  kind: file.kind,
  subject: file.subject,
  includeSuperseded: true,
  limit: 1000,
}
const showInput: ShowRecordInput = { ...root, id: file.id, activeOnly: false }
const searchInput: SearchRecordsInput = {
  ...root,
  query: file.subject,
  kind: file.kind,
  includeSuperseded: true,
  limit: 1000,
}
const gatherInput: GatherInput = {
  ...root,
  searches: [file.subject],
  shows: [file.id],
  kind: file.kind,
  includeSuperseded: true,
  limit: 1000,
  hydrate: true,
}

const prepared: PrepareResult = prepare(root)
const hydrated: HydrateResult = hydrate(root)
const added: BrainRecord = addRecord(addInput)
const initialised: InitEncephalonResult = initEncephalon(initInput)
const listed: BrainRecord[] = listRecords(listInput)
const shown: BrainRecord | null = showRecord(showInput)
const searched: BrainRecord[] = searchRecords(searchInput)
const compactSearched: CompactBrainRecord[] = searchCompactRecords(searchInput)
const gathered: GatherResult = gatherRecords(gatherInput)
const validated: ValidateResult = validateRecords(root)
const issue: ValidationIssue = { code: 'CODE', message: 'message', path: record.path, recordId: record.id }
const initInstruction: InitEncephalonResult['instructionFiles'][number] = {
  file: 'AGENTS.md',
  action: 'updated',
}

prepared.hydrated satisfies boolean
prepared.recordsIndexed satisfies number
hydrated.recordsIndexed satisfies number
added.path satisfies string
initialised.recordsCreated satisfies BrainRecord[]
initialised.skippedConflicts[0]?.activeRecordIds satisfies string[] | undefined
initialised.skippedConflicts[0]?.kind satisfies string | undefined
initialised.skippedConflicts[0]?.subject satisfies string | undefined
initialised.instructionFiles satisfies Array<typeof initInstruction>
initialised.nextAction satisfies string
listed[0]?.payload satisfies JsonValue | undefined
shown?.confidence satisfies number | undefined
searched[0]?.artifacts satisfies string[] | undefined
compactSearched[0]?.summary satisfies string | null | undefined
compact.id satisfies string
gathered.hydrated satisfies HydrateResult | null
gathered.searches[0]?.query satisfies string | undefined
gathered.searches[0]?.kind satisfies string | null | undefined
gathered.searches[0]?.results satisfies CompactBrainRecord[] | undefined
gathered.records[0]?.id satisfies string | undefined
gathered.records[0]?.record satisfies BrainRecord | null | undefined
validated.valid satisfies boolean
validated.recordsChecked satisfies number
validated.errors satisfies ValidationIssue[]
validated.truncated satisfies boolean
issue.code satisfies string
issue.message satisfies string
issue.path satisfies string | undefined
issue.recordId satisfies string | undefined

const errorCodes = [
  'UNSUPPORTED_RUNTIME',
  'REPOSITORY_NOT_FOUND',
  'INVALID_REPOSITORY',
  'ROOT_INSTALL_REQUIRED',
  'INVALID_ARGUMENT',
  'VALIDATION_FAILED',
  'RECORD_EXISTS',
  'CACHE_BUSY',
  'CACHE_SCOPE_MISMATCH',
  'REPOSITORY_CHANGED',
  'IO_ERROR',
  'INTERNAL_ERROR',
] as const satisfies readonly EncephalonErrorCode[]
type MissingErrorCode = Exclude<EncephalonErrorCode, (typeof errorCodes)[number]>
type UnexpectedErrorCode = Exclude<(typeof errorCodes)[number], EncephalonErrorCode>
const completeErrorUnion: [MissingErrorCode, UnexpectedErrorCode] extends [never, never] ? true : never = true
const error = new EncephalonError(errorCodes[4], 'message', { issue: value }, { cause: issue })
error.code satisfies EncephalonErrorCode
error.details satisfies Record<string, JsonValue>
error.message satisfies string
error.name satisfies string

export const declarationContract = {
  completeErrorUnion,
  error,
  gathered,
  initialised,
  validated,
}
`
