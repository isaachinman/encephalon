#!/usr/bin/env node

import {
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
} from "./index.ts"
import { fail } from "./errors.ts"
import type { JsonValue } from "./types.ts"

const VERSION = "0.1.0"
const HELP = `Usage: encephalon [--root <path>] <command> [options]

Commands:
  init [--refresh-baseline | --remove]
  add --kind <kind> --subject <subject> --source <source> --data <json>
  prepare
  hydrate
  validate
  list [--kind <kind>] [--subject <subject>] [--include-superseded]
  show --id <id> [--active-only]
  search <query> [--compact] [--kind <kind>] [--include-superseded]
  gather [--search <query> ...] [--show <id> ...] [--hydrate]

Global options:
  --root <path>   Use this exact Git repository root.
  --help          Show help.
  --version       Show the package version.
`

type ParsedOptions = {
  values: Map<string, string[]>
  flags: Set<string>
  positionals: string[]
}

type CommandResult = {
  value: unknown
  exitCode?: number
}

const invalid = (message: string, details: Record<string, JsonValue> = {}): never =>
  fail("INVALID_ARGUMENT", message, details)

const extractRoot = (arguments_: string[]) => {
  const roots: string[] = []
  const remaining: string[] = []
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index] ?? ""
    if (argument === "--root") {
      const value = arguments_[index + 1]
      const requiredValue = value === undefined || value.startsWith("--")
        ? invalid("--root requires a path.")
        : value
      roots.push(requiredValue)
      index += 1
    } else if (argument.startsWith("--root=")) {
      roots.push(argument.slice("--root=".length))
    } else {
      remaining.push(argument)
    }
  }
  if (roots.length > 1 || roots[0] === "") invalid("--root may be supplied exactly once with a non-empty path.")
  return { root: roots[0], remaining }
}

const parseOptions = (
  arguments_: string[],
  configuration: { values?: string[]; repeated?: string[]; flags?: string[] } = {},
): ParsedOptions => {
  const valueOptions = new Set([...(configuration.values ?? []), ...(configuration.repeated ?? [])])
  const repeatedOptions = new Set(configuration.repeated ?? [])
  const flagOptions = new Set(configuration.flags ?? [])
  const parsed: ParsedOptions = { values: new Map(), flags: new Set(), positionals: [] }

  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index] ?? ""
    if (argument.startsWith("--")) {
      const equals = argument.indexOf("=")
      const name = equals === -1 ? argument.slice(2) : argument.slice(2, equals)
      if (flagOptions.has(name)) {
        if (equals !== -1 || parsed.flags.has(name)) invalid(`--${name} does not take a value and may be supplied once.`)
        parsed.flags.add(name)
      } else if (valueOptions.has(name)) {
        const value = equals === -1 ? arguments_[index + 1] : argument.slice(equals + 1)
        const requiredValue = value === undefined || value.length === 0 || (equals === -1 && value.startsWith("--"))
          ? invalid(`--${name} requires a value.`)
          : value
        if (equals === -1) index += 1
        const existing = parsed.values.get(name) ?? []
        if (!repeatedOptions.has(name) && existing.length > 0) invalid(`--${name} may be supplied only once.`)
        parsed.values.set(name, [...existing, requiredValue])
      } else {
        invalid(`Unknown option --${name}.`)
      }
    } else {
      parsed.positionals.push(argument)
    }
  }
  return parsed
}

const one = (options: ParsedOptions, name: string) => options.values.get(name)?.[0]
const many = (options: ParsedOptions, name: string) => options.values.get(name) ?? []

const requiredOption = (value: string | undefined, message: string) => value ?? invalid(message)

const noPositionals = (options: ParsedOptions) => {
  if (options.positionals.length > 0) invalid("This command does not accept positional arguments.")
}

const parseLimit = (value: string | undefined) => {
  if (value === undefined) return undefined
  const parsed = Number(value)
  if (Number.isInteger(parsed) && parsed > 0 && parsed <= 1000) return parsed
  return invalid("--limit must be an integer between 1 and 1000.")
}

const parsePayload = (value: string) => {
  try {
    return JSON.parse(value) as JsonValue
  } catch {
    return invalid("--data must contain valid JSON.")
  }
}

const rootInput = (root: string | undefined): { root?: string } => root === undefined ? {} : { root }

