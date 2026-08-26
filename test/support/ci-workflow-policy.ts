const githubIdentifierCharacter = /[A-Za-z0-9_-]/u

const expressionContainsSecretsContext = (expression: string) => {
  let cursor = 0
  let quote: "'" | '"' | undefined
  let found = false

  while (cursor < expression.length && !found) {
    const character = expression[cursor]
    const nextCharacter = expression[cursor + 1]
    if (quote !== undefined) {
      if (character === '\\') {
        cursor += 2
      } else if (character === quote && nextCharacter === quote) {
        cursor += 2
      } else {
        if (character === quote) {
          quote = undefined
        }
        cursor += 1
      }
    } else if (character === "'" || character === '"') {
      quote = character
      cursor += 1
    } else {
      const previousCharacter = expression[cursor - 1]
      const afterToken = expression[cursor + 'secrets'.length]
      const isSecretsToken = expression.slice(cursor, cursor + 'secrets'.length).toLowerCase() === 'secrets'
      if (
        isSecretsToken &&
        previousCharacter !== '.' &&
        !githubIdentifierCharacter.test(previousCharacter ?? '') &&
        !githubIdentifierCharacter.test(afterToken ?? '')
      ) {
        found = true
      }
      cursor += 1
    }
  }

  return found
}

const extractGithubExpressions = (source: string) => {
  const expressions: string[] = []
  let searchStart = 0

  while (searchStart < source.length) {
    const expressionStart = source.indexOf('${{', searchStart)
    if (expressionStart < 0) {
      searchStart = source.length
    } else {
      let cursor = expressionStart + 3
      let expressionEnd = -1
      let quote: "'" | '"' | undefined
      while (cursor < source.length && expressionEnd < 0) {
        const character = source[cursor]
        const nextCharacter = source[cursor + 1]
        if (quote !== undefined) {
          if (character === '\\') {
            cursor += 2
          } else if (character === quote && nextCharacter === quote) {
            cursor += 2
          } else {
            if (character === quote) {
              quote = undefined
            }
            cursor += 1
          }
        } else if (character === "'" || character === '"') {
          quote = character
          cursor += 1
        } else if (character === '}' && nextCharacter === '}') {
          expressionEnd = cursor
        } else {
          cursor += 1
        }
      }

      if (expressionEnd < 0) {
        throw new Error('Unterminated GitHub Actions expression.')
      }
      expressions.push(source.slice(expressionStart + 3, expressionEnd))
      searchStart = expressionEnd + 2
    }
  }

  return expressions
}

const stripYamlScalarQuotes = (source: string) => {
  const trimmed = source.trim()
  const [firstCharacter] = trimmed
  const lastCharacter = trimmed.at(-1)
  return (firstCharacter === "'" && lastCharacter === "'") || (firstCharacter === '"' && lastCharacter === '"')
    ? trimmed.slice(1, -1)
    : trimmed
}

const stripYamlComment = (line: string) => {
  let commentStart = line.length
  let cursor = 0
  let quote: "'" | '"' | undefined

  while (cursor < line.length && commentStart === line.length) {
    const character = line[cursor]
    const nextCharacter = line[cursor + 1]
    if (quote === '"' && character === '\\') {
      cursor += 2
    } else if (quote === "'" && character === "'" && nextCharacter === "'") {
      cursor += 2
    } else if (quote !== undefined) {
      if (character === quote) {
        quote = undefined
      }
      cursor += 1
    } else if (character === "'" || character === '"') {
      quote = character
      cursor += 1
    } else if (character === '#' && (cursor === 0 || /\s/u.test(line[cursor - 1] ?? ''))) {
      commentStart = cursor
    } else {
      cursor += 1
    }
  }

  return line.slice(0, commentStart).trimEnd()
}

const partitionWorkflowSource = (source: string) => {
  const state = source.split('\n').reduce(
    (result, line) => {
      const trimmedLine = line.trimStart()
      const indentation = line.length - trimmedLine.length
      const continuesBlockScalar =
        result.blockScalarIndent !== undefined && (trimmedLine.length === 0 || indentation > result.blockScalarIndent)
      if (result.blockScalarIndent !== undefined && !continuesBlockScalar) {
        result.blockScalarIndent = undefined
      }

      const evaluableLine = continuesBlockScalar ? line : stripYamlComment(line)
      result.evaluableLines.push(evaluableLine)
      result.structuralLines.push(continuesBlockScalar ? '' : evaluableLine)
      if (result.blockScalarIndent === undefined && /:\s*[>|][+-]?[1-9]?[+-]?\s*$/u.test(evaluableLine)) {
        result.blockScalarIndent = indentation
      }
      return result
    },
    {
      blockScalarIndent: undefined as number | undefined,
      evaluableLines: [] as string[],
      structuralLines: [] as string[],
    },
  )
  return {
    evaluableSource: state.evaluableLines.join('\n'),
    structuralSource: state.structuralLines.join('\n'),
  }
}

const extractImplicitConditions = (source: string) => {
  const state = source.split('\n').reduce(
    (result, line) => {
      const trimmedLine = line.trimStart()
      const indentation = line.length - trimmedLine.length
      if (trimmedLine.length === 0) {
        return result
      }
      if (result.active !== undefined && indentation > result.active.keyIndentation) {
        return {
          ...result,
          active: {
            ...result.active,
            expression: `${result.active.expression} ${trimmedLine}`,
          },
        }
      }

      const expressions =
        result.active === undefined
          ? result.expressions
          : [...result.expressions, stripYamlScalarQuotes(result.active.expression)]
      const match = trimmedLine.match(/^(?<listPrefix>-\s+)?(?:"if"|'if'|if)\s*:\s*(?<expression>.*)$/u)
      return {
        active:
          match === null
            ? undefined
            : {
                expression: match.groups?.expression ?? '',
                keyIndentation: indentation + (match.groups?.listPrefix?.length ?? 0),
              },
        expressions,
      }
    },
    {
      active: undefined as { expression: string; keyIndentation: number } | undefined,
      expressions: [] as string[],
    },
  )
  return state.active === undefined
    ? state.expressions
    : [...state.expressions, stripYamlScalarQuotes(state.active.expression)]
}

export const workflowContainsSecretsContext = (workflow: string) => {
  const { evaluableSource, structuralSource } = partitionWorkflowSource(workflow)
  const encodedYamlScalar = /\\(?:U[\dA-Fa-f]{8}|u[\dA-Fa-f]{4}|x[\dA-Fa-f]{2})|\\\s*$/mu
  // Resolving anchors or flow mappings safely would require the excluded YAML parser, so ambiguous forms fail closed.
  const yamlAnchorOrAlias = /(?:^|\s|:|,|\{|\[|\?)[&*][^\s&*,[\]{}]+/mu
  const flowStyleCondition = /[,{]\s*["']?if["']?\s*:/u
  const implicitConditions = extractImplicitConditions(structuralSource)
  return (
    encodedYamlScalar.test(structuralSource) ||
    yamlAnchorOrAlias.test(structuralSource) ||
    flowStyleCondition.test(structuralSource) ||
    extractGithubExpressions(evaluableSource).some(expressionContainsSecretsContext) ||
    implicitConditions.some(expression => /^[>|]/u.test(expression) || expressionContainsSecretsContext(expression))
  )
}
