#!/usr/bin/env node

import { parseArgs } from 'node:util'
import { cliErrorResponse, fail, failBudget } from './errors.ts'
import { PACKAGE_VERSION } from './generated/version.ts'
import {
  addRecord,
  EncephalonError,
  gatherRecords,
  hydrate,
  initEncephalon,
  listRecords,
  prepare,
  searchCompactRecords,
  searchRecords,
  showRecord,
  validateRecords,
} from './index.ts'
import { OPERATION_BUDGETS } from './operation-budgets.ts'
import type { JsonValue } from './types.ts'

const HELP = `Usage: encephalon [--root <path>] <command> [options]

Commands:
  init [--refresh-baseline] [--remove]
  add [--id <id>] --kind <kind> --subject <subject> --source <source> --data <json>
      [--confidence <0..1>] [--text <text>] [--supersedes <id> ...] [--artifact <path> ...]
      Accepts at most ${OPERATION_BUDGETS.supersessionEdges.maximum.toLocaleString('en-GB')} supersession targets.
  prepare
  hydrate
  validate
  list [--kind <kind>] [--subject <subject>] [--include-superseded] [--limit <${OPERATION_BUDGETS.fullResultLimit.minimum}..${OPERATION_BUDGETS.fullResultLimit.maximum}>]
  show --id <id> [--active-only]
  search [--kind <kind>] [--include-superseded] [--limit <${OPERATION_BUDGETS.fullResultLimit.minimum}..${OPERATION_BUDGETS.fullResultLimit.maximum}>] [--] <query>
  search --compact [--kind <kind>] [--include-superseded] [--limit <${OPERATION_BUDGETS.compactResultLimit.minimum}..${OPERATION_BUDGETS.compactResultLimit.maximum}>] [--] <query>
  gather [--search <query> ...] [--show <id> ...] [--hydrate] [--include-superseded]
         [--kind <kind>] [--limit <${OPERATION_BUDGETS.compactResultLimit.minimum}..${OPERATION_BUDGETS.compactResultLimit.maximum}>]
         Accepts at most ${OPERATION_BUDGETS.gatherSearches.maximum} searches and ${OPERATION_BUDGETS.gatherShows.maximum} shows.

Global options:
  --root <path>   Use this exact Git repository root.
  --help, -h      Show help when this is the only remaining argv token (not per-command).
  --version, -v   Show the package version when this is the only remaining argv token.
  Values that start with '-' must use --name=value (for example --subject=-draft).
`

type ParsedOptions = {
  values: Map<string, string[]>
  flags: Set<string>
  positionals: string[]
}

type CommandResult = {
  value: unknown
  exitCode?: number
  format?: 'json' | 'text'
}

type RepeatedOptionBudget = {
  budgetKey: 'gatherSearches' | 'gatherShows' | 'supersessionEdges'
  message: (maximum: number) => string
  option: 'search' | 'show' | 'supersedes'
}

const REPEATED_OPTION_BUDGETS = {
  search: {
    budgetKey: 'gatherSearches',
    message: (maximum: number) => `gather may contain at most ${maximum} searches.`,
    option: 'search',
  },
  show: {
    budgetKey: 'gatherShows',
    message: (maximum: number) => `gather may contain at most ${maximum} shows.`,
    option: 'show',
  },
  supersedes: {
    budgetKey: 'supersessionEdges',
    message: (maximum: number) => `--supersedes may be supplied at most ${maximum} times.`,
    option: 'supersedes',
  },
} as const satisfies Record<string, RepeatedOptionBudget>

const invalid = (message: string, details: Record<string, JsonValue> = {}): never =>
  fail('INVALID_ARGUMENT', message, details)

const rawOptionCount = (arguments_: readonly string[], option: string) =>
  arguments_.reduce(
    (state, argument) => {
      if (!state.terminated) {
        if (argument === '--') {
          return { ...state, terminated: true }
        }
        if (argument === `--${option}` || argument.startsWith(`--${option}=`)) {
          return { ...state, count: state.count + 1 }
        }
      }
      return state
    },
    { count: 0, terminated: false },
  ).count