const dispatch = (arguments_: string[]): CommandResult => {
  if (arguments_.includes("--help") || arguments_.includes("-h")) return { value: HELP }
  if (arguments_.includes("--version") || arguments_.includes("-v")) return { value: `${VERSION}\n` }
  const extracted = extractRoot(arguments_)
  const [command, ...commandArguments] = extracted.remaining
  if (command === undefined) invalid("A command is required. Use --help for usage.")
  const root = rootInput(extracted.root)

  switch (command) {
    case "init": {
      const options = parseOptions(commandArguments, { flags: ["refresh-baseline", "remove"] })
      noPositionals(options)
      return { value: initEncephalon({ ...root, refreshBaseline: options.flags.has("refresh-baseline"), remove: options.flags.has("remove") }) }
    }
    case "add": {
      const options = parseOptions(commandArguments, {
        values: ["id", "kind", "subject", "source", "data", "text", "confidence"],
        repeated: ["supersedes", "artifact"],
      })
      noPositionals(options)
      const kind = one(options, "kind")
      const subject = one(options, "subject")
      const source = one(options, "source")
      const data = one(options, "data")
      if (kind === undefined || subject === undefined || source === undefined || data === undefined) {
        invalid("add requires --kind, --subject, --source, and --data.")
      }
      const requiredKind = requiredOption(kind, "add requires --kind, --subject, --source, and --data.")
      const requiredSubject = requiredOption(subject, "add requires --kind, --subject, --source, and --data.")
      const requiredSource = requiredOption(source, "add requires --kind, --subject, --source, and --data.")
      const requiredData = requiredOption(data, "add requires --kind, --subject, --source, and --data.")
      const confidenceValue = one(options, "confidence")
      const confidence = confidenceValue === undefined ? undefined : Number(confidenceValue)
      const id = one(options, "id")
      const searchText = one(options, "text")
      return {
        value: addRecord({
          ...root,
          ...(id === undefined ? {} : { id }),
          kind: requiredKind,
          subject: requiredSubject,
          source: requiredSource,
          ...(confidence === undefined ? {} : { confidence }),
          ...(many(options, "supersedes").length === 0 ? {} : { supersedes: many(options, "supersedes") }),
          ...(many(options, "artifact").length === 0 ? {} : { artifacts: many(options, "artifact") }),
          payload: parsePayload(requiredData),
          ...(searchText === undefined ? {} : { searchText }),
        }),
      }
    }
    case "prepare": {
      const options = parseOptions(commandArguments)
      noPositionals(options)
      return { value: prepare(root) }
    }
    case "hydrate": {
      const options = parseOptions(commandArguments)
      noPositionals(options)
      return { value: hydrate(root) }
    }
    case "validate": {
      const options = parseOptions(commandArguments)
      noPositionals(options)
      const value = validateRecords(root)
      return { value, ...(value.valid ? {} : { exitCode: 2 }) }
    }
    case "list": {
      const options = parseOptions(commandArguments, { values: ["kind", "subject", "limit"], flags: ["include-superseded"] })
      noPositionals(options)
      const kind = one(options, "kind")
      const subject = one(options, "subject")
      const limit = parseLimit(one(options, "limit"))
      return { value: listRecords({ ...root, ...(kind === undefined ? {} : { kind }), ...(subject === undefined ? {} : { subject }), includeSuperseded: options.flags.has("include-superseded"), ...(limit === undefined ? {} : { limit }) }) }
    }
    case "show": {
      const options = parseOptions(commandArguments, { values: ["id"], flags: ["active-only"] })
      const id = one(options, "id") ?? options.positionals[0]
      if (id === undefined || options.positionals.length > (one(options, "id") === undefined ? 1 : 0)) invalid("show requires exactly one record id.")
      return { value: showRecord({ ...root, id: requiredOption(id, "show requires exactly one record id."), activeOnly: options.flags.has("active-only") }) }
    }
    case "search": {
      const options = parseOptions(commandArguments, { values: ["kind", "limit"], flags: ["compact", "include-superseded"] })
      const query = options.positionals.join(" ")
      if (query.length === 0) invalid("search requires a query.")
      const kind = one(options, "kind")
      const limit = parseLimit(one(options, "limit"))
      const input = { ...root, query, ...(kind === undefined ? {} : { kind }), includeSuperseded: options.flags.has("include-superseded"), ...(limit === undefined ? {} : { limit }) }
      return { value: options.flags.has("compact") ? searchCompactRecords(input) : searchRecords(input) }
    }
    case "gather": {
      const options = parseOptions(commandArguments, { values: ["kind", "limit"], repeated: ["search", "show"], flags: ["hydrate", "include-superseded"] })
      noPositionals(options)
      const kind = one(options, "kind")
      const limit = parseLimit(one(options, "limit"))
      return { value: gatherRecords({ ...root, searches: many(options, "search"), shows: many(options, "show"), ...(kind === undefined ? {} : { kind }), ...(limit === undefined ? {} : { limit }), hydrate: options.flags.has("hydrate"), includeSuperseded: options.flags.has("include-superseded") }) }
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
    if (typeof result.value === "string" && (arguments_.includes("--help") || arguments_.includes("-h") || arguments_.includes("--version") || arguments_.includes("-v"))) {
      process.stdout.write(result.value)
    } else {
      writeJson(process.stdout, result.value)
    }
    return result.exitCode ?? 0
  } catch (error) {
    if (error instanceof EncephalonError) {
      writeJson(process.stderr, { error: { code: error.code, message: error.message, details: error.details } })
      return 2
    }
    writeJson(process.stderr, { error: { code: "INTERNAL_ERROR", message: "An unexpected internal error occurred.", details: {} } })
    return 1
  }
}

process.exitCode = runCli()