const preflightRepeatedOptionBudget = (arguments_: readonly string[], specification: RepeatedOptionBudget) => {
  const budget = OPERATION_BUDGETS[specification.budgetKey]
  if (rawOptionCount(arguments_, specification.option) > budget.maximum) {
    return failBudget(specification.budgetKey, specification.message(budget.maximum))
  }
}

const extractRoot = (arguments_: string[]) => {
  const roots: string[] = []
  const remaining: string[] = []
  let terminated = false
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index] ?? ''
    if (argument === '--') {
      terminated = true
      remaining.push(argument)
    } else if (!terminated && argument === '--root') {
      const value = arguments_[index + 1]
      const requiredValue = value === undefined || value.startsWith('--') ? invalid('--root requires a path.') : value
      roots.push(requiredValue)
      index += 1
    } else if (!terminated && argument.startsWith('--root=')) {
      roots.push(argument.slice('--root='.length))
    } else {
      remaining.push(argument)
    }
  }
  if (roots.length > 1 || roots[0] === '') {
    invalid('--root may be supplied exactly once with a non-empty path.')
  }
  return { remaining, root: roots[0] }
}

const parseOptions = (
  arguments_: string[],
  configuration: {
    values?: string[]
    repeated?: string[]
    flags?: string[]
  } = {},
): ParsedOptions => {
  const valueOptions = new Set([...(configuration.values ?? []), ...(configuration.repeated ?? [])])
  const repeatedOptions = new Set(configuration.repeated ?? [])
  const flagOptions = new Set(configuration.flags ?? [])
  const options = Object.fromEntries([
    ...[...valueOptions].map(name => [name, { multiple: repeatedOptions.has(name), type: 'string' }] as const),
    ...[...flagOptions].map(name => [name, { type: 'boolean' }] as const),
  ])

  let parsed: ReturnType<typeof parseArgs>
  try {
    parsed = parseArgs({
      allowPositionals: true,
      args: arguments_,
      options,
      strict: true,
      tokens: true,
    })
  } catch (error) {
    const candidate = error as { code?: unknown; message?: unknown }
    const message = typeof candidate.message === 'string' ? candidate.message : ''
    const option = (/option '([^']+)'/i.exec(message)?.[1] ?? 'option').split(' ')[0] ?? 'option'
    if (candidate.code === 'ERR_PARSE_ARGS_UNKNOWN_OPTION') {
      invalid(`Unknown option ${option}.`)
    }
    if (candidate.code === 'ERR_PARSE_ARGS_INVALID_OPTION_VALUE') {
      invalid(
        message.includes('does not take an argument')
          ? `${option} does not take a value.`
          : `${option} requires a value.`,
      )
    }
    throw error
  }

  const seen = new Map<string, number>()
  for (const token of parsed.tokens ?? []) {
    if (token.kind === 'option') {
      seen.set(token.name, (seen.get(token.name) ?? 0) + 1)
    }
  }
  for (const [name, count] of seen.entries()) {
    if (!repeatedOptions.has(name) && count > 1) {
      invalid(`--${name} may be supplied only once.`)
    }
  }

  const result: ParsedOptions = {
    flags: new Set(),
    positionals: parsed.positionals,
    values: new Map(),
  }
  for (const name of flagOptions) {
    if (parsed.values[name] === true) {
      result.flags.add(name)
    }
  }
  for (const name of valueOptions) {
    const raw = parsed.values[name]
    if (raw !== undefined) {
      const values = (Array.isArray(raw) ? raw : [raw]).filter((value): value is string => typeof value === 'string')
      const rawCount = Array.isArray(raw) ? raw.length : 1
      if (values.length !== rawCount || values.some(value => value.length === 0)) {
        invalid(`--${name} requires a value.`)
      }
      result.values.set(name, values)
    }
  }
  return result
}

const one = (options: ParsedOptions, name: string) => options.values.get(name)?.[0]
const many = (options: ParsedOptions, name: string) => options.values.get(name) ?? []

const requiredOption = (value: string | undefined, message: string) => value ?? invalid(message)

const noPositionals = (options: ParsedOptions) => {
  if (options.positionals.length > 0) {
    invalid('This command does not accept positional arguments.')
  }
}

type ResultLimitBudgetName = 'compactResultLimit' | 'fullResultLimit'

const parseLimit = (value: string | undefined, budgetName: ResultLimitBudgetName) => {
  if (value === undefined) {
    return
  }
  const budget = OPERATION_BUDGETS[budgetName]
  const parsed = Number(value)
  if (Number.isInteger(parsed) && parsed >= budget.minimum && parsed <= budget.maximum) {
    return parsed
  }
  return failBudget(budgetName, `--limit must be an integer between ${budget.minimum} and ${budget.maximum}.`)
}

const parsePayload = (value: string) => {
  try {
    return JSON.parse(value) as JsonValue
  } catch {
    return invalid('--data must contain valid JSON.')
  }
}

const rootInput = (root: string | undefined): { root?: string } => (root === undefined ? {} : { root })

const dispatch = (arguments_: string[]): CommandResult => {
  if (arguments_.length === 1 && (arguments_[0] === '--help' || arguments_[0] === '-h')) {
    return { format: 'text', value: HELP }
  }
  if (arguments_.length === 1 && (arguments_[0] === '--version' || arguments_[0] === '-v')) {
    return { format: 'text', value: `${PACKAGE_VERSION}\n` }
  }
  const extracted = extractRoot(arguments_)
  if (extracted.remaining.length === 1 && (extracted.remaining[0] === '--help' || extracted.remaining[0] === '-h')) {
    return { format: 'text', value: HELP }
  }
  if (extracted.remaining.length === 1 && (extracted.remaining[0] === '--version' || extracted.remaining[0] === '-v')) {
    return { format: 'text', value: `${PACKAGE_VERSION}\n` }
  }
  const [command, ...commandArguments] = extracted.remaining
  if (command === undefined) {
    invalid('A command is required. Use --help for usage.')
  }
  const root = rootInput(extracted.root)

  switch (command) {
    case 'init': {
      const options = parseOptions(commandArguments, {
        flags: ['refresh-baseline', 'remove'],
      })
      noPositionals(options)
      return {
        value: initEncephalon({
          ...root,
          refreshBaseline: options.flags.has('refresh-baseline'),
          remove: options.flags.has('remove'),
        }),
      }
    }
    case 'add': {
      preflightRepeatedOptionBudget(commandArguments, REPEATED_OPTION_BUDGETS.supersedes)
      const options = parseOptions(commandArguments, {
        repeated: ['supersedes', 'artifact'],
        values: ['id', 'kind', 'subject', 'source', 'data', 'text', 'confidence'],
      })
      noPositionals(options)
      const supersedes = many(options, 'supersedes')
      const kind = one(options, 'kind')
      const subject = one(options, 'subject')
      const source = one(options, 'source')
      const data = one(options, 'data')
      if (kind === undefined || subject === undefined || source === undefined || data === undefined) {
        invalid('add requires --kind, --subject, --source, and --data.')
      }
      const requiredKind = requiredOption(kind, 'add requires --kind, --subject, --source, and --data.')
      const requiredSubject = requiredOption(subject, 'add requires --kind, --subject, --source, and --data.')
      const requiredSource = requiredOption(source, 'add requires --kind, --subject, --source, and --data.')
      const requiredData = requiredOption(data, 'add requires --kind, --subject, --source, and --data.')
      const confidenceValue = one(options, 'confidence')
      const confidence = confidenceValue === undefined ? undefined : Number(confidenceValue)
      const id = one(options, 'id')
      const searchText = one(options, 'text')
      return {
        value: addRecord({
          ...root,
          ...(id === undefined ? {} : { id }),
          kind: requiredKind,
          source: requiredSource,
          subject: requiredSubject,
          ...(confidence === undefined ? {} : { confidence }),
          ...(supersedes.length === 0 ? {} : { supersedes }),
          ...(many(options, 'artifact').length === 0 ? {} : { artifacts: many(options, 'artifact') }),
          payload: parsePayload(requiredData),
          ...(searchText === undefined ? {} : { searchText }),
        }),
      }
    }
    case 'prepare': {
      const options = parseOptions(commandArguments)
      noPositionals(options)
      return { value: prepare(root) }
    }
    case 'hydrate': {
      const options = parseOptions(commandArguments)
      noPositionals(options)
      return { value: hydrate(root) }
    }
    case 'validate': {
      const options = parseOptions(commandArguments)
      noPositionals(options)
      const value = validateRecords(root)
      return { value, ...(value.valid ? {} : { exitCode: 2 }) }
    }
    case 'list': {
      const options = parseOptions(commandArguments, {
        flags: ['include-superseded'],
        values: ['kind', 'subject', 'limit'],
      })
      noPositionals(options)
      const kind = one(options, 'kind')
      const subject = one(options, 'subject')
      const limit = parseLimit(one(options, 'limit'), 'fullResultLimit')
      return {
        value: listRecords({
          ...root,
          ...(kind === undefined ? {} : { kind }),
          ...(subject === undefined ? {} : { subject }),
          includeSuperseded: options.flags.has('include-superseded'),
          ...(limit === undefined ? {} : { limit }),
        }),
      }
    }
    case 'show': {
      const options = parseOptions(commandArguments, {
        flags: ['active-only'],
        values: ['id'],
      })
      const id = one(options, 'id') ?? options.positionals[0]
      if (id === undefined || options.positionals.length > (one(options, 'id') === undefined ? 1 : 0)) {
        invalid('show requires exactly one record id.')
      }
      return {
        value: showRecord({
          ...root,
          activeOnly: options.flags.has('active-only'),
          id: requiredOption(id, 'show requires exactly one record id.'),
        }),
      }
    }
    case 'search': {
      const options = parseOptions(commandArguments, {
        flags: ['compact', 'include-superseded'],
        values: ['kind', 'limit'],
      })
      const query = options.positionals.join(' ')
      if (query.length === 0) {
        invalid('search requires a query.')
      }
      const kind = one(options, 'kind')
      const compact = options.flags.has('compact')
      const limit = parseLimit(one(options, 'limit'), compact ? 'compactResultLimit' : 'fullResultLimit')
      const input = {
        ...root,
        query,
        ...(kind === undefined ? {} : { kind }),
        includeSuperseded: options.flags.has('include-superseded'),
        ...(limit === undefined ? {} : { limit }),
      }
      return {
        value: compact ? searchCompactRecords(input) : searchRecords(input),
      }
    }
    case 'gather': {
      preflightRepeatedOptionBudget(commandArguments, REPEATED_OPTION_BUDGETS.search)
      preflightRepeatedOptionBudget(commandArguments, REPEATED_OPTION_BUDGETS.show)
      const options = parseOptions(commandArguments, {
        flags: ['hydrate', 'include-superseded'],
        repeated: ['search', 'show'],
        values: ['kind', 'limit'],
      })
      noPositionals(options)
      const searches = many(options, 'search')
      const shows = many(options, 'show')
      const kind = one(options, 'kind')
      const limit = parseLimit(one(options, 'limit'), 'compactResultLimit')
      return {
        value: gatherRecords({
          ...root,
          searches,
          shows,
          ...(kind === undefined ? {} : { kind }),
          ...(limit === undefined ? {} : { limit }),
          hydrate: options.flags.has('hydrate'),
          includeSuperseded: options.flags.has('include-superseded'),
        }),
      }
    }
    default:
      return invalid(`Unknown command ${command}. Use --help for usage.`)
  }
}

const writeJson = (stream: NodeJS.WriteStream, value: unknown) => {
  stream.write(`${JSON.stringify(value)}\n`)
}

export const runCli = (arguments_: string[] = process.argv.slice(2)) => {
  try {
    const result = dispatch(arguments_)
    if (result.format === 'text' && typeof result.value === 'string') {
      process.stdout.write(result.value)
    } else {
      writeJson(process.stdout, result.value)
    }
    return result.exitCode ?? 0
  } catch (error) {
    if (error instanceof EncephalonError) {
      const response = cliErrorResponse(error)
      writeJson(process.stderr, response.body)
      return response.exitCode
    }
    writeJson(process.stderr, {
      error: {
        code: 'INTERNAL_ERROR',
        details: {},
        message: 'An unexpected internal error occurred.',
      },
    })
    return 1
  }
}

process.exitCode = runCli()
